/**
 * Session store — SQLite-backed mapping between a stable external
 * `session_id` the caller tracks, and a backend-internal resume id
 * (Claude's conversation uuid, Codex's session path, etc.).
 *
 * External ids are caller-owned — stable across restarts. Internal ids
 * are backend-owned — may rotate if the CLI rewrites its session file.
 * This table is the translation layer.
 *
 * Kept intentionally simple: one row per (external_id, backend). Turn
 * count + last_used drive LRU cleanup in the maintainer task.
 */

import Database from 'better-sqlite3'
import { chmodSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import type {
  AgentEnvironmentCapabilities,
  InteractionAcknowledgement,
  InteractionRequest,
  RuntimeEventEnvelope,
} from '@tangle-network/agent-interface'
import { canonicalCandidateDigest, RuntimeEventEnvelopeSchema } from '@tangle-network/agent-interface'
import type { ChatDelta } from '../backends/types.js'
import type { RunOwner } from '../runs/types.js'
import { ensurePrivateDataDirectory } from '../runtime/single-instance.js'
import {
  createInteractionOperationSchema,
  INTERACTION_OPERATION_COLUMNS,
  RetainedInteractionLedger,
  type BeginInteractionOperationInput,
  type InteractionOperationClaim,
  type RecordInteractionOperationInput,
  type RetainedInteractionPersistence,
  type StoredInteractionOperation,
} from './retained/interaction-store.js'
import {
  containsCredentialBearingKey,
  containsSecretShapedValue,
  parseSafeRetainedMetadata,
  parseSafeRetainedMcp,
  parseSafeRetainedEnv,
  retainedPublicRecordSchema,
  snapshotRetainedAgentProfile,
} from './retained/contract.js'

export { parseSafeRetainedMetadata } from './retained/contract.js'

export type {
  InteractionOperationClaim,
  InteractionOperationPhase,
  RetainedInteractionPersistence,
  StoredInteractionEffectProof,
  StoredInteractionOperation,
} from './retained/interaction-store.js'

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
}

export interface RetainedEventRecord {
  sessionId: string
  sessionSequence: number
  envelope: RuntimeEventEnvelope
}

export interface RetainedRunAdmission {
  runId: string
  owner: RunOwner
  sessionId: string
  executionId: string
  requestDigest: string
  provider: string
  environmentId: string
  snapshot: unknown
  createdAt: number
  updatedAt: number
}

export type RetainedRunClaim =
  | { kind: 'created' | 'replayed'; admission: RetainedRunAdmission }
  | { kind: 'conflict'; admission: RetainedRunAdmission }

export type RetainedControlOperationKind =
  | 'steer'
  | 'cancel'
  | 'native_continuation'
  | 'context_transfer'

export interface StoredRetainedControlOperation {
  operationId: string
  callerId: string
  kind: RetainedControlOperationKind
  runId: string
  sessionId: string
  requestDigest: string
  acknowledgement: Record<string, unknown>
}

export type ContextTransferOperationClaim =
  | { kind: 'created' | 'existing'; operation: StoredRetainedControlOperation }
  | { kind: 'coordinate_conflict'; operation: StoredRetainedControlOperation }

export interface SessionExecutionLease {
  release(): void
}

const legacyModelMetadata = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
const legacyProfileDigestMetadata = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

