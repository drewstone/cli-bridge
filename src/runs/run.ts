/**
 * One durable server-owned backend job.
 *
 * The run owns its identity, its abort controller, its terminal outcome, and
 * the policy for every state transition. Five collaborators own the
 * mechanisms: a bounded replay log, the two protocol faces that write into it
 * (OpenAI deltas and canonical runtime events), a serialized native-control
 * lane for the retained provider child, and a ledger of outstanding dialogs.
 */

import type { ChatDelta, NativeSession, ProfileMaterializationReceipt } from '../backends/types.js'
import type { RuntimeEventEnvelope } from '@tangle-network/agent-interface'
import { CanonicalRunStream } from './canonical-stream.js'
import { DeltaRunStream } from './delta-stream.js'
import { RunInteractionCancelledError, RunLifetimeExceededError } from './errors.js'
import { describeRunFailure } from './error-shape.js'
import { RunInteractionLedger } from './interactions.js'
import { NativeRunControl } from './native-control.js'
import { RunReplayLog } from './replay-log.js'
import type {
  CanonicalEventInput,
  CanonicalEventListener,
  PendingRunInteraction,
  RunClaimOptions,
  RunOwner,
  RunRetention,
  RunSnapshot,
  RunState,
  RunStatus,
  SeqCanonicalEvent,
  SeqDelta,
} from './types.js'

export class Run {
  readonly startedAt = Date.now()
  private status: RunStatus = 'running'
  private endedAt: number | null = null
  private cancelRequestedAt: number | null = null
  private disposed = false
  private disposalPromise: Promise<void> | null = null
  private nativeCancellationRequest: Promise<boolean> | null = null
  private readonly log: RunReplayLog
  private readonly canonical: CanonicalRunStream
  private readonly deltas: DeltaRunStream
  private readonly native: NativeRunControl
  private readonly interactions = new RunInteractionLedger()
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null

  /** Aborts the owned backend job. A socket signal never reaches this controller. */
  private readonly ac = new AbortController()
  /** The one pump promise; its presence prevents duplicate backend consumption. */
  private settled?: Promise<void>
  /** Typed failure raised before the backend produced any output. */
  private setupError: unknown
  /**
   * The failure that ended this run, whenever it happened. Separate from
   * `setupError` because only a PRE-OUTPUT failure can replace the whole
   * response with an HTTP error; a failure after output still has to reach the
   * caller, and recording it only when `seq === 0` is what turned a mid-stream
   * auth failure into a 200 with an empty completion and no reason.
   */
  private failureError: unknown

  constructor(
    readonly id: string,
    readonly requestDigest: string,
    onForget: (id: string, run: Run) => void,
    private readonly retention: RunRetention,
    readonly owner: RunOwner = 'one-shot',
    readonly sessionId?: string,
    readonly executionId?: string,
    readonly provider?: string,
    readonly environmentId?: string,
    private readonly commitDelta?: RunClaimOptions['commitDelta'],
    private readonly commitSnapshot?: RunClaimOptions['commitSnapshot'],
    private readonly commitCanonicalEvent?: RunClaimOptions['commitCanonicalEvent'],
    private readonly onNativeControlLost?: RunClaimOptions['onNativeControlLost'],
  ) {
    this.log = new RunReplayLog({
      runId: id,
      retention,
      isClosed: () => this.isTerminal() || this.disposed,
      onIdentityExpired: () => onForget(id, this),
      ...(commitSnapshot ? { onDeltaCommitted: () => this.persistSnapshot(false) } : {}),
      ...(commitDelta ? { commitDelta } : {}),
      ...(commitCanonicalEvent ? { commitCanonicalEvent } : {}),
      onCommitFailure: (error) => this.canonical.markDurabilityUnknown(error),
    })
    this.canonical = new CanonicalRunStream(this.log, {
      signal: this.ac.signal,
      commitsDurably: Boolean(commitCanonicalEvent),
      cancelOutstandingInteractions: (reason) => this.cancelOutstandingInteractions(reason),
      recordFailure: (error) => {
        this.failureError ??= error
      },
      setFailure: (error) => {
        this.failureError = error
      },
      finish: (status) => this.finish(status),
    })
    this.deltas = new DeltaRunStream(this.log, {
      runId: id,
      signal: this.ac.signal,
      recordFailure: (error) => {
        this.failureError ??= error
      },
      setFailure: (error) => {
        this.failureError = error
      },
      setSetupError: (error) => {
        this.setupError = error
      },
      markDurabilityUnknown: (error) => {
        this.canonical.markDurabilityUnknown(error)
      },
      finish: (status) => this.finish(status),
    })
    this.native = new NativeRunControl({
      runId: id,
      isDisposed: () => this.disposed,
      shouldReportLoss: () => !this.disposed && !this.isCancelling(),
      reportLoss: (reason) =>
        this.onNativeControlLost?.({
          runId: this.id,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          reason,
        }),
    })
    if (retention.maxLifetimeMs > 0) {
      this.lifetimeTimer = setTimeout(() => this.expireLifetime(), retention.maxLifetimeMs)
      this.lifetimeTimer.unref?.()
    }
  }

