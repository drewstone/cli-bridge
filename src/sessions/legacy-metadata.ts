import { z } from 'zod'
import {
  containsCredentialBearingKey, containsSecretShapedValue,
  parseSafeRetainedMcp, parseSafeRetainedEnv, retainedPublicRecordSchema, snapshotRetainedAgentProfile,
} from './retained/contract.js'
import type { ChatRequest } from '../backends/types.js'
import type { SessionProfileBinding } from './store.js'

/** Resume authority shared by admission and native session updates. */
export function legacyRequestMetadata(req: ChatRequest, request: Record<string, unknown>, binding: SessionProfileBinding | null): Record<string, unknown> {
  return {
    ...(Object.keys(request).length > 0 ? { request_metadata: request } : {}),
    model: req.model,
    ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
    ...(binding ? { agent_profile_binding: binding } : {}),
    ...(req.execution ? { execution: req.execution } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.context ? { context: req.context } : {}),
    ...(req.providerOptions ? { provider_options: req.providerOptions } : {}),
    ...(req.mcp ? { mcp: req.mcp } : {}),
    ...(req.profile_materialization_receipt ? { profile_materialization: req.profile_materialization_receipt } : {}),
  }
}

const legacyModelMetadata = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
const legacyProfileDigestMetadata = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

/** Nonsecret continuity proof; private values and their fingerprints never enter durable metadata. */
export const nativeRedactionHistorySchema = z.strictObject({
  schema: z.literal('cli-bridge.native-redaction-history.v1'),
  protectedHistory: z.boolean(),
  epoch: z.uuid(),
  runId: z.string().min(1),
  requestDigest: legacyProfileDigestMetadata,
  sessionId: z.string().min(1),
  profileDigest: legacyProfileDigestMetadata.nullable(),
  cwd: z.string().nullable(),
})

/** Keep only non-secret legacy resume hints; request inputs never cross this boundary. */
export function sanitizeLegacySessionMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const metadata: Record<string, unknown> = {}
  const model = legacyModelMetadata.safeParse(source.model)
  if (model.success && !containsSecretShapedValue(model.data)) metadata.model = model.data
  const profileDigest = legacyProfileDigestMetadata.safeParse(source.profile_digest)
  if (profileDigest.success) metadata.profile_digest = profileDigest.data
  const nativeHistory = nativeRedactionHistorySchema.safeParse(source.native_redaction_history)
  if (nativeHistory.success) metadata.native_redaction_history = nativeHistory.data
  for (const key of ['agent_profile', 'agent_profile_binding', 'profile_materialization', 'effective_native_store'] as const) {
    const value = source[key]
    if (key === 'agent_profile' && value !== undefined) {
      try {
        metadata[key] = snapshotRetainedAgentProfile(value)
      } catch {
        // Unsafe legacy profiles are omitted before they can be replayed.
      }
      continue
    }
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && !containsCredentialBearingKey(value)
      && !containsSecretShapedValue(value)
    ) {
      metadata[key] = value
    }
  }
  for (const key of ['execution', 'env', 'mcp', 'context', 'provider_options', 'metadata', 'request_metadata'] as const) {
    const candidate = source[key]
    if (key === 'env' && candidate !== undefined) {
      try {
        { const parsedEnv = parseSafeRetainedEnv(candidate); if (parsedEnv) metadata.env = parsedEnv }
      } catch {
        // Unsafe legacy environment values are omitted before they can be replayed.
      }
      continue
    }
    if (key === 'mcp' && candidate !== undefined) {
      try {
        metadata.mcp = parseSafeRetainedMcp(candidate, 'legacy MCP configuration')
      } catch {
        // Unsafe legacy MCP configuration is omitted before it can be replayed.
      }
      continue
    }
    const parsed = retainedPublicRecordSchema.safeParse(candidate)
    if (
      parsed.success
      && !containsCredentialBearingKey(parsed.data)
      && !containsSecretShapedValue(parsed.data)
    ) metadata[key] = parsed.data
  }
  return metadata
}
