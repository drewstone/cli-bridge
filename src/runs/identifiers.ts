import { AgentRunControlRefSchema } from '@tangle-network/agent-interface'
import { z } from 'zod'

/**
 * Agent Interface owns identifier length and whitespace rules.
 * The bridge adds only the HTTP-header safety rule at this boundary.
 */
const agentIdentifierSchema = AgentRunControlRefSchema.shape.runId
const unsafeControlCharacter = /[\u0000-\u001f\u007f-\u009f]/u

/** Agent Interface owns the canonical bounds; this schema adds header safety. */
export const wireIdentifierSchema = z.custom<string>(
  (value) => typeof value === 'string'
    && agentIdentifierSchema.safeParse(value).success
    && !unsafeControlCharacter.test(value),
  { message: 'identifier must be a bounded value without control characters' },
)

export function isSafeWireIdentifier(value: unknown): value is string {
  return wireIdentifierSchema.safeParse(value).success
}
