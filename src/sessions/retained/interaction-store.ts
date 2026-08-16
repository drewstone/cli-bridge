import Database from 'better-sqlite3'
import {
  InteractionAcknowledgementSchema,
  type InteractionAcknowledgement,
} from '@tangle-network/agent-interface'

export type InteractionOperationPhase = 'intent' | 'effect_proven' | 'acknowledged' | 'effect_unknown'

/** Acknowledgements are replay aids and can be pruned after the retry window. */
export const MAX_ACKNOWLEDGED_INTERACTION_OPERATIONS = 10_000
/** Unknown effects are safety tombstones and remain bounded, never pruned. */
export const MAX_UNKNOWN_INTERACTION_OPERATIONS = 1_024
/** Native effects that have not reached a terminal durable record. */
export const MAX_OPEN_INTERACTION_OPERATIONS = 1_024
export const INTERACTION_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export class InteractionOperationCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InteractionOperationCapacityError'
  }
}

export type StoredInteractionEffectProof =
  | {
      kind: 'native_response_returned'
      responseDigest: string
      recordedAt: number
    }
  | {
      kind: 'released_acknowledgement'
      operationRequestDigest: string
      recordedAt: number
    }

export interface StoredInteractionOperation {
  operationId: string
  callerId: string
  runId: string
  sessionId: string
  interactionId: string
  requestDigest: string
  responseDigest: string
  phase: InteractionOperationPhase
  effectProof: StoredInteractionEffectProof | null
  acknowledgement: InteractionAcknowledgement | null
}

export type InteractionOperationClaim =
  | { kind: 'created' | 'replayed' | 'conflict'; operation: StoredInteractionOperation }

export type InteractionOperationIdentity = Pick<
  StoredInteractionOperation,
  'operationId' | 'callerId' | 'runId' | 'sessionId' | 'interactionId' | 'requestDigest' | 'responseDigest'
>

export type BeginInteractionOperationInput = Omit<StoredInteractionOperation, 'phase' | 'effectProof' | 'acknowledgement'>

export interface RecordInteractionOperationInput extends InteractionOperationIdentity {
  acknowledgement: InteractionAcknowledgement
}

/** Narrow persistence port used by the retained interaction state machine. */
export interface RetainedInteractionPersistence {
  beginInteractionOperation(input: BeginInteractionOperationInput): InteractionOperationClaim
  recordInteractionEffect(operationId: string, requestDigest: string, responseDigest: string): StoredInteractionOperation
  recordInteractionOperation(input: RecordInteractionOperationInput): StoredInteractionOperation
  markInteractionEffectUnknown(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
    acknowledgement: InteractionAcknowledgement,
  ): StoredInteractionOperation
  findEffectUnknownInteraction(
    runId: string,
    sessionId: string,
    interactionId: string,
  ): StoredInteractionOperation | null
  getInteractionOperation(operationId: string): StoredInteractionOperation | null
}

export interface InteractionSchemaColumn {
  name: string
  type: string
  notnull: number
  defaultValue: string | null
  pk: number
}

