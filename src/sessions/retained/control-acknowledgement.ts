import type { RetainedControlAcknowledgement } from './types.js'

/**
 * How a control operation reports what it actually did.
 *
 * `effect_unknown` is a real outcome, not a fallback: when the bridge cannot
 * prove whether a steer or cancel took effect it says so and marks the
 * operation non-retryable, because repeating an operation whose side effect
 * may already have landed is worse than reporting the uncertainty.
 */

export function controlConflict(
  operationId: string,
  kind: 'steer' | 'cancel',
  sessionId: string,
  runId: string,
  existingRequestDigest?: `sha256:${string}`,
): RetainedControlAcknowledgement {
  return {
    operationId,
    kind,
    sessionId,
    runId,
    status: 'conflict',
    message: 'operation id was already used with a different caller or request',
    retryable: false,
    ...(existingRequestDigest ? { existingRequestDigest } : {}),
  }
}

export function statusForControlAcknowledgement(acknowledgement: RetainedControlAcknowledgement): number {
  if (acknowledgement.status === 'unknown_run') return 404
  if (acknowledgement.status === 'capability_denied') return 501
  if (acknowledgement.status === 'effect_unknown') return 502
  if (acknowledgement.status === 'conflict') return 409
  if (acknowledgement.status === 'pending') return 202
  return 200
}