  /** The backend consumes this signal; only `cancel()` aborts it. */
  get signal(): AbortSignal {
    return this.ac.signal
  }

  snapshot(): RunSnapshot {
    return {
      id: this.id,
      requestDigest: this.requestDigest,
      status: this.status,
      state: this.state(),
      terminal: this.isTerminal(),
      attachedReaders: this.log.readers(),
      cancelRequestedAt: this.cancelRequestedAt,
      lastSeq: this.log.lastSeq(),
      replay: this.log.replayWindow(),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      identityExpiresAt: this.log.identityExpiry(),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.environmentId ? { environmentId: this.environmentId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.executionId ? { executionId: this.executionId } : {}),
      canonicalLastSeq: this.log.canonicalLastSeq(),
      lifetimeExpiresAt: this.isTerminal() || this.retention.maxLifetimeMs === 0
        ? null
        : this.startedAt + this.retention.maxLifetimeMs,
      profileMaterialization: this.log.profileReceipt() as ProfileMaterializationReceipt | null,
    }
  }

  setNativeControl(control: NativeSession): void {
    this.native.set(control)
  }

  nativeSession(): NativeSession | null {
    return this.native.live()
  }

  /** Keep disposal pending while an asynchronous start or handoff may return a child. */
  reserveNativeControlAttachment(): () => void {
    return this.native.reserveAttachment()
  }

  /**
   * Transfer a retained provider session to the next native run without
   * letting the completed run close it when its replay window expires.
   */
  takeNativeControl(control: NativeSession): Promise<boolean> {
    return this.native.lane(async () => {
      if (this.status !== 'done' || this.isCancelling()) return false
      return this.native.releaseForHandoff(control)
    })
  }

  /** Inspect retained provider state while close and handoff are excluded. */
  inspectNativeControl(control: NativeSession, operation: (native: NativeSession) => Promise<void>): Promise<boolean> {
    return this.native.inspect(control, operation)
  }

  /** Close one retained native session without surrendering retry ownership. */
  closeNativeControl(control: NativeSession): Promise<boolean> {
    return this.native.close(control)
  }

  registerInteraction(interaction: PendingRunInteraction): void {
    this.interactions.register(interaction)
  }

  interaction(id: string): PendingRunInteraction | null {
    return this.interactions.get(id)
  }

  /** Claim one interaction so distinct operation ids cannot answer it twice. */
  claimInteraction(id: string): PendingRunInteraction | null {
    if (this.isTerminal()) return null
    return this.interactions.claim(id)
  }

  releaseInteractionClaim(id: string): void {
    this.interactions.releaseClaim(id)
  }

  interactionIsResolving(id: string): boolean {
    return this.interactions.isResolving(id)
  }

  resolveInteraction(id: string, responseDigest?: string): void {
    this.interactions.resolve(id, responseDigest)
  }

  interactionWasResolved(id: string): boolean {
    return this.interactions.wasResolved(id)
  }

  resolvedInteractionDigest(id: string): string | null {
    return this.interactions.resolvedDigest(id)
  }

  interactionWasCancelled(id: string): boolean {
    return this.interactions.wasCancelled(id)
  }

  markInteractionEffectUnknown(id: string): void {
    this.interactions.markEffectUnknown(id)
  }

  interactionWasEffectUnknown(id: string): boolean {
    return this.interactions.wasEffectUnknown(id)
  }

  appendCanonical(input: CanonicalEventInput): RuntimeEventEnvelope {
    return this.canonical.append(input)
  }

