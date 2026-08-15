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

import type { ChatDelta, ProfileMaterializationReceipt } from '../backends/types.js'
import { BackendReportedFailureError, describeRunFailure, reasonForTerminalDelta } from './error-shape.js'

/** A buffered delta plus its per-run monotonic sequence number. */
export interface SeqDelta {
  seq: number
  delta: ChatDelta
}

/** A buffered delta with the byte cost charged against the replay budget. */
interface BufferedDelta extends SeqDelta {
  bytes: number
}

/** Existing completion outcome. `running` means no outcome exists yet. */
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled'

/** Connection/process lifecycle, separate from the terminal outcome. */
export type RunState = 'detached' | 'running' | 'cancelling' | 'terminal'

export interface RunReplayWindow {
  /** Lowest event still replayable. A cursor of `firstAvailableSeq - 1` is valid. */
  firstAvailableSeq: number
  lastSeq: number
  retainedDeltas: number
  maxRetainedDeltas: number
  /** Approximate bytes of delta payload currently retained. */
  retainedBytes: number
  /** Ceiling on `retainedBytes`; the oldest deltas are dropped to stay under it. */
  maxRetainedBytes: number
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
  /**
   * When an unsettled run is forced terminal. Null once terminal, and null when
   * no ceiling is configured.
   */
  lifetimeExpiresAt: number | null
  /** Exact profile acknowledgment retained for the full run-identity lifetime. */
  profileMaterialization: ProfileMaterializationReceipt | null
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

interface Waiter {
  resolve: () => void
}

interface RunRetention {
  replayRetentionMs: number
  identityRetentionMs: number
  maxReplayDeltas: number
  maxReplayBytes: number
  maxLifetimeMs: number
}

/** A run outlived the ceiling on how long it may stay unsettled. */
export class RunLifetimeExceededError extends Error {
  readonly code = 'run_lifetime_exceeded' as const

  constructor(readonly runId: string, readonly maxLifetimeMs: number) {
    super(
      `run ${JSON.stringify(runId)} did not reach a terminal state within ${maxLifetimeMs}ms ` +
      'and was cancelled so its output and its execution slot could be released',
    )
    this.name = 'RunLifetimeExceededError'
  }
}

/**
 * Approximate heap cost of one delta's payload.
 *
 * Summed from the fields that carry caller- or backend-sized data rather than
 * serialized, because serializing every delta to measure it would allocate a
 * second copy of the exact thing the budget exists to bound. Fixed-size
 * scalars are covered by `DELTA_OVERHEAD_BYTES`, so the estimate is never zero
 * and a flood of tiny deltas is still charged for the objects it creates.
 */
const DELTA_OVERHEAD_BYTES = 128

function deltaBytes(delta: ChatDelta): number {
  let bytes = DELTA_OVERHEAD_BYTES
  if (delta.content) bytes += delta.content.length
  if (delta.model) bytes += delta.model.length
  if (delta.system_fingerprint) bytes += delta.system_fingerprint.length
  if (delta.error) bytes += delta.error.message.length + delta.error.type.length
  for (const call of delta.tool_calls ?? []) {
    bytes += DELTA_OVERHEAD_BYTES + call.id.length + call.name.length + call.arguments.length
  }
  if (delta.internal_session_id) bytes += delta.internal_session_id.length
  // A materialization receipt is retained separately for the identity lifetime;
  // charge the buffered copy so a receipt-carrying stream cannot evade the cap.
  if (delta.profile_materialization) {
    bytes += JSON.stringify(delta.profile_materialization).length
  }
  return bytes
}

/** One durable server-owned backend job and its bounded replay log. */
export class Run {
  readonly startedAt = Date.now()
  private readonly buffer: BufferedDelta[] = []
  private bufferBytes = 0
  private seq = 0
  private status: RunStatus = 'running'
  private endedAt: number | null = null
  private attachedReaders = 0
  private cancelRequestedAt: number | null = null
  private replayExpiresAt: number | null = null
  private identityExpiresAt: number | null = null
  private replayExpired = false
  private profileMaterialization: ProfileMaterializationReceipt | null = null
  private readonly waiters = new Set<Waiter>()
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private identityTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Armed at construction, not at `finish()`.
   *
   * Every other bound this class has is armed BY reaching a terminal state, so
   * a backend that never terminates kept its replay buffer, its registry entry
   * and its admission slot for the life of the process. Arming this one at
   * claim time is what makes "a claimed run is always released" true without
   * depending on the backend behaving.
   */
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

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
  ) {
    if (retention.maxLifetimeMs > 0) {
      this.lifetimeTimer = setTimeout(() => this.expireLifetime(), retention.maxLifetimeMs)
      this.lifetimeTimer.unref?.()
    }
  }

