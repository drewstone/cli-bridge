/** Typed refusals a durable run raises to its callers. */

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

export class RunLifetimeExceededError extends Error {
  readonly code = 'run_lifetime_exceeded' as const

  constructor(readonly runId: string, readonly maxLifetimeMs: number) {
    super(
      `run ${JSON.stringify(runId)} did not reach a terminal state within ${maxLifetimeMs}ms `
      + 'and was cancelled so its output and its execution slot could be released',
    )
    this.name = 'RunLifetimeExceededError'
  }
}