  subscribeCanonical(listener: CanonicalEventListener): () => void {
    return this.canonical.subscribe(listener)
  }

  assertCanonicalReplayCursor(afterSeq: number): void {
    this.canonical.assertCursor(afterSeq)
  }

  async *attachCanonical(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqCanonicalEvent> {
    yield* this.canonical.attach(afterSeq, readerSignal)
  }

  /** Consume one canonical event source to a terminal status, exactly once. */
  pumpCanonical(source: AsyncIterable<CanonicalEventInput>): Promise<void> {
    if (this.settled) return this.settled
    this.settled = this.canonical.pump(source)
    return this.settled
  }

  failCanonicalSetup(error: unknown): void {
    if (this.settled || this.isTerminal()) return
    this.canonical.failSetup(error)
    this.settled = Promise.resolve()
  }

  /** Consume one delta source to a terminal status, exactly once. */
  pump(
    source: AsyncIterable<ChatDelta>,
    options: { terminalReceipt?: () => ProfileMaterializationReceipt | undefined } = {},
  ): Promise<void> {
    if (this.settled) return this.settled
    this.settled = this.deltas.pump(source, options)
    return this.settled
  }

  /** Commit a claimed run whose admission/backend setup failed before `pump()`. */
  failSetup(error: unknown): void {
    if (this.settled || this.isTerminal()) return
    this.deltas.failSetup(error)
    this.settled = Promise.resolve()
  }

  isCancelling(): boolean {
    return this.cancelRequestedAt !== null || this.ac.signal.aborted || this.disposed
  }

  /** Serialize native writes and cancellation so a response cannot race abort. */
  withNativeControl<T>(operation: (native: NativeSession) => Promise<T>): Promise<T> {
    return this.native.lane(async () => {
      const native = this.native.current()
      if (!native || this.isCancelling()) throw new RunInteractionCancelledError(this.id)
      return operation(native)
    })
  }

  state(): RunState {
    if (this.isTerminal()) return 'terminal'
    if (this.cancelRequestedAt !== null) return 'cancelling'
    return this.log.readers() > 0 ? 'running' : 'detached'
  }

  isTerminal(): boolean {
    return this.status !== 'running'
  }

  /** Failure raised before any output — the only kind that can replace the body. */
  dispatchError(): unknown {
    return this.setupError
  }

  /** The failure that ended this run, before or after output. */
  failure(): unknown {
    return this.failureError
  }

  /** Resolve once output begins or dispatch reaches a terminal failure. */
  whenStarted(): Promise<void> {
    return this.log.whenStarted()
  }

  /** Resolve only after the owned backend job reaches a terminal state. */
  async whenTerminal(): Promise<RunSnapshot> {
    while (!this.isTerminal() && !this.disposed) {
      await this.log.waitForChange()
    }
    await (this.disposalPromise ?? this.native.finalization())
    return this.snapshot()
  }

  /** Fail closed unless every event after this cursor remains available. */
  assertReplayCursor(afterSeq: number): void {
    this.log.assertReplayCursor(afterSeq)
  }

  /**
   * Attach one transport reader. The optional signal detaches only this
   * reader; it never propagates to the backend's owned abort controller.
   */
  async *attach(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqDelta> {
    yield* this.log.attach(afterSeq, readerSignal)
  }

  /** Signal cancellation once. Terminal proof comes later from `pump()`. */
  cancel(): boolean {
    if (this.isTerminal() || this.cancelRequestedAt !== null) return false
    if (this.native.current()) {
      if (this.nativeCancellationRequest) return false
      void this.requestNativeCancellation().catch((error) => {
        console.error(`[cli-bridge] run ${this.id} termination proof failed:`, error)
      })
      return true
    }
    this.cancelRequestedAt = Date.now()
    try {
      this.cancelOutstandingInteractions('run cancelled')
    } catch (error) {
      this.canonical.markDurabilityUnknown(error)
    }
    this.ac.abort()
    this.log.wakeAll()
    return true
  }

  /**
   * Queue cancellation behind any native response already in flight.
   * The run is not marked cancelling until that response has either completed
   * and recorded its outcome or failed, so the two durable acknowledgements
   * cannot disagree about which native side effect won the race.
   */
  requestNativeCancellation(): Promise<boolean> {
    if (this.nativeCancellationRequest) return this.nativeCancellationRequest
    const native = this.native.current()
    if (!native) return Promise.resolve(this.cancel())

    const request = this.native.lane(async (): Promise<boolean> => {
      if (this.isTerminal() || this.cancelRequestedAt !== null || !this.native.owns(native)) {
        return false
      }
      const finalization = Promise.resolve().then(() => this.native.finalizeControl(native, true))
      this.native.track(finalization)
      this.cancelRequestedAt = Date.now()
      let cancellationFailure: unknown
      try {
        this.cancelOutstandingInteractions('run cancelled')
      } catch (error) {
        cancellationFailure = error
        this.canonical.markDurabilityUnknown(error)
      }
      this.ac.abort()
      this.log.wakeAll()
      let finalizationFailure: unknown
      try {
        await finalization
      } catch (error) {
        finalizationFailure = error
      }
      if (cancellationFailure || finalizationFailure) {
        throw cancellationFailure ?? finalizationFailure
      }
      return true
    })
    this.nativeCancellationRequest = request
    return request
  }

  /** Cancel and forget immediately during bridge shutdown/tests. */
  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise
    if (!this.disposed) {
      if (!this.isTerminal()) {
        if (this.cancelRequestedAt === null) this.cancelRequestedAt = Date.now()
        this.ac.abort()
        this.status = this.canonical.durabilityUnknown() ? 'unknown' : 'cancelled'
        this.endedAt = Date.now()
      }
      this.disposed = true
      if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer)
      this.lifetimeTimer = null
      this.log.discard()
    }
    const cleanup = this.native.dispose(() => this.cancelRequestedAt !== null || !this.isTerminal())
    this.disposalPromise = cleanup
    void cleanup.catch(() => {
      if (this.disposalPromise === cleanup && this.native.current()) this.disposalPromise = null
    })
    return cleanup
  }

