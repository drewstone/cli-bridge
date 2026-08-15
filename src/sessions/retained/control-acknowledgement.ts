/**
 * How a control operation reports what it actually did.
 *
 * `effect_unknown` is a real outcome, not a fallback: when the bridge cannot
 * prove whether a steer or cancel took effect it says so and marks the
 * operation non-retryable, because repeating an operation whose side effect
 * may already have landed is worse than reporting the uncertainty.
 */

import {
  AgentRunCancellationAcknowledgementSchema,
  agentRunCancellationAcknowledgementMatchesRequest,
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
} from '@tangle-network/agent-interface'
import { RetainedSessionError, type RetainedControlAcknowledgement } from './types.js'

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

/** Render the internal acknowledgement as the wire cancellation contract. */
export function retainedCancellationAcknowledgement(
  request: AgentRunCancellationRequest,
  internal: RetainedControlAcknowledgement,
): AgentRunCancellationAcknowledgement {
  const outcome =
    internal.status === 'cancelled'
      ? { status: 'accepted' as const, effect: 'cancelled' as const }
      : internal.status === 'already_terminal'
        ? { status: 'accepted' as const, effect: 'not_live' as const }
        : internal.status === 'accepted' || internal.status === 'pending'
          ? { status: 'accepted' as const, effect: 'cancel_requested' as const }
          : internal.status === 'conflict'
            ? { status: 'conflict' as const, effect: 'unknown' as const }
            : { status: 'unknown' as const, effect: 'unknown' as const }
  const acknowledgement = AgentRunCancellationAcknowledgementSchema.parse({
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    run: request.run,
    ...outcome,
    ...(internal.message ? { message: internal.message } : {}),
    ...(internal.retryable !== undefined ? { retryable: internal.retryable } : {}),
    ...(internal.existingRequestDigest ? { existingRequestDigest: internal.existingRequestDigest } : {}),
  })
  if (!agentRunCancellationAcknowledgementMatchesRequest(request, acknowledgement)) {
    throw new RetainedSessionError(
      'retained cancellation acknowledgement changed its exact request binding',
      500,
      'server_error',
    )
  }
  return acknowledgement
}
