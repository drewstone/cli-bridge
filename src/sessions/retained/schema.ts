/**
 * Wire contract for retained-session requests.
 *
 * Every parse fails closed with the exact reason: a retained resource needs a
 * caller-owned stable id, a turn needs a stable run id, and steer/cancel need
 * an exact run reference. Minting a missing id here would make a retry look
 * like a new turn.
 */

import { z } from 'zod'
import {
  AgentRunControlRefSchema,
  AgentRunCancellationRequestSchema,
  type AgentRunCancellationRequest,
  type AgentRunControlRef,
  normalizeInputParts,
  renderInputPartsAsText,
} from '@tangle-network/agent-interface'
import { RetainedSessionError } from './types.js'

// Retained resource and caller run ids use the public stable-id contract.
// URL-safe routing is handled by the HTTP client through path escaping; the
// contract itself does not add a private ASCII-only restriction.
const idSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, 'identifier cannot have outer whitespace')

const createSchema = z.strictObject({
  id: idSchema.optional(),
  session_id: idSchema.optional(),
  model: z.string().min(1),
  cwd: z.string().optional(),
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  interaction_policy: z.enum(['interactive', 'unattended-deny', 'unattended-allow']).optional(),
  agent_profile: z.unknown().optional(),
  mcp: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const retainedTextPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1),
})

const turnSchema = z.strictObject({
  message: z.string().min(1).optional(),
  parts: z.array(retainedTextPartSchema).min(1).optional(),
  turn_id: idSchema.optional(),
  execution_id: idSchema.optional(),
  run_id: idSchema.optional(),
})

const steerSchema = z.strictObject({
  operationId: idSchema,
  run: z.unknown(),
  message: z.string().min(1),
})

export type RetainedCreateInput = z.infer<typeof createSchema>
export type RetainedTurnInput = z.infer<typeof turnSchema>

export function parseCreate(value: unknown): RetainedCreateInput {
  const parsed = createSchema.safeParse(value)
  if (!parsed.success)
    throw new RetainedSessionError('invalid retained-session creation request', 400, 'invalid_request_error')
  if (parsed.data.id && parsed.data.session_id && parsed.data.id !== parsed.data.session_id) {
    throw new RetainedSessionError('id and session_id must match when both are supplied', 400, 'invalid_request_error')
  }
  if (!parsed.data.id && !parsed.data.session_id) {
    throw new RetainedSessionError(
      'retained-session creation requires a stable id or session_id',
      400,
      'invalid_request_error',
    )
  }
  return parsed.data
}

export function parseTurn(value: unknown): RetainedTurnInput {
  const parsed = turnSchema.safeParse(value)
  if (!parsed.success)
    throw new RetainedSessionError('invalid retained-session turn request', 400, 'invalid_request_error')
  if (!parsed.data.message && (!parsed.data.parts || parsed.data.parts.length === 0)) {
    throw new RetainedSessionError('turn requires a non-empty message or parts', 400, 'invalid_request_error')
  }
  if (!parsed.data.run_id) {
    throw new RetainedSessionError('retained turns require a stable run_id', 400, 'invalid_request_error')
  }
  return parsed.data
}

export function parseSteer(value: unknown): { operationId: string; message: string; run: AgentRunControlRef } {
  const parsed = steerSchema.safeParse(value)
  const run = parsed.success ? AgentRunControlRefSchema.safeParse(parsed.data.run) : null
  if (!parsed.success || !run?.success || !run.data.sessionId || !run.data.executionId || !run.data.requestDigest) {
    throw new RetainedSessionError(
      'steer requires operationId, message, and an exact run reference with sessionId, executionId, and requestDigest',
      400,
      'invalid_request_error',
    )
  }
  return { operationId: parsed.data.operationId, message: parsed.data.message, run: run.data }
}

export function parseCancel(value: unknown): AgentRunCancellationRequest {
  const parsed = AgentRunCancellationRequestSchema.safeParse(value)
  if (!parsed.success)
    throw new RetainedSessionError('cancel requires an exact digest-bound run request', 400, 'invalid_request_error')
  if (!parsed.data.run.requestDigest) {
    throw new RetainedSessionError(
      'retained cancellation requires the admitted run request digest',
      400,
      'invalid_request_error',
    )
  }
  return parsed.data
}

export function renderTurnInput(input: RetainedTurnInput): string {
  return renderInputPartsAsText(
    normalizeInputParts({
      message: input.message,
      parts: input.parts,
    }),
  )
}