export const INTERACTION_OPERATION_COLUMNS: InteractionSchemaColumn[] = [
  { name: 'operation_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
  { name: 'caller_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'run_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'session_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'interaction_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'request_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'acknowledgement_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
  { name: 'response_digest', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'phase', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  { name: 'effect_proof_json', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
  { name: 'created_at', type: 'INTEGER', notnull: 1, defaultValue: null, pk: 0 },
]

export function createInteractionOperationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_operations (
      operation_id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      acknowledgement_json TEXT,
      response_digest TEXT NOT NULL,
      phase TEXT NOT NULL,
      effect_proof_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interaction_operations_phase_created
      ON interaction_operations(phase, created_at);
    CREATE INDEX IF NOT EXISTS idx_interaction_operations_interaction_phase
      ON interaction_operations(run_id, session_id, interaction_id, phase);
  `)
}

export class RetainedInteractionLedger implements RetainedInteractionPersistence {
  private acknowledgedCount: number
  private lastAcknowledgementSweepAt = 0

  constructor(private readonly db: Database.Database) {
    this.acknowledgedCount = acknowledgedInteractionCount(db)
  }

  beginInteractionOperation(input: BeginInteractionOperationInput): InteractionOperationClaim {
    const claim = this.db.transaction((): InteractionOperationClaim => {
      const existing = this.getInteractionOperation(input.operationId)
      if (existing) {
        return {
          kind: interactionOperationMatches(existing, input) ? 'replayed' : 'conflict',
          operation: existing,
        }
      }

      this.pruneAcknowledgements()
      assertInteractionOperationCapacity(this.db)

      const inserted = this.db.prepare(
        `INSERT INTO interaction_operations
         (operation_id, caller_id, run_id, session_id, interaction_id, request_digest,
          acknowledgement_json, response_digest, phase, effect_proof_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'intent', NULL, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
      ).run(
        input.operationId,
        input.callerId,
        input.runId,
        input.sessionId,
        input.interactionId,
        input.requestDigest,
        input.responseDigest,
        Date.now(),
      )
      const operation = this.getInteractionOperation(input.operationId)
      if (!operation) throw new Error(`interaction operation ${JSON.stringify(input.operationId)} was not persisted`)
      return {
        kind: inserted.changes === 1
          ? 'created'
          : interactionOperationMatches(operation, input)
            ? 'replayed'
            : 'conflict',
        operation,
      }
    })
    return claim()
  }

  recordInteractionEffect(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
  ): StoredInteractionOperation {
    const current = this.requireInteractionOperation(operationId)
    assertInteractionOperationDigest(current, requestDigest, responseDigest)
    if (current.phase === 'intent') {
      this.db.prepare(
        `UPDATE interaction_operations
         SET phase = 'effect_proven', effect_proof_json = ?
         WHERE operation_id = ? AND request_digest = ? AND response_digest = ? AND phase = 'intent'`,
      ).run(
        JSON.stringify({ kind: 'native_response_returned', responseDigest, recordedAt: Date.now() } satisfies StoredInteractionEffectProof),
        operationId,
        requestDigest,
        responseDigest,
      )
    }
    return this.requireInteractionOperation(operationId)
  }

  recordInteractionOperation(input: RecordInteractionOperationInput): StoredInteractionOperation {
    InteractionAcknowledgementSchema.parse(input.acknowledgement)
    assertAcknowledgementIdentity(input)
    const write = this.db.transaction((): StoredInteractionOperation => {
      this.pruneAcknowledgements()
      const existing = this.getInteractionOperation(input.operationId)
      if (!existing) {
        if (input.acknowledgement.status === 'accepted') {
          throw new Error('accepted interaction acknowledgement requires a persisted native effect proof')
        }
        this.pruneAcknowledgements(1)
        this.db.prepare(
          `INSERT INTO interaction_operations
           (operation_id, caller_id, run_id, session_id, interaction_id, request_digest,
            acknowledgement_json, response_digest, phase, effect_proof_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acknowledged', NULL, ?)`,
        ).run(
          input.operationId,
          input.callerId,
          input.runId,
          input.sessionId,
          input.interactionId,
          input.requestDigest,
          JSON.stringify(input.acknowledgement),
          input.responseDigest,
          Date.now(),
        )
        this.acknowledgedCount += 1
        return this.requireInteractionOperation(input.operationId)
      }

      assertInteractionOperationIdentity(existing, input)
      if (existing.phase === 'effect_unknown' || existing.phase === 'acknowledged') {
        return existing
      }
      if (input.acknowledgement.status === 'accepted' && existing.phase !== 'effect_proven') {
        throw new Error('accepted interaction acknowledgement requires a persisted native effect proof')
      }
      this.pruneAcknowledgements(1)
      const updated = this.db.prepare(
        `UPDATE interaction_operations
         SET acknowledgement_json = ?, phase = 'acknowledged'
         WHERE operation_id = ? AND request_digest = ? AND response_digest = ?
           AND phase IN ('intent', 'effect_proven')`,
      ).run(
        JSON.stringify(input.acknowledgement),
        input.operationId,
        input.requestDigest,
        input.responseDigest,
      )
      if (updated.changes !== 1) throw new Error(`interaction operation ${JSON.stringify(input.operationId)} was not acknowledged`)
      this.acknowledgedCount += 1
      return this.requireInteractionOperation(input.operationId)
    })
    try {
      return write()
    } catch (error) {
      this.acknowledgedCount = acknowledgedInteractionCount(this.db)
      throw error
    }
  }

  private pruneAcknowledgements(reserve = 0): void {
    const now = Date.now()
    if (now - this.lastAcknowledgementSweepAt >= 60_000) {
      const expired = this.db.prepare(
        `DELETE FROM interaction_operations
         WHERE phase = 'acknowledged' AND created_at < ?`,
      ).run(now - INTERACTION_OPERATION_RETENTION_MS)
      this.acknowledgedCount = Math.max(0, this.acknowledgedCount - expired.changes)
      this.lastAcknowledgementSweepAt = now
    }

    const target = Math.max(0, MAX_ACKNOWLEDGED_INTERACTION_OPERATIONS - reserve)
    const excess = this.acknowledgedCount - target
    if (excess <= 0) return

    const rows = this.db.prepare(
      `SELECT operation_id
       FROM interaction_operations
       WHERE phase = 'acknowledged'
       ORDER BY created_at ASC, operation_id ASC
       LIMIT ?`,
    ).all(excess) as Array<{ operation_id: string }>
    const remove = this.db.prepare("DELETE FROM interaction_operations WHERE operation_id = ? AND phase = 'acknowledged'")
    let removed = 0
    for (const row of rows) removed += remove.run(row.operation_id).changes
    this.acknowledgedCount = Math.max(0, this.acknowledgedCount - removed)
  }

  markInteractionEffectUnknown(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
    acknowledgement: InteractionAcknowledgement,
  ): StoredInteractionOperation {
    InteractionAcknowledgementSchema.parse(acknowledgement)
    if (acknowledgement.status !== 'transport_failure' || acknowledgement.retryable !== false) {
      throw new Error('unknown interaction effects require a non-retryable transport acknowledgement')
    }
    const current = this.requireInteractionOperation(operationId)
    assertInteractionOperationDigest(current, requestDigest, responseDigest)
    assertAcknowledgementIdentity({ ...current, acknowledgement })
    if (current.phase !== 'intent') return current
    this.db.prepare(
      `UPDATE interaction_operations
       SET acknowledgement_json = ?, phase = 'effect_unknown'
       WHERE operation_id = ? AND request_digest = ? AND response_digest = ? AND phase = 'intent'`,
    ).run(JSON.stringify(acknowledgement), operationId, requestDigest, responseDigest)
    return this.requireInteractionOperation(operationId)
  }

  /** Treat one unknown operation effect as a tombstone for the interaction. */
  findEffectUnknownInteraction(
    runId: string,
    sessionId: string,
    interactionId: string,
  ): StoredInteractionOperation | null {
    const row = this.db.prepare(
      `SELECT operation_id
       FROM interaction_operations
       WHERE run_id = ? AND session_id = ? AND interaction_id = ? AND phase = 'effect_unknown'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runId, sessionId, interactionId) as { operation_id?: unknown } | undefined
    return typeof row?.operation_id === 'string' ? this.getInteractionOperation(row.operation_id) : null
  }

  getInteractionOperation(operationId: string): StoredInteractionOperation | null {
    const row = this.db.prepare('SELECT * FROM interaction_operations WHERE operation_id = ?').get(operationId) as Record<string, unknown> | undefined
    if (!row) return null
    const phase = row.phase as InteractionOperationPhase
    if (!isInteractionOperationPhase(phase)) throw new Error(`invalid interaction operation phase ${JSON.stringify(row.phase)}`)
    const acknowledgementJson = row.acknowledgement_json as string | null
    const effectProofJson = row.effect_proof_json as string | null
    const acknowledgement = acknowledgementJson
      ? InteractionAcknowledgementSchema.parse(JSON.parse(acknowledgementJson))
      : null
    const effectProof = effectProofJson
      ? parseStoredInteractionEffectProof(JSON.parse(effectProofJson))
      : null
    return {
      operationId: row.operation_id as string,
      callerId: row.caller_id as string,
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      interactionId: row.interaction_id as string,
      requestDigest: row.request_digest as string,
      responseDigest: row.response_digest as string,
      phase,
      effectProof,
      acknowledgement,
    }
  }

  private requireInteractionOperation(operationId: string): StoredInteractionOperation {
    const operation = this.getInteractionOperation(operationId)
    if (!operation) throw new Error(`interaction operation ${JSON.stringify(operationId)} is missing`)
    return operation
  }
}

function acknowledgedInteractionCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM interaction_operations WHERE phase = 'acknowledged'",
  ).get() as { count: number }
  return row.count
}

function assertInteractionOperationCapacity(db: Database.Database): void {
  const unknown = db.prepare(
    "SELECT COUNT(*) AS count FROM interaction_operations WHERE phase = 'effect_unknown'",
  ).get() as { count: number }
  if (unknown.count >= MAX_UNKNOWN_INTERACTION_OPERATIONS) {
    throw new InteractionOperationCapacityError(
      `interaction safety tombstone capacity ${MAX_UNKNOWN_INTERACTION_OPERATIONS} is exhausted; no provider effect was attempted`,
    )
  }
  const open = db.prepare(
    "SELECT COUNT(*) AS count FROM interaction_operations WHERE phase IN ('intent', 'effect_proven')",
  ).get() as { count: number }
  if (open.count >= MAX_OPEN_INTERACTION_OPERATIONS) {
    throw new InteractionOperationCapacityError(
      `interaction operation capacity ${MAX_OPEN_INTERACTION_OPERATIONS} is exhausted; no provider effect was attempted`,
    )
  }
}

function isInteractionOperationPhase(value: unknown): value is InteractionOperationPhase {
  return value === 'intent' || value === 'effect_proven' || value === 'acknowledged' || value === 'effect_unknown'
}

function parseStoredInteractionEffectProof(value: unknown): StoredInteractionEffectProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid stored interaction effect proof')
  }
  const record = value as Record<string, unknown>
  if (
    record.kind === 'native_response_returned'
    && typeof record.responseDigest === 'string'
    && typeof record.recordedAt === 'number'
  ) return record as StoredInteractionEffectProof
  if (
    record.kind === 'released_acknowledgement'
    && typeof record.operationRequestDigest === 'string'
    && typeof record.recordedAt === 'number'
  ) return record as StoredInteractionEffectProof
  throw new Error('invalid stored interaction effect proof')
}

export function interactionOperationMatches(
  operation: StoredInteractionOperation,
  input: InteractionOperationIdentity,
): boolean {
  // requestDigest covers the caller and complete response command. It also
  // lets acknowledged records from the released schema replay after upgrade.
  return operation.operationId === input.operationId
    && operation.callerId === input.callerId
    && operation.runId === input.runId
    && operation.sessionId === input.sessionId
    && operation.interactionId === input.interactionId
    && operation.requestDigest === input.requestDigest
}

function assertInteractionOperationIdentity(
  operation: StoredInteractionOperation,
  input: InteractionOperationIdentity,
): void {
  if (!interactionOperationMatches(operation, input)) {
    throw new Error(`interaction operation ${JSON.stringify(input.operationId)} conflicts with its durable identity`)
  }
}

function assertInteractionOperationDigest(
  operation: StoredInteractionOperation,
  requestDigest: string,
  responseDigest: string,
): void {
  if (operation.requestDigest !== requestDigest || operation.responseDigest !== responseDigest) {
    throw new Error(`interaction operation ${JSON.stringify(operation.operationId)} conflicts with its response digest`)
  }
}

function assertAcknowledgementIdentity(input: RecordInteractionOperationInput): void {
  const binding = input.acknowledgement.binding
  if (
    input.acknowledgement.operationId !== input.operationId
    || binding.runId !== input.runId
    || binding.sessionId !== input.sessionId
    || binding.interactionId !== input.interactionId
  ) {
    throw new Error(`interaction acknowledgement ${JSON.stringify(input.operationId)} conflicts with its durable identity`)
  }
}
