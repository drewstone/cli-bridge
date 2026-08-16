/**
 * Durable run registry — one server-owned job can outlive any individual
 * HTTP reader. A run id is bound to one normalized request, output is
 * sequence-numbered for replay, and only explicit cancellation aborts the
 * backend job.
 *
 * This is deliberately process-local. A bridge restart loses active jobs
 * and their identity records, so a caller that sees 404 after reconnect
 * must treat the old job as unknown rather than proven stopped.
 *
 * The run itself, its replay log, its native-control lane, and its
 * interaction ledger live in siblings of this module; this file owns the
 * process-wide id table and the shutdown contract.
 */

import type { NativeSession } from '../backends/types.js'
import { RunAdmission } from './admission.js'
import { RunIdentityConflictError, RunShutdownTimeoutError } from './errors.js'
import { Run } from './run.js'
import type { RunClaimOptions, RunOwner, RunRetention } from './types.js'

export { RunAdmissionClosedError } from './admission.js'
export { Run } from './run.js'
export {
  RunIdentityConflictError,
  RunInteractionCancelledError,
  RunLifetimeExceededError,
  RunReplayCursorError,
  RunShutdownTimeoutError,
} from './errors.js'
export type { RunReplayCursorErrorReason } from './errors.js'
export type {
  CanonicalEventInput,
  CanonicalEventListener,
  PendingRunInteraction,
  RunClaimOptions,
  RunReplayWindow,
  RunRetention,
  RunSnapshot,
  RunOwner,
  RunState,
  RunStatus,
  SeqCanonicalEvent,
  SeqDelta,
} from './types.js'

export interface RunRegistryOptions {
  /** Terminal output replay lifetime. Default 60 seconds. */
  replayRetentionMs?: number
  /** Backward-compatible alias for `replayRetentionMs`. */
  reapDelayMs?: number
  /** Run-id/request binding lifetime after terminal. Default 24 hours. */
  identityRetentionMs?: number
  /** Maximum deltas retained per live or terminal run. Default 10,000. */
  maxReplayDeltas?: number
  /** Approximate delta payload ceiling per run. Default 32 MiB. */
  maxReplayBytes?: number
  /** Maximum unsettled run lifetime. Default 6 hours; 0 disables it. */
  maxLifetimeMs?: number
}

/** Process-wide, bounded durable-run registry keyed by caller-owned run id. */
export class RunRegistry {
  private readonly runs = new Map<string, Run>()
  /** Runs removed from public lookup but still owned until cleanup succeeds. */
  private readonly retiredRuns = new Set<Run>()
  private readonly pendingDisposals = new Map<Run, Promise<void>>()
  private readonly admission = new RunAdmission()
  private readonly retention: RunRetention

  constructor(opts: RunRegistryOptions = {}) {
    const replayRetentionMs = opts.replayRetentionMs ?? opts.reapDelayMs ?? 60_000
    const identityRetentionMs = opts.identityRetentionMs ?? 86_400_000
    const maxReplayDeltas = opts.maxReplayDeltas ?? 10_000
    const maxReplayBytes = opts.maxReplayBytes ?? 32 * 1024 * 1024
    const maxLifetimeMs = opts.maxLifetimeMs ?? 21_600_000
    assertNonNegativeInt('replayRetentionMs', replayRetentionMs)
    assertNonNegativeInt('identityRetentionMs', identityRetentionMs)
    if (identityRetentionMs < replayRetentionMs) {
      throw new Error('identityRetentionMs must be greater than or equal to replayRetentionMs')
    }
    if (!Number.isSafeInteger(maxReplayDeltas) || maxReplayDeltas < 1) {
      throw new Error('maxReplayDeltas must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes < 1) {
      throw new Error('maxReplayBytes must be a positive safe integer')
    }
    assertNonNegativeInt('maxLifetimeMs', maxLifetimeMs)
    this.retention = { replayRetentionMs, identityRetentionMs, maxReplayDeltas, maxReplayBytes, maxLifetimeMs }
  }

  size(): number {
    return this.runs.size
  }

  retainedBytes(): number {
    let bytes = 0
    for (const run of this.runs.values()) bytes += run.snapshot().replay.retainedBytes
    return bytes
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /** Refuse a cross-protocol or request-digest collision before durable admission. */
  assertAvailable(id: string, requestDigest: string, owner: RunOwner = 'one-shot'): void {
    this.admission.assertOpen()
    const existing = this.runs.get(id)
    if (!existing) return
    if (existing.owner !== owner || existing.requestDigest !== requestDigest) {
      throw new RunIdentityConflictError(id, existing.requestDigest, requestDigest, existing.owner, owner)
    }
  }

  /** Refuse every later claim before shutdown snapshots owned work. */
  closeAdmission(): void {
    this.admission.close()
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
    const owner = options.owner ?? 'one-shot'
    this.assertAvailable(id, requestDigest, owner)
    const existing = this.runs.get(id)
    if (existing) return { run: existing, created: false }
    const run = new Run(
      id,
      requestDigest,
      (runId, expected) => this.forget(runId, expected),
      this.retention,
      owner,
      options.sessionId,
      options.executionId,
      options.provider,
      options.environmentId,
      options.commitCanonicalEvent,
      options.onNativeControlLost,
    )
    this.runs.set(id, run)
    return { run, created: true }
  }

  /** Release a retained claim that failed before native startup. */
  releaseClaim(id: string, run: Run): void {
    if (this.runs.get(id) !== run) return
    this.runs.delete(id)
    this.retire(run)
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

  /** Test/shutdown aid — cancel and forget every run. */
  clear(): void {
    for (const run of this.runs.values()) this.retire(run)
    this.runs.clear()
  }

  /** Stop every owned native child and wait for each executor's proof. */
  async shutdown(timeoutMs = 4_000): Promise<void> {
    assertNonNegativeInt('timeoutMs', timeoutMs)
    this.closeAdmission()
    this.clear()
    const owned = [...this.retiredRuns]
    let pendingRuns = owned.length
    const disposals = owned
      .map((run) => this.disposeRetired(run))
      .map((disposal) =>
        disposal.then(
          () => {
            pendingRuns -= 1
          },
          (error) => {
            pendingRuns -= 1
            throw error
          },
        ),
      )
    if (disposals.length === 0) return
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
    const failures = settled
      .flatMap((item) => (item.status === 'rejected' ? [item.reason] : []))
      .filter((failure, index, all) => all.indexOf(failure) === index)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'one or more run cleanups failed')
  }

  private forget(id: string, expected: Run): void {
    if (this.runs.get(id) !== expected) return
    this.runs.delete(id)
    this.retire(expected)
  }

  private retire(run: Run): void {
    this.retiredRuns.add(run)
    void this.disposeRetired(run).catch(() => {})
  }

  private disposeRetired(run: Run): Promise<void> {
    const pending = this.pendingDisposals.get(run)
    if (pending) return pending
    const disposal = Promise.resolve().then(() => run.dispose())
    this.pendingDisposals.set(run, disposal)
    void disposal.then(
      () => {
        if (this.pendingDisposals.get(run) === disposal) this.pendingDisposals.delete(run)
        this.retiredRuns.delete(run)
      },
      () => {
        if (this.pendingDisposals.get(run) === disposal) this.pendingDisposals.delete(run)
      },
    )
    return disposal
  }
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}
