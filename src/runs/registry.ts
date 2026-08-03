/**
 * Durable run registry — one server-owned job can outlive any individual
 * HTTP reader. A run id is bound to one normalized request, output is
 * sequence-numbered for replay, and only explicit cancellation aborts the
 * backend job.
 *
 * This is deliberately process-local. A bridge restart loses active jobs
 * and their identity records, so a caller that sees 404 after reconnect
 * must treat the old job as unknown rather than proven stopped.
 */

import type { ChatDelta } from '../backends/types.js'
import type { NativeSession } from '../backends/types.js'
import { CanonicalStreamEventSchema, RuntimeEventEnvelopeSchema, canonicalCandidateDigest, type InteractionRequest, type RuntimeEventEnvelope, type StreamEvent } from '@tangle-network/agent-interface'
import { BackendReportedFailureError, describeRunFailure, reasonForTerminalDelta } from './error-shape.js'

/** A buffered delta plus its per-run monotonic sequence number. */
export interface SeqDelta {
  seq: number
  delta: ChatDelta
}

export interface SeqCanonicalEvent {
  seq: number
  envelope: RuntimeEventEnvelope
}

export type CanonicalEventListener = (event: SeqCanonicalEvent) => void

export interface CanonicalEventInput {
  event: StreamEvent
  occurredAt?: string
}

export interface RunClaimOptions {
  sessionId?: string
  executionId?: string
  commitCanonicalEvent?: (input: {
    runId: string
    sequence: number
    eventId: string
    event: StreamEvent
    occurredAt?: string
    receivedAt: string
  }) => RuntimeEventEnvelope
  onNativeControlLost?: (input: {
    runId: string
    sessionId?: string
    reason: Error
  }) => void
}

export interface PendingRunInteraction {
  request: InteractionRequest
  nativeId: string
}

/** Existing completion outcome. `running` means no outcome exists yet. */
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'unknown'

/** Connection/process lifecycle, separate from the terminal outcome. */
export type RunState = 'detached' | 'running' | 'cancelling' | 'terminal'

export interface RunReplayWindow {
  /** Lowest event still replayable. A cursor of `firstAvailableSeq - 1` is valid. */
  firstAvailableSeq: number
  lastSeq: number
  retainedDeltas: number
  maxRetainedDeltas: number
  /** Set once terminal; the buffer is cleared at this Unix-millisecond time. */
  expiresAt: number | null
  expired: boolean
}

export interface RunSnapshot {
  id: string
  /** Digest of the normalized execution request bound to this id. */
  requestDigest: string
  /** Completion outcome; remains `running` while detached or cancelling. */
  status: RunStatus
  /** Distinguishes an attached reader, no reader, cancellation, and process exit. */
  state: RunState
  /** True only after the owned backend job has reached a terminal state. */
  terminal: boolean
  attachedReaders: number
  cancelRequestedAt: number | null
  /** Highest seq emitted so far. 0 = no delta emitted yet. */
  lastSeq: number
  replay: RunReplayWindow
  startedAt: number
  endedAt: number | null
  /** Run-id binding survives replay expiry until this time. */
  identityExpiresAt: number | null
  sessionId?: string
  executionId?: string
  canonicalLastSeq: number
}

/** A caller attempted to reuse a durable run id for different execution bytes. */
export class RunIdentityConflictError extends Error {
  readonly code = 'run_identity_conflict' as const

  constructor(
    readonly runId: string,
    readonly expectedRequestDigest: string,
    readonly receivedRequestDigest: string,
  ) {
    super(`run ${JSON.stringify(runId)} is already bound to a different request`)
    this.name = 'RunIdentityConflictError'
  }
}

export type RunReplayCursorErrorReason = 'ahead' | 'expired'

/** A replay cursor cannot be served exactly from the retained output window. */
export class RunReplayCursorError extends Error {
  readonly code: 'invalid_replay_cursor' | 'expired_replay_cursor'

  constructor(
    readonly runId: string,
    readonly cursor: number,
    readonly firstAvailableSeq: number,
    readonly lastSeq: number,
    readonly reason: RunReplayCursorErrorReason,
  ) {
    super(
      reason === 'ahead'
        ? `Last-Event-ID ${cursor} is ahead of run ${JSON.stringify(runId)} at ${lastSeq}`
        : `Last-Event-ID ${cursor} has expired for run ${JSON.stringify(runId)}; first available event is ${firstAvailableSeq}`,
    )
    this.name = 'RunReplayCursorError'
    this.code = reason === 'ahead' ? 'invalid_replay_cursor' : 'expired_replay_cursor'
  }
}