  private finish(status: Exclude<RunStatus, 'running'>): void {
    if (this.isTerminal() || this.disposed) return
    // An interaction cannot remain answerable after its owning run reaches any
    // terminal outcome, including a provider that ends without resolving its
    // last dialog.  This also prevents a late response from reaching a native
    // session after the canonical stream has already closed.
    try {
      this.cancelOutstandingInteractions(status === 'cancelled' ? 'run cancelled' : 'run ended')
    } catch (error) {
      this.canonical.markDurabilityUnknown(error)
    }
    this.status = this.canonical.durabilityUnknown() ? 'unknown' : status
    this.endedAt = Date.now()
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer)
      this.lifetimeTimer = null
    }
    if (this.status !== 'done')
      void this.native.finalize(false).catch((error) => {
        console.error(`[cli-bridge] run ${this.id} finalization proof failed:`, error)
      })
    this.log.scheduleRetention(this.endedAt)
    this.persistSnapshot(true)
  }

  private persistSnapshot(terminal: boolean): void {
    if (!this.commitSnapshot) return
    try {
      this.commitSnapshot(this.snapshot())
    } catch (error) {
      this.failureError ??= error
      this.canonical.markDurabilityUnknown(error)
      if (!terminal) throw error
      this.status = 'unknown'
      try {
        this.commitSnapshot(this.snapshot())
      } catch {
        // The admission remains at its last durable snapshot.
      }
    }
  }

  private expireLifetime(): void {
    this.lifetimeTimer = null
    if (this.isTerminal() || this.disposed) return
    const error = new RunLifetimeExceededError(this.id, this.retention.maxLifetimeMs)
    this.failureError = error
    if (this.log.lastSeq() === 0) this.setupError = error
    this.ac.abort()
    try {
      this.cancelOutstandingInteractions('run lifetime exceeded')
    } catch (failure) {
      this.canonical.markDurabilityUnknown(failure)
    }
    this.log.append({ finish_reason: 'error', error: describeRunFailure(error) })
    this.finish('error')
    console.error(`[cli-bridge] ${error.message}`)
  }

  private cancelOutstandingInteractions(reason: string): void {
    this.interactions.cancelAll(
      reason,
      this.commitCanonicalEvent
        ? (id, why) => {
            this.canonical.append({ event: { type: 'interaction.cancel', id, reason: why } })
          }
        : null,
    )
  }
}