  /**
   * Force an unsettled run terminal so the retention path can release it.
   *
   * The run is cancelled rather than dropped: the backend job is real and still
   * holds a subprocess and an admission slot, and forgetting the record without
   * stopping the work would leak both while also destroying the only evidence
   * that the run existed. `failSetup` records the reason so a caller that later
   * reads the run learns why it ended instead of seeing an empty completion.
   */
  private expireLifetime(): void {
    this.lifetimeTimer = null
    if (this.isTerminal() || this.disposed) return
    const error = new RunLifetimeExceededError(this.id, this.retention.maxLifetimeMs)
    this.failureError = error
    if (this.seq === 0) this.setupError = error
    this.ac.abort()
    this.append({ finish_reason: 'error', error: describeRunFailure(error) })
    this.finish('error')
    console.error(`[cli-bridge] ${error.message}`)
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
      attachedReaders: this.attachedReaders,
      cancelRequestedAt: this.cancelRequestedAt,
      lastSeq: this.seq,
      replay: {
        firstAvailableSeq: this.firstAvailableSeq(),
        lastSeq: this.seq,
        retainedDeltas: this.buffer.length,
        maxRetainedDeltas: this.retention.maxReplayDeltas,
        retainedBytes: this.bufferBytes,
        maxRetainedBytes: this.retention.maxReplayBytes,
        expiresAt: this.replayExpiresAt,
        expired: this.replayExpired,
      },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      identityExpiresAt: this.identityExpiresAt,
      lifetimeExpiresAt: this.isTerminal() || this.retention.maxLifetimeMs === 0
        ? null
        : this.startedAt + this.retention.maxLifetimeMs,
      profileMaterialization: this.profileMaterialization
        ? structuredClone(this.profileMaterialization)
        : null,
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
  pump(
    source: AsyncIterable<ChatDelta>,
    opts?: {
      /**
       * The profile-materialization receipt the request's backend retained, if
       * any, read at failure time. A backend that THROWS (subprocess exited
       * nonzero) never reaches the stream position where the receipt is
       * normally emitted, yet materialization already happened before spawn —
       * so the run must still acknowledge it ahead of the synthesized terminal
       * error. Without it, a profile-carrying caller (agent-runtime's bridge
       * executor) classifies the whole failure as "completed without receipt"
       * transport trouble and the real error message is masked.
       */
      terminalReceipt?: () => ProfileMaterializationReceipt | undefined
    },
  ): Promise<void> {
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
          // Acknowledged on its OWN event: the SSE writer renders the error
          // terminal as a bare `{error}` frame and the caller's parser reads
          // nothing else from it, so the receipt must precede it in the buffer
          // under its own seq. `setupError` was recorded above, so this extra
          // event never turns a pre-output failure into a 200.
          const receipt = opts?.terminalReceipt?.()
          if (receipt && this.profileMaterialization === null) {
            this.append({ profile_materialization: receipt })
          }
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
    this.cancelRequestedAt = Date.now()
    this.ac.abort()
    this.wakeAll()
    return true
  }

  /** Cancel and forget immediately during bridge shutdown/tests. */
  dispose(): void {
    if (this.disposed) return
    if (!this.isTerminal()) {
      if (this.cancelRequestedAt === null) this.cancelRequestedAt = Date.now()
      this.ac.abort()
      this.status = 'cancelled'
      this.endedAt = Date.now()
    }
    if (this.replayTimer) clearTimeout(this.replayTimer)
    if (this.identityTimer) clearTimeout(this.identityTimer)
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer)
    this.replayTimer = null
    this.identityTimer = null
    this.lifetimeTimer = null
    this.disposed = true
    this.replayExpired = true
    this.buffer.length = 0
    this.bufferBytes = 0
    this.profileMaterialization = null
    this.wakeAll()
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
      this.failureError = new BackendReportedFailureError(reason.message, reason.type, {
        ...(reason.provider_dispatch === undefined
          ? {}
          : { providerDispatch: reason.provider_dispatch }),
      })
    }
    return { ...delta, error: reason }
  }

  private append(delta: ChatDelta): void {
    let committed = delta
    if (delta.profile_materialization) {
      const receipt = structuredClone(delta.profile_materialization)
      if (
        this.profileMaterialization
        && JSON.stringify(this.profileMaterialization) !== JSON.stringify(receipt)
      ) {
        throw new Error(`run ${JSON.stringify(this.id)} emitted conflicting profile materialization receipts`)
      }
      this.profileMaterialization = receipt
      committed = { ...delta, profile_materialization: receipt }
    }
    this.seq += 1
    const bytes = deltaBytes(committed)
    this.buffer.push({ seq: this.seq, delta: committed, bytes })
    this.bufferBytes += bytes
    // Two ceilings, because one of them alone is not a memory bound. The delta
    // COUNT cap was the only ceiling, and a backend that emits large deltas —
    // a tool result, a file read, a whole message — filled 10,000 slots with
    // payloads of any size, so the retained heap was bounded by nothing.
    while (this.buffer.length > this.retention.maxReplayDeltas) this.evictOldest()
    while (this.buffer.length > 1 && this.bufferBytes > this.retention.maxReplayBytes) {
      this.evictOldest()
    }
    this.wakeAll()
  }

  /**
   * Drop the oldest retained delta. The last delta is never evicted by the byte
   * budget: a single delta larger than the whole budget would otherwise empty
   * the buffer and leave a reader that is exactly caught up unable to resume.
   */
  private evictOldest(): void {
    const dropped = this.buffer.shift()
    if (dropped) this.bufferBytes -= dropped.bytes
  }

  private firstAvailableSeq(): number {
    return this.buffer[0]?.seq ?? this.seq + 1
  }

  private finish(status: Exclude<RunStatus, 'running'>): void {
    if (this.isTerminal() || this.disposed) return
    // The run settled on its own; the ceiling has nothing left to enforce.
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer)
      this.lifetimeTimer = null
    }
    this.status = status
    this.endedAt = Date.now()
    this.replayExpiresAt = this.endedAt + this.retention.replayRetentionMs
    this.identityExpiresAt = this.endedAt + this.retention.identityRetentionMs
    this.wakeAll()
    this.scheduleRetentionTimers()
  }

  private scheduleRetentionTimers(): void {
    if (this.replayTimer || this.identityTimer) return
    this.replayTimer = setTimeout(() => {
      this.replayExpired = true
      this.buffer.length = 0
      this.bufferBytes = 0
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
  /**
   * Approximate ceiling on retained delta payload per run. Default 32 MiB.
   *
   * `maxReplayDeltas` bounds how MANY deltas are kept; this bounds how much
   * they may weigh. Without it a run's retained heap is the delta count times
   * whatever the backend chose to emit, which is not a bound.
   */
  maxReplayBytes?: number
  /**
   * Ceiling on how long a run may stay unsettled before it is cancelled and
   * released. Default 6 hours. 0 disables the ceiling and restores the previous
   * behavior, in which a backend that never terminates is never released.
   */
  maxLifetimeMs?: number
}

/** Process-wide, bounded durable-run registry keyed by caller-owned run id. */
export class RunRegistry {
  private readonly runs = new Map<string, Run>()
  private readonly retention: RunRetention

  constructor(opts: RunRegistryOptions = {}) {
    const replayRetentionMs = opts.replayRetentionMs ?? opts.reapDelayMs ?? 60_000
    const identityRetentionMs = opts.identityRetentionMs ?? 86_400_000
    const maxReplayDeltas = opts.maxReplayDeltas ?? 10_000
    const maxReplayBytes = opts.maxReplayBytes ?? 32 * 1024 * 1024
    const maxLifetimeMs = opts.maxLifetimeMs ?? 21_600_000
    assertNonNegativeInt('replayRetentionMs', replayRetentionMs)
    assertNonNegativeInt('identityRetentionMs', identityRetentionMs)
    assertNonNegativeInt('maxLifetimeMs', maxLifetimeMs)
    if (identityRetentionMs < replayRetentionMs) {
      throw new Error('identityRetentionMs must be greater than or equal to replayRetentionMs')
    }
    if (!Number.isSafeInteger(maxReplayDeltas) || maxReplayDeltas < 1) {
      throw new Error('maxReplayDeltas must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes < 1) {
      throw new Error('maxReplayBytes must be a positive safe integer')
    }
    this.retention = {
      replayRetentionMs,
      identityRetentionMs,
      maxReplayDeltas,
      maxReplayBytes,
      maxLifetimeMs,
    }
  }

  /** Runs currently retained, live or awaiting identity expiry. For /health. */
  size(): number {
    return this.runs.size
  }

  /** Approximate retained delta payload across every run. For /health. */
  retainedBytes(): number {
    let bytes = 0
    for (const run of this.runs.values()) bytes += run.snapshot().replay.retainedBytes
    return bytes
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /**
   * Atomically bind one run id to one normalized execution request. The
   * creator alone performs admission/setup; racing identical requests attach.
   */
  claim(id: string, requestDigest: string): { readonly run: Run; readonly created: boolean } {
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
    )
    this.runs.set(id, run)
    return { run, created: true }
  }

  /** Request cancellation once. False means unknown, terminal, or already cancelling. */
  cancel(id: string): boolean {
    return this.runs.get(id)?.cancel() ?? false
  }

  private forget(id: string, expected: Run): void {
    if (this.runs.get(id) !== expected) return
    this.runs.delete(id)
    expected.dispose()
  }

  /** Test/shutdown aid — cancel and forget every run. */
  clear(): void {
    for (const run of this.runs.values()) run.dispose()
    this.runs.clear()
  }
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}