/** Keep only non-secret legacy resume hints; request inputs never cross this boundary. */
export function sanitizeLegacySessionMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const metadata: Record<string, unknown> = {}
  const model = legacyModelMetadata.safeParse(source.model)
  if (model.success && !containsSecretShapedValue(model.data)) metadata.model = model.data
  const profileDigest = legacyProfileDigestMetadata.safeParse(source.profile_digest)
  if (profileDigest.success) metadata.profile_digest = profileDigest.data
  for (const key of ['agent_profile', 'agent_profile_binding', 'profile_materialization'] as const) {
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
        metadata.env = parseSafeRetainedEnv(candidate)
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

export class SessionExecutionAbortedError extends Error {
  constructor() {
    super('session execution was cancelled while waiting for the previous turn')
    this.name = 'SessionExecutionAbortedError'
  }
}

/**
 * The exact AgentProfile/model a session is bound to.
 *
 * Persisted verbatim in session metadata under `agent_profile_binding` and
 * reported verbatim on a refusal, so the body a caller reads and the record the
 * bridge holds are the same bytes.
 */
export interface SessionProfileBinding {
  schema: 'cli-bridge.session-agent-profile.v1'
  effectiveProfileDigest: `sha256:${string}`
  provider: string | null
  model: string
  requestedReasoningEffort: string | null
}

/**
 * A caller presented an existing session id under a different exact binding.
 *
 * The bridge never rebinds a session: the external id is the harness
 * conversation key (`claude --resume`, `opencode -s <id>`), so adopting it
 * under a new profile would attribute one conversation to two profiles. Only
 * the caller can tell an intentional resume from an accidental id collision,
 * and it does that by never deriving one session id for two logical runs.
 *
 * Both bindings ride on the error because the refusal alone cannot be acted on:
 * without the digest pair a caller cannot separate "my profile drifted" from "I
 * reused a dead run's id". Measured 2026-08-22: that ambiguity, reported as a
 * bare 400 `parse_error`, cost a debugging session and masked a second failure
 * class in the same batch.
 */
export class SessionProfileBindingConflictError extends Error {
  readonly code = 'session_binding_conflict' as const

  constructor(
    readonly sessionId: string,
    readonly storedBinding: SessionProfileBinding | null,
    readonly receivedBinding: SessionProfileBinding | null,
  ) {
    super(
      storedBinding === null
        ? `session ${JSON.stringify(sessionId)} predates exact AgentProfile binding; use a new session id`
        : `session ${JSON.stringify(sessionId)} is bound to a different AgentProfile/model`,
    )
    this.name = 'SessionProfileBindingConflictError'
  }
}

export class SessionIdentityConflictError extends Error {
  readonly code = 'session_identity_conflict' as const

  constructor(
    public readonly sessionId: string,
    public readonly expectedKind: 'legacy' | 'retained',
    public readonly existingKind: 'legacy' | 'retained',
  ) {
    super(
      `session id ${JSON.stringify(sessionId)} is already owned by the ${existingKind} session API and cannot be used by the ${expectedKind} session API`,
    )
    this.name = 'SessionIdentityConflictError'
  }
}

interface SessionExecutionWaiter {
  readonly signal?: AbortSignal
  readonly resolve: (lease: SessionExecutionLease) => void
  readonly reject: (error: SessionExecutionAbortedError) => void
  onAbort?: () => void
}

interface SessionExecutionLane {
  readonly waiters: SessionExecutionWaiter[]
}

interface ExpectedColumn {
  name: string
  type: string
  notnull: number
  defaultValue: string | null
  pk: number
}

const EXPECTED_SESSION_SCHEMA: Record<string, ExpectedColumn[]> = {
  session_identities: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'kind', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
  sessions: [
    { name: 'external_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 1 },
    { name: 'backend', type: 'TEXT', notnull: 1, defaultValue: null, pk: 2 },
    { name: 'internal_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'cwd', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'turns', type: 'INTEGER', notnull: 1, defaultValue: '0', pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'last_used_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'metadata_json', type: 'TEXT', notnull: 1, defaultValue: "'{}'", pk: 0 },
  ],
  retained_sessions: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'create_request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'backend', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'model', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'cwd', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'turns', type: 'INTEGER', notnull: 1, defaultValue: '0', pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'internal_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'last_used_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'metadata_json', type: 'TEXT', notnull: 1, defaultValue: "'{}'", pk: 0 },
    { name: 'capabilities_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'profile_receipt_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'context_boundary_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
  ],
  retained_events: [
    { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 1 },
    { name: 'session_sequence', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 2 },
    { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'sequence', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'event_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'cursor', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'occurred_at', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'received_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'event_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  ],
  retained_run_admissions: [
    { name: 'run_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'execution_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'snapshot_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'provider', type: 'TEXT', notnull: 1, defaultValue: "'cli-bridge'", pk: 0 },
    { name: 'environment_id', type: 'TEXT', notnull: 1, defaultValue: "'cli-bridge'", pk: 0 },
    { name: 'owner', type: 'TEXT', notnull: 1, defaultValue: "'retained'", pk: 0 },
  ],
  interaction_operations: INTERACTION_OPERATION_COLUMNS,
  retained_control_operations: [
    { name: 'operation_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'caller_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'kind', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'acknowledgement_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
  ],
}

const EXPECTED_NAMED_INDEXES: Record<string, Record<string, string[]>> = {
  sessions: { idx_sessions_last_used: ['last_used_at'] },
  retained_sessions: { idx_retained_sessions_last_used: ['last_used_at'] },
  retained_events: { idx_retained_events_session_cursor: ['session_id', 'session_sequence'] },
  retained_run_admissions: { idx_retained_run_admissions_session: ['session_id', 'created_at'] },
  interaction_operations: {
    idx_interaction_operations_phase_created: ['phase', 'created_at'],
    idx_interaction_operations_interaction_phase: ['run_id', 'session_id', 'interaction_id', 'phase'],
  },
}

const RELEASED_INTERACTION_OPERATION_COLUMNS: ExpectedColumn[] = [
  { name: 'operation_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
  { name: 'caller_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'interaction_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'acknowledgement_json', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
]

const RETAINED_SCHEMA_ERROR = 'incompatible retained-session data schema; use a fresh data directory for this unreleased format'

/**
 * The envelope contract's per-string ceiling (agent-interface CONTRACT_MAX_STRING_LENGTH; the
 * package root does not re-export the constant). RuntimeEventEnvelopeSchema still validates
 * after the clamp, so a drift between this number and the contract fails loudly there, never
 * silently.
 */
const RETAINED_STRING_BOUND = 16_384
const RETAINED_TRUNCATION_MARKER = '…[truncated for retention: '

/** Clamp every string in a retained-copy JSON value to the envelope contract's string bound,
 *  marking each cut with its original length. Mutates and returns the (already-cloned) value. */
export function clampRetainedStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= RETAINED_STRING_BOUND) return value
    const marker = `${RETAINED_TRUNCATION_MARKER}${value.length} chars]`
    return value.slice(0, RETAINED_STRING_BOUND - marker.length) + marker
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = clampRetainedStrings(value[i])
    return value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) record[key] = clampRetainedStrings(record[key])
    return value
  }
  return value
}

export class SessionStore implements RetainedInteractionPersistence {
  private db: Database.Database
  private readonly databasePath: string
  private readonly executionLanes = new Map<string, SessionExecutionLane>()
  private readonly interactionLedger!: RetainedInteractionLedger

  constructor(dataDir: string) {
    const privateDataDir = ensurePrivateDataDirectory(dataDir)
    this.databasePath = join(privateDataDir, 'sessions.sqlite')
    this.db = new Database(this.databasePath)
    try {
      chmodSync(this.databasePath, 0o600)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = FULL')
      this.db.pragma('secure_delete = ON')
      this.restrictDatabaseFiles()
      const existingTables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>
      const tableNames = existingTables.map(row => row.name)
      const legacySessionsOnly = tableNames.length === 1 && tableNames[0] === 'sessions'
      if (legacySessionsOnly) this.assertLegacySessionsSchema()
      if (existingTables.length === 0 || legacySessionsOnly) this.db.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_identities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('legacy', 'retained')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        external_id TEXT NOT NULL,
        backend TEXT NOT NULL,
        internal_id TEXT NOT NULL,
        cwd TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (external_id, backend)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used_at);
      CREATE TABLE IF NOT EXISTS retained_sessions (
        id TEXT PRIMARY KEY,
        create_request_digest TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        cwd TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        run_id TEXT,
        internal_id TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        capabilities_json TEXT NOT NULL,
        profile_receipt_json TEXT,
        context_boundary_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_retained_sessions_last_used ON retained_sessions(last_used_at);
      CREATE TABLE IF NOT EXISTS retained_events (
        session_id TEXT NOT NULL,
        session_sequence INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, session_sequence),
        UNIQUE (session_id, run_id, sequence),
        UNIQUE (session_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_retained_events_session_cursor ON retained_events(session_id, session_sequence);
      CREATE TABLE IF NOT EXISTS retained_run_admissions (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'cli-bridge',
        environment_id TEXT NOT NULL DEFAULT 'cli-bridge',
        owner TEXT NOT NULL DEFAULT 'retained'
      );
      CREATE INDEX IF NOT EXISTS idx_retained_run_admissions_session ON retained_run_admissions(session_id, created_at);
      CREATE TABLE IF NOT EXISTS retained_control_operations (
        operation_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        acknowledgement_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
        `)
        createInteractionOperationSchema(this.db)
        if (legacySessionsOnly) {
          this.db.prepare(
            `INSERT INTO session_identities (id, kind, created_at)
             SELECT external_id, 'legacy', MIN(created_at)
             FROM sessions
             GROUP BY external_id`,
          ).run()
        }
      })()
      this.migrateReleasedInteractionOperations()
      createInteractionOperationSchema(this.db)
      this.migrateRetainedRunCoordinates()
      this.interactionLedger = new RetainedInteractionLedger(this.db)
      this.assertRetainedSchema()
      if (this.scrubLegacySessionMetadata()) {
        // The prior JSON may contain credentials. Remove historical WAL frames
        // and rebuild the database so the disallowed bytes are not merely
        // unreachable through SELECT while still present on disk.
        this.db.pragma('wal_checkpoint(TRUNCATE)')
        this.db.exec('VACUUM')
        this.db.pragma('wal_checkpoint(TRUNCATE)')
      }
      this.restrictDatabaseFiles()
    } catch (error) {
      try { if (this.db.open) this.db.close() } catch { /* preserve the startup failure */ }
      throw error
    }
  }

  private migrateReleasedInteractionOperations(): void {
    const table = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interaction_operations'",
    ).get() as { name: string } | undefined
    if (!table) return
    const actualColumns = this.db.prepare('PRAGMA table_info(interaction_operations)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    const isReleasedShape = actualColumns.length === RELEASED_INTERACTION_OPERATION_COLUMNS.length
      && actualColumns.every((actual, index) => {
        const expected = RELEASED_INTERACTION_OPERATION_COLUMNS[index]
        return expected !== undefined
          && actual.name === expected.name
          && actual.type === expected.type
          && actual.notnull === expected.notnull
          && actual.dflt_value === expected.defaultValue
          && actual.pk === expected.pk
      })
    if (!isReleasedShape) return

    this.db.transaction(() => {
      this.db.exec('ALTER TABLE interaction_operations RENAME TO interaction_operations_released')
      createInteractionOperationSchema(this.db)
      this.db.exec(`
        INSERT INTO interaction_operations
          (operation_id, caller_id, run_id, session_id, interaction_id, request_digest,
           acknowledgement_json, response_digest, phase, effect_proof_json, created_at)
        SELECT operation_id, caller_id, run_id, session_id, interaction_id, request_digest,
               acknowledgement_json, request_digest, 'acknowledged',
               '{"kind":"released_acknowledgement","operationRequestDigest":"'
                 || request_digest || '","recordedAt":' || created_at || '}',
               created_at
        FROM interaction_operations_released
      `)
      this.db.exec('DROP TABLE interaction_operations_released')
    })()
  }

  private migrateRetainedRunCoordinates(): void {
    const table = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retained_run_admissions'",
    ).get() as { name: string } | undefined
    if (!table) return
    const columns = this.db.prepare('PRAGMA table_info(retained_run_admissions)').all() as Array<{ name: string }>
    const names = new Set(columns.map(column => column.name))
    this.db.transaction(() => {
      if (!names.has('provider')) {
        this.db.exec("ALTER TABLE retained_run_admissions ADD COLUMN provider TEXT NOT NULL DEFAULT 'cli-bridge'")
      }
      if (!names.has('environment_id')) {
        this.db.exec("ALTER TABLE retained_run_admissions ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'cli-bridge'")
      }
      if (!names.has('owner')) {
        this.db.exec("ALTER TABLE retained_run_admissions ADD COLUMN owner TEXT NOT NULL DEFAULT 'retained'")
      }
    })()
  }

  private assertLegacySessionsSchema(): void {
    const expectedColumns = EXPECTED_SESSION_SCHEMA.sessions!
    const actualColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    if (actualColumns.length !== expectedColumns.length) this.failSchema()
    for (const [index, expected] of expectedColumns.entries()) {
      const actual = actualColumns[index]
      if (
        !actual
        || actual.name !== expected.name
        || actual.type !== expected.type
        || actual.notnull !== expected.notnull
        || actual.dflt_value !== expected.defaultValue
        || actual.pk !== expected.pk
      ) this.failSchema()
    }
    const index = (this.db.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string; unique: number }>)
      .find(candidate => candidate.name === 'idx_sessions_last_used' && candidate.unique === 0)
    if (!index) this.failSchema()
    const columns = (this.db.prepare('PRAGMA index_info(idx_sessions_last_used)').all() as Array<{ name: string }>)
      .map(column => column.name)
    if (JSON.stringify(columns) !== JSON.stringify(['last_used_at'])) this.failSchema()
  }

  private assertRetainedSchema(): void {
    const actualTables = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    const expectedTables = Object.keys(EXPECTED_SESSION_SCHEMA).sort()
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) this.failSchema()

    for (const [table, expectedColumns] of Object.entries(EXPECTED_SESSION_SCHEMA)) {
      const actualColumns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>
      if (actualColumns.length !== expectedColumns.length) this.failSchema()
      for (const [index, expected] of expectedColumns.entries()) {
        const actual = actualColumns[index]
        if (
          !actual
          || actual.name !== expected.name
          || actual.type !== expected.type
          || actual.notnull !== expected.notnull
          || actual.dflt_value !== expected.defaultValue
          || actual.pk !== expected.pk
        ) this.failSchema()
      }

      const indexes = this.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>
      for (const [name, columns] of Object.entries(EXPECTED_NAMED_INDEXES[table] ?? {})) {
        const index = indexes.find(candidate => candidate.name === name && candidate.unique === 0)
        if (!index) this.failSchema()
        const actualColumns = (this.db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map(column => column.name)
        if (JSON.stringify(actualColumns) !== JSON.stringify(columns)) this.failSchema()
      }
    }

    const eventIndexes = this.db.prepare('PRAGMA index_list(retained_events)').all() as Array<{ name: string; unique: number }>
    const uniqueShapes = eventIndexes
      .filter(index => index.unique === 1)
      .map(index => (this.db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(column => column.name).join('\u0000'))
    if (!uniqueShapes.includes('session_id\u0000run_id\u0000sequence') || !uniqueShapes.includes('session_id\u0000event_id')) {
      this.failSchema()
    }
  }

  private failSchema(): never {
    this.db.close()
    throw new Error(RETAINED_SCHEMA_ERROR)
  }

  get(externalId: string, backend: string): SessionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM sessions WHERE external_id = ? AND backend = ?',
    ).get(externalId, backend) as Record<string, unknown> | undefined
    if (!row) return null
    return this.hydrate(row)
  }

  /** Return every durable backend binding for one legacy session id. */
  findByExternalId(externalId: string): SessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE external_id = ? ORDER BY last_used_at DESC, backend ASC',
    ).all(externalId) as Record<string, unknown>[]
    return rows.map(row => this.hydrate(row))
  }

  claimSessionIdentity(id: string, kind: 'legacy' | 'retained'): void {
    const existing = this.db.prepare('SELECT kind FROM session_identities WHERE id = ?').get(id) as { kind: 'legacy' | 'retained' } | undefined
    if (existing && existing.kind !== kind) {
      throw new SessionIdentityConflictError(id, kind, existing.kind)
    }
    if (!existing) {
      this.db.prepare(
        'INSERT INTO session_identities (id, kind, created_at) VALUES (?, ?, ?)',
      ).run(id, kind, Date.now())
    }
  }

  /** Check the cross-API identity fence without reserving a legacy session. */
  assertSessionIdentityAvailable(id: string, kind: 'legacy' | 'retained'): void {
    const existing = this.db.prepare('SELECT kind FROM session_identities WHERE id = ?').get(id) as
      | { kind: 'legacy' | 'retained' }
      | undefined
    if (existing && existing.kind !== kind) {
      throw new SessionIdentityConflictError(id, kind, existing.kind)
    }
  }

  /**
   * Own one session's read → execute → update interval.
   *
   * The durable run registry handles duplicate run ids before this method is
   * called. This queue only orders distinct creators that would otherwise read
   * the same resume id and overwrite each other's next state.
   */
  acquireExecution(
    externalId: string,
    backend: string,
    signal?: AbortSignal,
  ): Promise<SessionExecutionLease> {
    if (signal?.aborted) {
      return Promise.reject(new SessionExecutionAbortedError())
    }

    const key = JSON.stringify([backend, externalId])
    const lane = this.executionLanes.get(key)
    if (!lane) {
      const created: SessionExecutionLane = { waiters: [] }
      this.executionLanes.set(key, created)
      return Promise.resolve(this.executionLease(key, created))
    }

    return new Promise<SessionExecutionLease>((resolve, reject) => {
      const waiter: SessionExecutionWaiter = { signal, resolve, reject }
      const onAbort = (): void => {
        const index = lane.waiters.indexOf(waiter)
        if (index === -1) return
        lane.waiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        reject(new SessionExecutionAbortedError())
      }
      waiter.onAbort = onAbort
      lane.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  upsert(args: {
    externalId: string
    backend: string
    internalId: string
    cwd?: string | null
    metadata?: Record<string, unknown>
  }): SessionRecord {
    this.claimSessionIdentity(args.externalId, 'legacy')
    const now = Date.now()
    const existing = this.get(args.externalId, args.backend)
    const turns = existing ? existing.turns + 1 : 1
    const createdAt = existing?.createdAt ?? now
    const metadata = sanitizeLegacySessionMetadata({
      ...(existing?.metadata ?? {}),
      ...(args.metadata ?? {}),
    })
    this.db.prepare(
      `INSERT INTO sessions (external_id, backend, internal_id, cwd, turns, created_at, last_used_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id, backend) DO UPDATE SET
         internal_id = excluded.internal_id,
         cwd = excluded.cwd,
         turns = excluded.turns,
         last_used_at = excluded.last_used_at,
         metadata_json = excluded.metadata_json`,
    ).run(
      args.externalId,
      args.backend,
      args.internalId,
      args.cwd ?? null,
      turns,
      createdAt,
      now,
      JSON.stringify(metadata),
    )
    return {
      externalId: args.externalId,
      backend: args.backend,
      internalId: args.internalId,
      cwd: args.cwd ?? null,
      turns,
      createdAt,
      lastUsedAt: now,
      metadata,
    }
  }

  /** Persist request authority before native or sandbox execution begins. */
  remember(args: {
    externalId: string
    backend: string
    model: string
    internalId?: string | null
    cwd?: string | null
    metadata?: Record<string, unknown>
  }): SessionRecord {
    this.claimSessionIdentity(args.externalId, 'legacy')
    const now = Date.now()
    const existing = this.get(args.externalId, args.backend)
    const metadata = sanitizeLegacySessionMetadata({
      ...(existing?.metadata ?? {}),
      ...(args.metadata ?? {}),
      model: args.model,
    })
    const internalId = args.internalId ?? existing?.internalId ?? ''
    const cwd = args.cwd === undefined ? existing?.cwd ?? null : args.cwd
    const turns = existing?.turns ?? 0
    const createdAt = existing?.createdAt ?? now
    this.db.prepare(
      `INSERT INTO sessions (external_id, backend, internal_id, cwd, turns, created_at, last_used_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id, backend) DO UPDATE SET
         internal_id = excluded.internal_id,
         cwd = excluded.cwd,
         last_used_at = excluded.last_used_at,
         metadata_json = excluded.metadata_json`,
    ).run(
      args.externalId,
      args.backend,
      internalId,
      cwd,
      turns,
      createdAt,
      now,
      JSON.stringify(metadata),
    )
    return this.get(args.externalId, args.backend)!
  }

  list(limit = 100): SessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions ORDER BY last_used_at DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[]
    return rows.map(r => this.hydrate(r))
  }

  delete(externalId: string, backend?: string): number {
    let deleted: number
    if (backend) {
      deleted = this.db.prepare(
        'DELETE FROM sessions WHERE external_id = ? AND backend = ?',
      ).run(externalId, backend).changes
    } else {
      deleted = this.db.prepare(
        'DELETE FROM sessions WHERE external_id = ?',
      ).run(externalId).changes
    }
    const remaining = this.db.prepare('SELECT 1 FROM sessions WHERE external_id = ? LIMIT 1').get(externalId)
    if (!remaining) {
      this.db.prepare("DELETE FROM session_identities WHERE id = ? AND kind = 'legacy'").run(externalId)
    }
    return deleted
  }

  createRetained(args: {
    id: string
    createRequestDigest: string
    backend: string
    model: string
    cwd?: string | null
    metadata?: Record<string, unknown>
    capabilities: AgentEnvironmentCapabilities
    profileMaterializationReceipt?: Record<string, unknown> | null
  }): RetainedSessionRecord {
    const existing = this.getRetained(args.id)
    if (existing) throw new Error(`retained session ${JSON.stringify(args.id)} already exists`)
    const metadata = parseSafeRetainedMetadata(args.metadata)
    this.claimSessionIdentity(args.id, 'retained')
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO retained_sessions
       (id, create_request_digest, backend, model, cwd, turns, status, run_id, internal_id, created_at, last_used_at,
        metadata_json, capabilities_json, profile_receipt_json, context_boundary_json)
       VALUES (?, ?, ?, ?, ?, 0, 'created', NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      args.id,
      args.createRequestDigest,
      args.backend,
      args.model,
      args.cwd ?? null,
      now,
      now,
      JSON.stringify(metadata),
      JSON.stringify(args.capabilities),
      args.profileMaterializationReceipt ? JSON.stringify(args.profileMaterializationReceipt) : null,
    )
    return this.getRetained(args.id)!
  }

  getRetained(id: string): RetainedSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM retained_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.hydrateRetained(row) : null
  }

  listRetained(limit = 100): RetainedSessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM retained_sessions ORDER BY last_used_at DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[]
    return rows.map(row => this.hydrateRetained(row))
  }

  updateRetained(
    id: string,
    patch: Partial<Pick<RetainedSessionRecord, 'cwd' | 'turns' | 'status' | 'runId' | 'internalId' | 'metadata' | 'profileMaterializationReceipt' | 'contextBoundary'>>,
  ): RetainedSessionRecord | null {
    const current = this.getRetained(id)
    if (!current) return null
    const next = {
      ...current,
      ...patch,
      metadata: parseSafeRetainedMetadata(patch.metadata ?? current.metadata),
      lastUsedAt: Date.now(),
    }
    this.db.prepare(
      `UPDATE retained_sessions SET cwd = ?, turns = ?, status = ?, run_id = ?, internal_id = ?,
       last_used_at = ?, metadata_json = ?, profile_receipt_json = ?, context_boundary_json = ?
       WHERE id = ?`,
    ).run(
      next.cwd,
      next.turns,
      next.status,
      next.runId,
      next.internalId,
      next.lastUsedAt,
      JSON.stringify(next.metadata),
      next.profileMaterializationReceipt ? JSON.stringify(next.profileMaterializationReceipt) : null,
      next.contextBoundary ? JSON.stringify(next.contextBoundary) : null,
      id,
    )
    return this.getRetained(id)
  }

  claimRetainedRun(input: {
    runId: string
    owner?: RunOwner
    sessionId: string
    executionId: string
    requestDigest: string
    provider: string
    environmentId: string
    snapshot: unknown
  }): RetainedRunClaim {
    const claim = this.db.transaction((): RetainedRunClaim => {
      const owner = input.owner ?? 'retained'
      const now = Date.now()
      const inserted = this.db.prepare(
        `INSERT INTO retained_run_admissions
         (run_id, session_id, execution_id, request_digest, snapshot_json, created_at, updated_at, provider, environment_id, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      ).run(
        input.runId,
        input.sessionId,
        input.executionId,
        input.requestDigest,
        JSON.stringify(input.snapshot),
        now,
        now,
        input.provider,
        input.environmentId,
        owner,
      )
      const admission = this.getRetainedRun(input.runId)
      if (!admission) throw new Error(`retained run admission ${JSON.stringify(input.runId)} was not persisted`)
      if (
        admission.sessionId !== input.sessionId
        || admission.executionId !== input.executionId
        || admission.requestDigest !== input.requestDigest
        || admission.provider !== input.provider
        || admission.environmentId !== input.environmentId
        || admission.owner !== owner
      ) {
        return { kind: 'conflict', admission }
      }
      return { kind: inserted.changes === 1 ? 'created' : 'replayed', admission }
    })
    return claim()
  }

  getRetainedRun(runId: string): RetainedRunAdmission | null {
    const row = this.db.prepare(
      'SELECT * FROM retained_run_admissions WHERE run_id = ?',
    ).get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      runId: row.run_id as string,
      owner: row.owner as RunOwner,
      sessionId: row.session_id as string,
      executionId: row.execution_id as string,
      requestDigest: row.request_digest as string,
      provider: row.provider as string,
      environmentId: row.environment_id as string,
      snapshot: JSON.parse(row.snapshot_json as string) as unknown,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }

  updateRetainedRun(
    runId: string,
    requestDigest: string,
    snapshot: unknown,
  ): RetainedRunAdmission {
    const updated = this.db.prepare(
      `UPDATE retained_run_admissions
       SET snapshot_json = ?, updated_at = ?
       WHERE run_id = ? AND request_digest = ?`,
    ).run(JSON.stringify(snapshot), Date.now(), runId, requestDigest)
    if (updated.changes !== 1) {
      throw new Error(`retained run ${JSON.stringify(runId)} is not bound to this request`)
    }
    return this.getRetainedRun(runId)!
  }

  appendRetainedEvent(sessionId: string, input: RuntimeEventEnvelope): RetainedEventRecord {
    RuntimeEventEnvelopeSchema.parse(input)
    const append = this.db.transaction((candidate: RuntimeEventEnvelope): RetainedEventRecord => {
      const existing = this.db.prepare(
        'SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? AND sequence = ?',
      ).get(sessionId, candidate.runId, candidate.sequence) as Record<string, unknown> | undefined
      if (existing) {
        const hydrated = this.hydrateRetainedEvent(existing)
        if (hydrated.envelope.eventId !== candidate.eventId || JSON.stringify(hydrated.envelope.event) !== JSON.stringify(candidate.event)) {
          throw new Error(`retained event ${JSON.stringify(candidate.eventId)} conflicts with an existing sequence`)
        }
        return hydrated
      }

      const sessionSequence = (this.db.prepare(
        'SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next FROM retained_events WHERE session_id = ?',
      ).get(sessionId) as { next: number }).next
      const envelope: RuntimeEventEnvelope = {
        ...candidate,
        cursor: String(sessionSequence),
      }
      this.db.prepare(
        `INSERT INTO retained_events
         (session_id, session_sequence, run_id, sequence, event_id, cursor, occurred_at, received_at, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        sessionSequence,
        envelope.runId,
        envelope.sequence,
        envelope.eventId,
        envelope.cursor,
        envelope.occurredAt ?? null,
        envelope.receivedAt,
        JSON.stringify(envelope.event),
      )
      this.db.prepare('UPDATE retained_sessions SET last_used_at = ? WHERE id = ?').run(Date.now(), sessionId)
      return { sessionId, sessionSequence, envelope }
    })
    return append(input)
  }

  /** Persist one OpenAI delta in the existing canonical retained event log.
   *
   * The retained copy is CLAMPED to the envelope contract's string bound before it is
   * validated. A codex director at xhigh effort emits legitimate single events holding a whole
   * charter or ledger (measured 2026-08-31: strings to 1,048,547 chars in one rollout event,
   * against CONTRACT_MAX_STRING_LENGTH 16,384). Refusing the retained write threw inside
   * commitDelta, which killed the LIVE stream: three 10-minute director attempts died on
   * "value exceeds the contract bounds or is not finite JSON" with the caller's work lost.
   * Retention is replay/diagnostic bookkeeping; a marked truncation there is honest, while a
   * dead stream is a lost run. The in-memory replay log keeps the full delta either way.
   */
  appendRetainedDelta(sessionId: string, input: {
    runId: string
    sequence: number
    delta: ChatDelta
  }): RetainedEventRecord {
    const event = clampRetainedStrings(JSON.parse(JSON.stringify(input.delta)))
    return this.appendRetainedEvent(sessionId, {
      runId: input.runId,
      eventId: retainedDeltaEventId(input.runId, input.sequence),
      sequence: input.sequence,
      receivedAt: new Date().toISOString(),
      event: {
        type: 'raw',
        backend: 'cli-bridge.chat',
        event,
      },
    })
  }

  retainedEventsAfter(sessionId: string, afterCursor = 0): RetainedEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM retained_events WHERE session_id = ? AND session_sequence > ? ORDER BY session_sequence ASC',
    ).all(sessionId, afterCursor) as Record<string, unknown>[]
    return rows.map(row => this.hydrateRetainedEvent(row))
  }

  retainedEventsAfterRun(sessionId: string, runId: string, afterSequence = 0): RetainedEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? AND sequence > ? ORDER BY sequence ASC',
    ).all(sessionId, runId, afterSequence) as Record<string, unknown>[]
    return rows.map(row => this.hydrateRetainedEvent(row))
  }

  latestRetainedEventForRun(sessionId: string, runId: string): RetainedEventRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? ORDER BY sequence DESC LIMIT 1',
    ).get(sessionId, runId) as Record<string, unknown> | undefined
    return row ? this.hydrateRetainedEvent(row) : null
  }

  retainedRun(runId: string): { sessionId: string; lastSequence: number } | null {
    const row = this.db.prepare(
      'SELECT session_id, MAX(sequence) AS last_sequence FROM retained_events WHERE run_id = ? GROUP BY session_id ORDER BY session_id LIMIT 1',
    ).get(runId) as { session_id: string; last_sequence: number } | undefined
    if (row) return { sessionId: row.session_id, lastSequence: row.last_sequence }
    const admission = this.getRetainedRun(runId)
    return admission ? { sessionId: admission.sessionId, lastSequence: 0 } : null
  }

  latestRetainedEvent(sessionId: string): RetainedEventRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM retained_events WHERE session_id = ? ORDER BY session_sequence DESC LIMIT 1',
    ).get(sessionId) as Record<string, unknown> | undefined
    return row ? this.hydrateRetainedEvent(row) : null
  }

  /** The retained interaction state machine owns policy; this facade only forwards durable ledger calls. */
  beginInteractionOperation(input: BeginInteractionOperationInput): InteractionOperationClaim {
    return this.interactionLedger.beginInteractionOperation(input)
  }

  recordInteractionEffect(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
  ): StoredInteractionOperation {
    return this.interactionLedger.recordInteractionEffect(operationId, requestDigest, responseDigest)
  }

  recordInteractionOperation(input: RecordInteractionOperationInput): StoredInteractionOperation {
    return this.interactionLedger.recordInteractionOperation(input)
  }

  markInteractionEffectUnknown(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
    acknowledgement: InteractionAcknowledgement,
  ): StoredInteractionOperation {
    return this.interactionLedger.markInteractionEffectUnknown(operationId, requestDigest, responseDigest, acknowledgement)
  }

  findEffectUnknownInteraction(
    runId: string,
    sessionId: string,
    interactionId: string,
  ): StoredInteractionOperation | null {
    return this.interactionLedger.findEffectUnknownInteraction(runId, sessionId, interactionId)
  }

  getInteractionOperation(operationId: string): StoredInteractionOperation | null {
    return this.interactionLedger.getInteractionOperation(operationId)
  }

  recordRetainedControlOperation(operation: StoredRetainedControlOperation): boolean {
    const inserted = this.db.prepare(
      `INSERT INTO retained_control_operations
       (operation_id, caller_id, kind, run_id, session_id, request_digest, acknowledgement_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
    ).run(
      operation.operationId,
      operation.callerId,
      operation.kind,
      operation.runId,
      operation.sessionId,
      operation.requestDigest,
      JSON.stringify(operation.acknowledgement),
      Date.now(),
    )
    return inserted.changes === 1
  }

  /** Claim one portable-context operation and every destination coordinate atomically. */
  claimContextTransferOperation(
    operation: StoredRetainedControlOperation,
    destination: { environmentId: string; executionId: string },
  ): ContextTransferOperationClaim {
    if (operation.kind !== 'context_transfer') {
      throw new Error('context transfer claim requires a context_transfer operation')
    }
    return this.db.transaction((): ContextTransferOperationClaim => {
      const existing = this.getRetainedControlOperation(operation.operationId)
      if (existing) return { kind: 'existing', operation: existing }
      const collision = this.db.prepare(
        `SELECT * FROM retained_control_operations
         WHERE kind = 'context_transfer'
           AND (
             run_id = ? OR session_id = ?
             OR json_extract(acknowledgement_json, '$.binding.destination.environmentId') = ?
             OR json_extract(acknowledgement_json, '$.binding.destination.executionId') = ?
           )
         ORDER BY created_at ASC
         LIMIT 1`,
      ).get(
        operation.runId,
        operation.sessionId,
        destination.environmentId,
        destination.executionId,
      ) as Record<string, unknown> | undefined
      if (collision) {
        return {
          kind: 'coordinate_conflict',
          operation: hydrateRetainedControlOperation(collision),
        }
      }
      if (!this.recordRetainedControlOperation(operation)) {
        const raced = this.getRetainedControlOperation(operation.operationId)
        if (!raced) throw new Error('context transfer claim disappeared during admission')
        return { kind: 'existing', operation: raced }
      }
      return { kind: 'created', operation }
    })()
  }

  updateRetainedControlOperation(
    operationId: string,
    requestDigest: string,
    acknowledgement: Record<string, unknown>,
  ): boolean {
    const updated = this.db.prepare(
      `UPDATE retained_control_operations
       SET acknowledgement_json = ?
       WHERE operation_id = ? AND request_digest = ?
         AND (
           json_extract(acknowledgement_json, '$.status') = 'pending'
           OR json_extract(acknowledgement_json, '$.phase') = 'pending'
         )`,
    ).run(JSON.stringify(acknowledgement), operationId, requestDigest)
    return updated.changes === 1
  }

  getRetainedControlOperation(operationId: string): StoredRetainedControlOperation | null {
    const row = this.db.prepare(
      'SELECT * FROM retained_control_operations WHERE operation_id = ?',
    ).get(operationId) as Record<string, unknown> | undefined
    if (!row) return null
    return hydrateRetainedControlOperation(row)
  }

  /** Recover the transfer that reserved one caller-owned destination environment. */
  findContextTransferByEnvironmentId(environmentId: string): StoredRetainedControlOperation | null {
    const row = this.db.prepare(
      `SELECT * FROM retained_control_operations
       WHERE kind = 'context_transfer'
         AND json_extract(acknowledgement_json, '$.binding.destination.environmentId') = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(environmentId) as Record<string, unknown> | undefined
    return row ? hydrateRetainedControlOperation(row) : null
  }

  findInteraction(sessionId: string, interactionId: string): InteractionRequest | null {
    const rows = this.db.prepare(
      'SELECT event_json FROM retained_events WHERE session_id = ? AND event_json LIKE ? ORDER BY session_sequence DESC',
    ).all(sessionId, `%"type":"interaction"%`) as Array<{ event_json: string }>
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as { type?: string; request?: InteractionRequest }
      if (event.type === 'interaction' && event.request?.id === interactionId) return event.request
    }
    return null
  }

  close(): void {
    for (const lane of this.executionLanes.values()) {
      for (const waiter of lane.waiters.splice(0)) {
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new SessionExecutionAbortedError())
      }
    }
    this.executionLanes.clear()
    this.restrictDatabaseFiles()
    this.db.close()
    this.restrictDatabaseFiles()
  }

  private restrictDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }

  private scrubLegacySessionMetadata(): boolean {
    const rows = this.db.prepare(
      'SELECT external_id, backend, metadata_json FROM sessions',
    ).all() as Array<{ external_id: string; backend: string; metadata_json: string }>
    const update = this.db.prepare(
      'UPDATE sessions SET metadata_json = ? WHERE external_id = ? AND backend = ?',
    )
    let changed = false
    this.db.transaction(() => {
      for (const row of rows) {
        let parsed: unknown = {}
        try { parsed = JSON.parse(row.metadata_json || '{}') } catch { /* malformed metadata is discarded */ }
        const safe = JSON.stringify(sanitizeLegacySessionMetadata(parsed))
        if (safe !== row.metadata_json) {
          update.run(safe, row.external_id, row.backend)
          changed = true
        }
      }
    })()
    return changed
  }

  private executionLease(key: string, lane: SessionExecutionLane): SessionExecutionLease {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true

        while (lane.waiters.length > 0) {
          const waiter = lane.waiters.shift()!
          if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
          if (waiter.signal?.aborted) {
            waiter.reject(new SessionExecutionAbortedError())
            continue
          }
          waiter.resolve(this.executionLease(key, lane))
          return
        }

        if (this.executionLanes.get(key) === lane) {
          this.executionLanes.delete(key)
        }
      },
    }
  }

  private hydrate(row: Record<string, unknown>): SessionRecord {
    return {
      externalId: row.external_id as string,
      backend: row.backend as string,
      internalId: row.internal_id as string,
      cwd: (row.cwd as string | null) ?? null,
      turns: row.turns as number,
      createdAt: row.created_at as number,
      lastUsedAt: row.last_used_at as number,
      metadata: sanitizeLegacySessionMetadata(
        (() => {
          try { return JSON.parse((row.metadata_json as string) || '{}') } catch { return {} }
        })(),
      ),
    }
  }

  private hydrateRetained(row: Record<string, unknown>): RetainedSessionRecord {
    return {
      id: row.id as string,
      createRequestDigest: row.create_request_digest as string,
      backend: row.backend as string,
      model: row.model as string,
      cwd: (row.cwd as string | null) ?? null,
      turns: row.turns as number,
      status: row.status as RetainedSessionStatus,
      runId: (row.run_id as string | null) ?? null,
      internalId: (row.internal_id as string | null) ?? null,
      createdAt: row.created_at as number,
      lastUsedAt: row.last_used_at as number,
      metadata: JSON.parse((row.metadata_json as string) || '{}') as Record<string, unknown>,
      capabilities: JSON.parse(row.capabilities_json as string) as AgentEnvironmentCapabilities,
      profileMaterializationReceipt: row.profile_receipt_json
        ? JSON.parse(row.profile_receipt_json as string) as Record<string, unknown>
        : null,
      contextBoundary: row.context_boundary_json
        ? JSON.parse(row.context_boundary_json as string) as Record<string, unknown>
        : null,
    }
  }

  private hydrateRetainedEvent(row: Record<string, unknown>): RetainedEventRecord {
    return {
      sessionId: row.session_id as string,
      sessionSequence: row.session_sequence as number,
      envelope: {
        runId: row.run_id as string,
        eventId: row.event_id as string,
        sequence: row.sequence as number,
        cursor: row.cursor as string,
        ...(row.occurred_at ? { occurredAt: row.occurred_at as string } : {}),
        receivedAt: row.received_at as string,
        event: JSON.parse(row.event_json as string),
      },
    }
  }
}

function hydrateRetainedControlOperation(
  row: Record<string, unknown>,
): StoredRetainedControlOperation {
  return {
    operationId: row.operation_id as string,
    callerId: row.caller_id as string,
    kind: row.kind as RetainedControlOperationKind,
    runId: row.run_id as string,
    sessionId: row.session_id as string,
    requestDigest: row.request_digest as string,
    acknowledgement: JSON.parse(row.acknowledgement_json as string) as Record<string, unknown>,
  }
}

function retainedDeltaEventId(runId: string, sequence: number): string {
  const candidate = `chat:${runId}:${sequence}`
  return candidate.length <= 512
    ? candidate
    : `chat:${canonicalCandidateDigest({ runId, sequence }).slice('sha256:'.length)}`
}