export class RunInteractionCancelledError extends Error {
  readonly code = 'interaction_cancelled' as const

  constructor(readonly runId: string) {
    super(`run ${JSON.stringify(runId)} is cancelling; interaction responses are closed`)
    this.name = 'RunInteractionCancelledError'
  }
}

export class RunShutdownTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly pendingRuns: number,
  ) {
    super(`timed out after ${timeoutMs}ms while stopping ${pendingRuns} run${pendingRuns === 1 ? '' : 's'}`)
    this.name = 'RunShutdownTimeoutError'
  }
}

interface Waiter {
  resolve: () => void
}

interface RunRetention {
  replayRetentionMs: number
  identityRetentionMs: number
  maxReplayDeltas: number
}

/** One durable server-owned backend job and its bounded replay log. */
export class Run {
  readonly startedAt = Date.now()
  private readonly buffer: SeqDelta[] = []
  private readonly canonicalBuffer: SeqCanonicalEvent[] = []
  private seq = 0
  private canonicalSeq = 0
  private status: RunStatus = 'running'
  private endedAt: number | null = null
  private attachedReaders = 0
  private cancelRequestedAt: number | null = null
  private replayExpiresAt: number | null = null
  private identityExpiresAt: number | null = null
  private replayExpired = false
  private readonly waiters = new Set<Waiter>()
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private identityTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private nativeControl: NativeSession | null = null
  private nativeCloseUnsubscribe: (() => void) | null = null
  private nativeFinalization: Promise<void> | null = null
  private nativeCancellationRequest: Promise<boolean> | null = null
  private canonicalDurabilityUnknown = false
  private readonly pendingInteractions = new Map<string, PendingRunInteraction>()
  private readonly resolvingInteractions = new Set<string>()
  private readonly resolvedInteractions = new Set<string>()
  private readonly resolvedInteractionDigests = new Map<string, string>()
  private readonly cancelledInteractions = new Set<string>()
  private readonly canonicalSubscribers = new Set<CanonicalEventListener>()
  private nativeControlLane: Promise<void> = Promise.resolve()

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
    private readonly onForget: (id: string, run: Run) => void,
    private readonly retention: RunRetention,
    readonly sessionId?: string,
    readonly executionId?: string,
    private readonly commitCanonicalEvent?: RunClaimOptions['commitCanonicalEvent'],
    private readonly onNativeControlLost?: RunClaimOptions['onNativeControlLost'],
  ) {}

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
      attachedReaders: this.attachedReaders,
      cancelRequestedAt: this.cancelRequestedAt,
      lastSeq: this.seq,
      replay: {
        firstAvailableSeq: this.firstAvailableSeq(),
        lastSeq: this.seq,
        retainedDeltas: this.buffer.length,
        maxRetainedDeltas: this.retention.maxReplayDeltas,
        expiresAt: this.replayExpiresAt,
        expired: this.replayExpired,
      },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      identityExpiresAt: this.identityExpiresAt,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.executionId ? { executionId: this.executionId } : {}),
      canonicalLastSeq: this.canonicalSeq,
    }
  }

  setNativeControl(control: NativeSession): void {
    if (this.nativeControl && this.nativeControl !== control) {
      throw new Error(`run ${this.id} already owns a native session control`)
    }
    this.nativeControl = control
    this.nativeCloseUnsubscribe?.()
    this.nativeCloseUnsubscribe = control.onClose(reason => {
      this.handleNativeControlClosed(control, reason)
    })
    if (control.isClosed()) {
      this.handleNativeControlClosed(control, new Error('native session closed before ownership was established'))
    }
  }

  nativeSession(): NativeSession | null {
    if (this.nativeControl?.isClosed()) {
      this.handleNativeControlClosed(this.nativeControl, new Error('native session is closed'))
    }
    return this.nativeControl
  }

  /** Transfer a retained provider session to the next native run without
   * letting the completed run close it when its replay window expires. */
  takeNativeControl(control: NativeSession): boolean {
    if (this.nativeControl !== control) return false
    if (this.nativeFinalization) return false
    this.nativeCloseUnsubscribe?.()
    this.nativeCloseUnsubscribe = null
    this.nativeControl = null
    return true
  }

  /** Close one retained native session without surrendering retry ownership. */
  async closeNativeControl(control: NativeSession): Promise<boolean> {
    const previous = this.nativeControlLane
    let release!: () => void
    this.nativeControlLane = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (this.nativeControl !== control || this.nativeFinalization) return false
      // A deliberate close must not look like an unexpected provider loss.
      // Keep the control pointer until close succeeds so a failed attempt can
      // be retried through the same retained-session endpoint.
      this.nativeCloseUnsubscribe?.()
      this.nativeCloseUnsubscribe = null
      try {
        await control.close()
      } catch (error) {
        if (!control.isClosed()) {
          this.nativeCloseUnsubscribe = control.onClose(reason => {
            this.handleNativeControlClosed(control, reason)
          })
          if (control.isClosed()) {
            this.handleNativeControlClosed(control, new Error('native session closed while close retry ownership was restored'))
          }
          throw error
        }
        // The provider reported an error after completing the close. The
        // observable effect won, so do not turn a successful close into an
        // unretryable unknown state.
      }
      if (this.nativeControl === control) this.nativeControl = null
      return true
    } finally {
      release()
    }
  }

  registerInteraction(interaction: PendingRunInteraction): void {
    this.pendingInteractions.set(interaction.request.id, interaction)
  }

  interaction(id: string): PendingRunInteraction | null {
    return this.pendingInteractions.get(id) ?? null
  }

  /** Claim one interaction so distinct operation ids cannot answer it twice. */
  claimInteraction(id: string): PendingRunInteraction | null {
    if (this.isTerminal()) return null
    const pending = this.pendingInteractions.get(id)
    if (!pending || this.resolvingInteractions.has(id)) return null
    this.resolvingInteractions.add(id)
    return pending
  }

  releaseInteractionClaim(id: string): void {
    this.resolvingInteractions.delete(id)
  }

  interactionIsResolving(id: string): boolean {
    return this.resolvingInteractions.has(id)
  }

  resolveInteraction(id: string, responseDigest?: string): void {
    this.resolvingInteractions.delete(id)
    this.pendingInteractions.delete(id)
    // A resolved native response is proof that the side effect won. Explicit
    // cancellation is serialized behind this method, so only an unrelated
    // terminal notification can have tentatively withdrawn the interaction.
    this.cancelledInteractions.delete(id)
    this.resolvedInteractions.add(id)
    if (responseDigest) this.resolvedInteractionDigests.set(id, responseDigest)
  }

  interactionWasResolved(id: string): boolean {
    return this.resolvedInteractions.has(id)
  }

  resolvedInteractionDigest(id: string): string | null {
    return this.resolvedInteractionDigests.get(id) ?? null
  }

  interactionWasCancelled(id: string): boolean {
    return this.cancelledInteractions.has(id)
  }

  appendCanonical(input: CanonicalEventInput): RuntimeEventEnvelope {
    const event = CanonicalStreamEventSchema.parse(input.event)
    const sequence = this.canonicalSeq + 1
    const receivedAt = new Date().toISOString()
    const eventId = runtimeEventId(this.id, sequence)
    let envelope: RuntimeEventEnvelope
    try {
      envelope = this.commitCanonicalEvent?.({
        runId: this.id,
        sequence,
        eventId,
        event,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        receivedAt,
      }) ?? {
        runId: this.id,
        eventId,
        sequence,
        cursor: String(sequence),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        receivedAt,
        event,
      }
      RuntimeEventEnvelopeSchema.parse(envelope)
    } catch (error) {
      if (this.commitCanonicalEvent) this.markCanonicalDurabilityUnknown(error)
      throw error
    }
    this.canonicalSeq = sequence
    this.canonicalBuffer.push({ seq: sequence, envelope })
    while (this.canonicalBuffer.length > this.retention.maxReplayDeltas) this.canonicalBuffer.shift()
    const committed = { seq: sequence, envelope }
    for (const listener of this.canonicalSubscribers) {
      try { listener(committed) } catch { /* a reader cannot break the run */ }
    }
    this.wakeAll()
    return envelope
  }

  subscribeCanonical(listener: CanonicalEventListener): () => void {
    this.canonicalSubscribers.add(listener)
    return () => this.canonicalSubscribers.delete(listener)
  }

  isCancelling(): boolean {
    return this.cancelRequestedAt !== null || this.ac.signal.aborted || this.disposed
  }

  /** Serialize native writes and cancellation so a response cannot race abort. */
  async withNativeControl<T>(operation: (native: NativeSession) => Promise<T>): Promise<T> {
    const previous = this.nativeControlLane
    let release!: () => void
    this.nativeControlLane = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const native = this.nativeControl
      if (!native || this.isCancelling()) throw new RunInteractionCancelledError(this.id)
      return await operation(native)
    } finally {
      release()
    }
  }

  async pumpCanonical(source: AsyncIterable<CanonicalEventInput>): Promise<void> {
    if (this.settled) return this.settled
    this.settled = (async () => {
      let terminal: 'done' | 'error' | 'cancelled' = 'done'
      let terminalEvent: CanonicalEventInput | null = null
      try {
        for await (const input of source) {
          if (input.event.type === 'status' && (input.event.status === 'completed' || input.event.status === 'failed')) {
            terminalEvent = input
            if (input.event.status === 'failed') terminal = 'error'
            continue
          }
          this.appendCanonical(input)
        }
        // Withdrawal must be durable before the terminal status. The terminal
        // status is held until the source ends so it can be the final canonical
        // event even when a provider left a dialog outstanding.
        this.cancelOutstandingInteractions(this.ac.signal.aborted ? 'run cancelled' : 'run ended')
        if (this.ac.signal.aborted) {
          this.appendCanonical({ event: { type: 'status', status: 'failed', detail: 'cancelled' } })
          terminal = 'cancelled'
        } else if (terminalEvent) {
          this.appendCanonical(terminalEvent)
        } else {
          const error = new Error('native event stream ended without an explicit terminal status')
          this.failureError = error
          terminal = 'error'
          this.appendCanonical({ event: { type: 'status', status: 'failed', detail: error.message } })
        }
        this.finish(terminal)
      } catch (error) {
        this.failureError ??= error
        // Once a commit has failed, a later terminal event cannot repair the
        // missing observation. Publishing "failed" after losing "completed"
        // would turn an unknown outcome into a false negative for every reader.
        if (!this.canonicalDurabilityUnknown) {
          if (this.ac.signal.aborted) {
            try {
              this.cancelOutstandingInteractions('run cancelled')
              this.appendCanonical({ event: { type: 'status', status: 'failed', detail: 'cancelled' } })
            } catch (durabilityError) {
              if (this.commitCanonicalEvent) this.markCanonicalDurabilityUnknown(durabilityError)
            }
          } else {
            try {
              this.cancelOutstandingInteractions('run ended')
              this.appendCanonical({ event: { type: 'status', status: 'failed', detail: error instanceof Error ? error.message : String(error) } })
            } catch (durabilityError) {
              if (this.commitCanonicalEvent) this.markCanonicalDurabilityUnknown(durabilityError)
            }
          }
        }
        this.finish(this.canonicalDurabilityUnknown ? 'unknown' : this.ac.signal.aborted ? 'cancelled' : 'error')
      }
    })()
    return this.settled
  }

  assertCanonicalReplayCursor(afterSeq: number): void {
    const first = this.canonicalBuffer[0]?.seq ?? this.canonicalSeq + 1
    if (afterSeq > this.canonicalSeq) throw new RunReplayCursorError(this.id, afterSeq, first, this.canonicalSeq, 'ahead')
    if (this.replayExpired || afterSeq < first - 1) throw new RunReplayCursorError(this.id, afterSeq, first, this.canonicalSeq, 'expired')
  }

  async *attachCanonical(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqCanonicalEvent> {
    this.attachedReaders += 1
    this.wakeAll()
    let cursor = afterSeq
    try {
      while (!readerSignal?.aborted) {
        this.assertCanonicalReplayCursor(cursor)
        const available = this.canonicalBuffer.filter(item => item.seq > cursor)
        for (const item of available) {
          if (readerSignal?.aborted) return
          cursor = item.seq
          yield item
        }
        if (cursor < this.canonicalSeq) continue
        if (this.isTerminal() || this.disposed) return
        await this.waitForChange(readerSignal)
      }
    } finally {
      this.attachedReaders = Math.max(0, this.attachedReaders - 1)
      this.wakeAll()
    }
  }

  state(): RunState {
    if (this.isTerminal()) return 'terminal'
    if (this.cancelRequestedAt !== null) return 'cancelling'
    return this.attachedReaders > 0 ? 'running' : 'detached'
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
  async whenStarted(): Promise<void> {
    while (this.seq === 0 && !this.isTerminal() && !this.disposed) {
      await this.waitForChange()
    }
  }

  /** Resolve only after the owned backend job reaches a terminal state. */
  async whenTerminal(): Promise<RunSnapshot> {
    while (!this.isTerminal() && !this.disposed) {
      await this.waitForChange()
    }
    await this.nativeFinalization
    return this.snapshot()
  }

  /**
   * Consume the backend exactly once, independently from attached readers.
   *
   * A failure reaches here two ways and BOTH have to end up with a reason on the
   * terminal delta and a recorded `failure()`:
   *
   *   - it is THROWN, and the catch block below handles it;
   *   - it is YIELDED as `{ finish_reason: 'error' }`, which is what every
   *     subprocess backend does after an upstream error event and on abort.
   *
   * Only the first was covered, and the second is the one that reached callers:
   * the loop appended the bare delta, `finish()` recorded status `error`, and
   * `failureError` stayed undefined — so the reader had nothing to report and
   * answered HTTP 200 with `content: ""`. Normalizing inside this loop is what
   * makes the invariant hold for backends that do not exist yet.
   */
  pump(source: AsyncIterable<ChatDelta>): Promise<void> {
    if (this.settled) return this.settled
    this.settled = (async () => {
      try {
        let outcome: 'done' | 'error' = 'done'
        for await (const delta of source) {
          this.append(this.withTerminalReason(delta))
          if (delta.finish_reason === 'error' || delta.finish_reason === 'timeout') {
            outcome = 'error'
          }
        }
        this.finish(this.ac.signal.aborted ? 'cancelled' : outcome)
      } catch (error) {
        if (this.ac.signal.aborted) {
          this.finish('cancelled')
        } else {
          this.failureError = error
          if (this.seq === 0) this.setupError = error
          // The reason rides ON the terminal delta, so it survives buffering,
          // replay and reconnect. A bare `{ finish_reason: 'error' }` left the
          // caller with an empty completion whose only explanation was in this
          // process's stdout.
          this.append({ finish_reason: 'error', error: describeRunFailure(error) })
          this.finish('error')
          console.error(`[cli-bridge] run ${this.id} failed:`, error)
        }
      }
    })()
    return this.settled
  }

  /** Commit a claimed run whose admission/backend setup failed before `pump()`. */
  failSetup(error: unknown): void {
    if (this.settled || this.isTerminal()) return
    this.setupError = error
    this.failureError = error
    this.append({ finish_reason: 'error', error: describeRunFailure(error) })
    this.finish(this.ac.signal.aborted ? 'cancelled' : 'error')
    this.settled = Promise.resolve()
  }

  failCanonicalSetup(error: unknown): void {
    if (this.settled || this.isTerminal()) return
    this.failureError = error
    try {
      this.appendCanonical({
        event: {
          type: 'status',
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
    } catch {
      // A storage failure has no safe second persistence path; terminal state
      // still records that this run never became executable.
    }
    this.finish('error')
    this.settled = Promise.resolve()
  }

  /** Fail closed unless every event after this cursor remains available. */
  assertReplayCursor(afterSeq: number): void {
    const firstAvailableSeq = this.firstAvailableSeq()
    if (afterSeq > this.seq) {
      throw new RunReplayCursorError(
        this.id,
        afterSeq,
        firstAvailableSeq,
        this.seq,
        'ahead',
      )
    }
    if (this.replayExpired || afterSeq < firstAvailableSeq - 1) {
      throw new RunReplayCursorError(
        this.id,
        afterSeq,
        firstAvailableSeq,
        this.seq,
        'expired',
      )
    }
  }

  /**
   * Attach one transport reader. The optional signal detaches only this
   * reader; it never propagates to the backend's owned abort controller.
   */
  async *attach(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqDelta> {
    this.attachedReaders += 1
    this.wakeAll()
    let cursor = afterSeq
    try {
      while (!readerSignal?.aborted) {
        this.assertReplayCursor(cursor)

        // Copy the currently available tail before yielding. The bounded
        // ring may rotate while the consumer processes a delta; this copy
        // prevents an array shift from silently skipping an event.
        const available = this.buffer.filter(item => item.seq > cursor)
        for (const item of available) {
          if (readerSignal?.aborted) return
          cursor = item.seq
          yield item
        }

        // Output may have arrived after `available` was copied but before
        // the waiter is registered. Loop immediately when the sequence moved
        // so that wake-up cannot be lost in that check/subscribe gap.
        if (cursor < this.seq) continue
        if (this.isTerminal()) return
        if (this.disposed) return
        await this.waitForChange(readerSignal)
      }
    } finally {
      this.attachedReaders = Math.max(0, this.attachedReaders - 1)
      this.wakeAll()
    }
  }

  /** Signal cancellation once. Terminal proof comes later from `pump()`. */
  cancel(): boolean {
    if (this.isTerminal() || this.cancelRequestedAt !== null) return false
    if (this.nativeControl) {
      if (this.nativeCancellationRequest) return false
      void this.requestNativeCancellation().catch(error => {
        console.error(`[cli-bridge] run ${this.id} termination proof failed:`, error)
      })
      return true
    }
    this.cancelRequestedAt = Date.now()
    try {
      this.cancelOutstandingInteractions('run cancelled')
    } catch (error) {
      this.markCanonicalDurabilityUnknown(error)
    }
    this.ac.abort()
    this.wakeAll()
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
    const native = this.nativeControl
    if (!native) return Promise.resolve(this.cancel())

    const previous = this.nativeControlLane
    let release!: () => void
    this.nativeControlLane = new Promise<void>(resolve => { release = resolve })
    const request = (async (): Promise<boolean> => {
      await previous
      try {
        if (this.isTerminal() || this.cancelRequestedAt !== null || this.nativeControl !== native) {
          return false
        }
        const finalization = Promise.resolve().then(() => this.finalizeNativeControl(native, true))
        this.nativeFinalization = finalization
        this.cancelRequestedAt = Date.now()
        let cancellationFailure: unknown
        try {
          this.cancelOutstandingInteractions('run cancelled')
        } catch (error) {
          cancellationFailure = error
          this.markCanonicalDurabilityUnknown(error)
        }
        this.ac.abort()
        this.wakeAll()
        let finalizationFailure: unknown
        try { await finalization } catch (error) { finalizationFailure = error }
        if (cancellationFailure || finalizationFailure) {
          throw cancellationFailure ?? finalizationFailure
        }
        return true
      } finally {
        release()
      }
    })()
    this.nativeCancellationRequest = request
    return request
  }

  /** Cancel and forget immediately during bridge shutdown/tests. */
  dispose(): Promise<void> {
    if (this.disposed) return this.nativeFinalization ?? Promise.resolve()
    if (!this.isTerminal()) {
      if (this.cancelRequestedAt === null) this.cancelRequestedAt = Date.now()
      this.ac.abort()
      this.status = this.canonicalDurabilityUnknown ? 'unknown' : 'cancelled'
      this.endedAt = Date.now()
    }
    if (this.replayTimer) clearTimeout(this.replayTimer)
    if (this.identityTimer) clearTimeout(this.identityTimer)
    this.replayTimer = null
    this.identityTimer = null
    this.disposed = true
    this.replayExpired = true
    this.buffer.length = 0
    this.canonicalBuffer.length = 0
    const cleanup = this.finalizeNative(this.cancelRequestedAt !== null || !this.isTerminal())
    this.wakeAll()
    return cleanup
  }

  /**
   * Give a yielded terminal failure the reason it must carry, and record it as
   * the run's failure so the reader can turn it into a real HTTP status.
   *
   * Cancellation is deliberately excluded: the caller asked for it, `finish()`
   * already records status `cancelled`, and calling it a failure would make a
   * granted request read as a fault. The delta still gets a reason, so a reader
   * can tell a cancelled run from an empty answer.
   */
  private withTerminalReason(delta: ChatDelta): ChatDelta {
    const finishReason = delta.finish_reason
    if (finishReason !== 'error' && finishReason !== 'timeout') return delta
    if (this.ac.signal.aborted) {
      return {
        ...delta,
        error: delta.error ?? {
          message: `run ${this.id} was cancelled by the caller before it produced a terminal answer`,
          type: 'run_cancelled',
        },
      }
    }
    const reason = reasonForTerminalDelta(finishReason, delta.error, 'the backend')
    if (this.failureError === undefined) {
      this.failureError = new BackendReportedFailureError(reason.message, reason.type)
    }
    return { ...delta, error: reason }
  }

  private append(delta: ChatDelta): void {
    this.seq += 1
    this.buffer.push({ seq: this.seq, delta })
    while (this.buffer.length > this.retention.maxReplayDeltas) this.buffer.shift()
    this.wakeAll()
  }

  private firstAvailableSeq(): number {
    return this.buffer[0]?.seq ?? this.seq + 1
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
      this.markCanonicalDurabilityUnknown(error)
    }
    this.status = this.canonicalDurabilityUnknown ? 'unknown' : status
    this.endedAt = Date.now()
    if (this.status !== 'done') void this.finalizeNative(false).catch(error => {
      console.error(`[cli-bridge] run ${this.id} finalization proof failed:`, error)
    })
    this.replayExpiresAt = this.endedAt + this.retention.replayRetentionMs
    this.identityExpiresAt = this.endedAt + this.retention.identityRetentionMs
    this.wakeAll()
    this.scheduleRetentionTimers()
  }

  /** Abort when requested, then close one retained child and release its slot once. */
  private finalizeNative(abortFirst: boolean): Promise<void> {
    if (this.nativeFinalization) return this.nativeFinalization
    const native = this.nativeControl
    if (!native) return Promise.resolve()
    const attempt = (async () => {
      const previous = this.nativeControlLane
      let release!: () => void
      this.nativeControlLane = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        await this.finalizeNativeControl(native, abortFirst)
      } finally {
        release()
      }
    })()
    this.nativeFinalization = attempt
    void attempt.catch(() => {
      if (this.nativeFinalization === attempt && this.nativeControl === native) {
        this.nativeFinalization = null
      }
    })
    return attempt
  }

  private async finalizeNativeControl(native: NativeSession, abortFirst: boolean): Promise<void> {
    if (this.nativeControl !== native) return
    let failure: unknown
    let closeSucceeded = false
    if (abortFirst) {
      try { await native.abort() } catch (error) { failure = error }
    }
    try {
      await native.close()
      closeSucceeded = true
    } catch (error) { failure ??= error }
    if (closeSucceeded || native.isClosed()) {
      this.nativeCloseUnsubscribe?.()
      this.nativeCloseUnsubscribe = null
      if (this.nativeControl === native) this.nativeControl = null
    }
    if (failure) throw failure
  }

  private handleNativeControlClosed(native: NativeSession, reason: Error): void {
    if (this.nativeControl !== native) return
    this.nativeCloseUnsubscribe?.()
    this.nativeCloseUnsubscribe = null
    this.nativeControl = null
    const alreadyFinalizing = this.nativeFinalization !== null
    this.nativeFinalization ??= Promise.resolve().then(() => native.whenClosed())
    void this.nativeFinalization.catch(error => {
      console.error(`[cli-bridge] run ${this.id} native cleanup failed after close:`, error)
    })
    if (alreadyFinalizing || this.disposed || this.isCancelling()) return
    this.onNativeControlLost?.({
      runId: this.id,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      reason,
    })
  }

  private cancelOutstandingInteractions(reason: string): void {
    if (this.pendingInteractions.size === 0) return
    let failure: unknown
    for (const id of this.pendingInteractions.keys()) {
      this.pendingInteractions.delete(id)
      this.resolvingInteractions.delete(id)
      this.cancelledInteractions.add(id)
      if (!this.commitCanonicalEvent) continue
      try {
        this.appendCanonical({ event: { type: 'interaction.cancel', id, reason } })
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }

  private markCanonicalDurabilityUnknown(error: unknown): void {
    this.canonicalDurabilityUnknown = true
    this.failureError ??= error
  }

  private scheduleRetentionTimers(): void {
    if (this.replayTimer || this.identityTimer) return
    this.replayTimer = setTimeout(() => {
      this.replayExpired = true
      this.buffer.length = 0
      this.wakeAll()
    }, this.retention.replayRetentionMs)
    this.replayTimer.unref?.()

    this.identityTimer = setTimeout(() => {
      this.onForget(this.id, this)
    }, this.retention.identityRetentionMs)
    this.identityTimer.unref?.()
  }

  private wakeAll(): void {
    for (const waiter of [...this.waiters]) waiter.resolve()
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let resolved = false
      let waiter: Waiter
      const onAbort = (): void => finish()
      const finish = (): void => {
        if (resolved) return
        resolved = true
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      waiter = { resolve: finish }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

export interface RunRegistryOptions {
  /** Terminal output replay lifetime. Default 60 seconds. */
  replayRetentionMs?: number
  /** Backward-compatible alias for `replayRetentionMs`. */
  reapDelayMs?: number
  /** Run-id/request binding lifetime after terminal. Default 24 hours. */
  identityRetentionMs?: number
  /** Maximum deltas retained per live or terminal run. Default 10,000. */
  maxReplayDeltas?: number
}

/** Process-wide, bounded durable-run registry keyed by caller-owned run id. */
export class RunRegistry {
  private readonly runs = new Map<string, Run>()
  private readonly pendingDisposals = new Set<Promise<void>>()
  private readonly disposalFailures: unknown[] = []
  private readonly retention: RunRetention

  constructor(opts: RunRegistryOptions = {}) {
    const replayRetentionMs = opts.replayRetentionMs ?? opts.reapDelayMs ?? 60_000
    const identityRetentionMs = opts.identityRetentionMs ?? 86_400_000
    const maxReplayDeltas = opts.maxReplayDeltas ?? 10_000
    assertNonNegativeInt('replayRetentionMs', replayRetentionMs)
    assertNonNegativeInt('identityRetentionMs', identityRetentionMs)
    if (identityRetentionMs < replayRetentionMs) {
      throw new Error('identityRetentionMs must be greater than or equal to replayRetentionMs')
    }
    if (!Number.isSafeInteger(maxReplayDeltas) || maxReplayDeltas < 1) {
      throw new Error('maxReplayDeltas must be a positive safe integer')
    }
    this.retention = { replayRetentionMs, identityRetentionMs, maxReplayDeltas }
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /**
   * Atomically bind one run id to one normalized execution request. The
   * creator alone performs admission/setup; racing identical requests attach.
   */
  claim(
    id: string,
    requestDigest: string,
    options: RunClaimOptions = {},
  ): { readonly run: Run; readonly created: boolean } {
    const existing = this.runs.get(id)
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new RunIdentityConflictError(id, existing.requestDigest, requestDigest)
      }
      return { run: existing, created: false }
    }
    const run = new Run(
      id,
      requestDigest,
      (runId, expected) => this.forget(runId, expected),
      this.retention,
      options.sessionId,
      options.executionId,
      options.commitCanonicalEvent,
      options.onNativeControlLost,
    )
    this.runs.set(id, run)
    return { run, created: true }
  }

  /** Request cancellation once. False means unknown, terminal, or already cancelling. */
  cancel(id: string): boolean {
    return this.runs.get(id)?.cancel() ?? false
  }

  nativeSession(sessionId: string): { run: Run; session: NativeSession } | null {
    const runs = [...this.runs.values()].reverse()
    for (const run of runs) {
      if (run.sessionId !== sessionId) continue
      const session = run.nativeSession()
      if (session) return { run, session }
    }
    return null
  }

  private forget(id: string, expected: Run): void {
    if (this.runs.get(id) !== expected) return
    this.runs.delete(id)
    this.trackDisposal(expected.dispose())
  }

  /** Test/shutdown aid — cancel and forget every run. */
  clear(): void {
    for (const run of this.runs.values()) this.trackDisposal(run.dispose())
    this.runs.clear()
  }

  private trackDisposal(disposal: Promise<void>): void {
    const tracked = Promise.resolve(disposal).then(
      () => {},
      error => {
        this.disposalFailures.push(error)
        throw error
      },
    )
    this.pendingDisposals.add(tracked)
    void tracked.then(
      () => this.pendingDisposals.delete(tracked),
      () => this.pendingDisposals.delete(tracked),
    )
  }

  /** Stop every owned native child and wait for each executor's proof. */
  async shutdown(timeoutMs = 4_000): Promise<void> {
    assertNonNegativeInt('timeoutMs', timeoutMs)
    let pendingRuns = this.runs.size + this.pendingDisposals.size
    const disposals = [
      ...this.pendingDisposals,
      ...[...this.runs.values()].map(run => Promise.resolve(run.dispose())),
    ].map(disposal => disposal.then(
      () => { pendingRuns -= 1 },
      error => {
        pendingRuns -= 1
        throw error
      },
    ))
    this.runs.clear()
    if (disposals.length === 0) {
      this.throwAndDrainDisposalFailures()
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RunShutdownTimeoutError(timeoutMs, pendingRuns)), timeoutMs)
      timer.unref?.()
    })
    let settled: PromiseSettledResult<void>[]
    try {
      settled = await Promise.race([Promise.allSettled(disposals), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    const currentFailures = settled.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
    this.throwAndDrainDisposalFailures(currentFailures)
  }

  private throwAndDrainDisposalFailures(current: readonly unknown[] = []): void {
    const failures = [...this.disposalFailures.splice(0), ...current]
      .filter((failure, index, all) => all.indexOf(failure) === index)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'one or more run cleanups failed')
  }
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}

function runtimeEventId(runId: string, sequence: number): string {
  const candidate = `${runId}:${sequence}`
  return candidate.length <= 512
    ? candidate
    : `event:${canonicalCandidateDigest({ runId, sequence }).slice('sha256:'.length)}`
}
