import { z } from 'zod'
import type {
  AgentEnvironmentCapabilities,
  InteractionAcknowledgement,
  RuntimeEventEnvelope,
} from '@tangle-network/agent-interface'
import type { RetainedJailPolicy } from '../jail/resolve-spec.js'

export type { RetainedJailPolicy }

export interface SessionRecord {
  externalId: string
  backend: string
  internalId: string
  cwd: string | null
  turns: number
  createdAt: number
  lastUsedAt: number
  metadata: Record<string, unknown>
}
export type RetainedSessionStatus = 'created' | 'idle' | 'running' | 'completed' | 'cancelled' | 'closed' | 'unknown'
export interface RetainedSessionRecord {
  id: string
  createRequestDigest: string
  backend: string
  model: string
  cwd: string | null
  turns: number
  status: RetainedSessionStatus
  runId: string | null
  internalId: string | null
  createdAt: number
  lastUsedAt: number
  metadata: Record<string, unknown>
  capabilities: AgentEnvironmentCapabilities
  profileMaterializationReceipt: Record<string, unknown> | null
  contextBoundary: Record<string, unknown> | null
  jailPolicy: RetainedJailPolicy | null
}
export interface RetainedEventRecord { sessionId: string; sessionSequence: number; envelope: RuntimeEventEnvelope }
export interface RetainedRunAdmission {
  runId: string
  sessionId: string
  executionId: string
  requestDigest: string
  snapshot: unknown
  createdAt: number
  updatedAt: number
}
export type RetainedRunClaim =
  | { kind: 'created' | 'replayed'; admission: RetainedRunAdmission }
  | { kind: 'conflict'; admission: RetainedRunAdmission }
export interface StoredInteractionOperation {
  operationId: string
  callerId: string
  runId: string
  sessionId: string
  interactionId: string
  requestDigest: string
  acknowledgement: InteractionAcknowledgement
  phase?: 'pending' | 'settled'
}
export type RetainedControlOperationKind = 'steer' | 'cancel'
export interface StoredRetainedControlOperation {
  operationId: string
  callerId: string
  kind: RetainedControlOperationKind
  runId: string
  sessionId: string
  requestDigest: string
  acknowledgement: Record<string, unknown>
}
export interface SessionExecutionLease { release(): void }
export interface SessionExecutionWaiter {
  readonly signal?: AbortSignal
  readonly resolve: (lease: SessionExecutionLease) => void
  readonly reject: (error: SessionExecutionAbortedError) => void
  onAbort?: () => void
}
export interface SessionExecutionLane { readonly waiters: SessionExecutionWaiter[] }

const retainedMetadataShape = z.strictObject({
  label: z.string().min(1).max(256).optional(),
  description: z.string().max(2_048).optional(),
  client: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  interaction_policy: z.enum(['interactive']).optional(),
  retained_input_presence: z.strictObject({ agent_profile: z.boolean().optional(), mcp: z.boolean().optional() }).optional(),
})
const legacyModelMetadata = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
const legacyProfileDigestMetadata = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const secretShapedValue = /(?:bearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+|(?:sk|rk|pk|ghp|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}|-----BEGIN [^-]+ PRIVATE KEY-----)/iu
function containsSecretShapedValue(value: unknown): boolean {
  if (typeof value === 'string') return secretShapedValue.test(value)
  if (Array.isArray(value)) return value.some(containsSecretShapedValue)
  if (value && typeof value === 'object') return Object.values(value).some(containsSecretShapedValue)
  return false
}
export function sanitizeLegacySessionMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>; const metadata: Record<string, unknown> = {}
  const model = legacyModelMetadata.safeParse(source.model); if (model.success && !containsSecretShapedValue(model.data)) metadata.model = model.data
  const profileDigest = legacyProfileDigestMetadata.safeParse(source.profile_digest); if (profileDigest.success) metadata.profile_digest = profileDigest.data
  return metadata
}
export function parseSafeRetainedMetadata(value: unknown): Record<string, unknown> {
  const parsed = retainedMetadataShape.safeParse(value ?? {})
  if (!parsed.success) throw new Error(`retained metadata contains unsupported keys or values: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  if (containsSecretShapedValue(parsed.data)) throw new Error('retained metadata contains a secret-shaped value')
  return parsed.data as Record<string, unknown>
}
export class SessionExecutionAbortedError extends Error {
  constructor() { super('session execution was cancelled while waiting for the previous turn'); this.name = 'SessionExecutionAbortedError' }
}
export class SessionIdentityConflictError extends Error {
  readonly code = 'session_identity_conflict' as const
  constructor(public readonly sessionId: string, public readonly expectedKind: 'legacy' | 'retained', public readonly existingKind: 'legacy' | 'retained') {
    super(`session id ${JSON.stringify(sessionId)} is already owned by the ${existingKind} session API and cannot be used by the ${expectedKind} session API`)
    this.name = 'SessionIdentityConflictError'
  }
}

export interface ExpectedColumn { name: string; type: string; notnull: number; defaultValue: string | null; pk: number }
export const EXPECTED_SESSION_SCHEMA: Record<string, ExpectedColumn[]> = {
  session_identities: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 }, { name: 'kind', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
  sessions: [
    { name: 'external_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 1 }, { name: 'backend', type: 'TEXT', notnull: 1, defaultValue: null, pk: 2 }, { name: 'internal_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'cwd', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'turns', type: 'INTEGER', notnull: 1, defaultValue: '0', pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'last_used_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'metadata_json', type: 'TEXT', notnull: 1, defaultValue: "'{}'", pk: 0 },
  ],
  retained_sessions: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 }, { name: 'create_request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'backend', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'model', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'cwd', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'turns', type: 'INTEGER', notnull: 1, defaultValue: '0', pk: 0 }, { name: 'status', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'run_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'internal_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'last_used_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'metadata_json', type: 'TEXT', notnull: 1, defaultValue: "'{}'", pk: 0 }, { name: 'capabilities_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'profile_receipt_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'context_boundary_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'jail_policy_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
  ],
  retained_events: [
    { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 1 }, { name: 'session_sequence', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 2 }, { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'sequence', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'event_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'cursor', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'occurred_at', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 }, { name: 'received_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'event_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  ],
  retained_run_admissions: [
    { name: 'run_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 }, { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'execution_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'snapshot_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 }, { name: 'updated_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
  interaction_operations: [
    { name: 'operation_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 }, { name: 'caller_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'interaction_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'acknowledgement_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'phase', type: 'TEXT', notnull: 1, defaultValue: "'settled'", pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
  retained_control_operations: [
    { name: 'operation_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 }, { name: 'caller_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'kind', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'acknowledgement_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 }, { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
}
export const EXPECTED_NAMED_INDEXES: Record<string, Record<string, string[]>> = {
  sessions: { idx_sessions_last_used: ['last_used_at'] }, retained_sessions: { idx_retained_sessions_last_used: ['last_used_at'] }, retained_events: { idx_retained_events_session_cursor: ['session_id', 'session_sequence'] }, retained_run_admissions: { idx_retained_run_admissions_session: ['session_id', 'created_at'] },
}
export const RETAINED_SCHEMA_ERROR = 'incompatible retained-session data schema; use a fresh data directory for this unreleased format'
