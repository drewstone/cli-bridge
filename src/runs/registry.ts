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
import { describeRunFailure } from './error-shape.js'

/** A buffered delta plus its per-run monotonic sequence number. */
export interface SeqDelta {
  seq: number
  delta: ChatDelta
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
}

/** One durable server-owned backend job and its bounded replay log. */
export class Run {
  readonly startedAt = Date.now()
  private readonly buffer: SeqDelta[] = []
  private seq = 0
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

  /** Consume the backend exactly once, independently from attached readers. */
  pump(source: AsyncIterable<ChatDelta>): Promise<void> {
    if (this.settled) return this.settled
    this.settled = (async () => {
      try {
        let outcome: 'done' | 'error' = 'done'
        for await (const delta of source) {
          this.append(delta)
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
    this.replayTimer = null
    this.identityTimer = null
    this.disposed = true
    this.replayExpired = true
    this.buffer.length = 0
    this.wakeAll()
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
