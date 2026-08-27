import Database from 'better-sqlite3'
import {
  InteractionAcknowledgementSchema,
  type InteractionAcknowledgement,
  type InteractionRequest,
} from '@tangle-network/agent-interface'
import type {
  RetainedControlOperationKind,
  StoredInteractionOperation,
  StoredRetainedControlOperation,
} from './store-contract.js'

type OperationInput = Omit<StoredInteractionOperation, 'phase'>

export function recordInteractionOperation(db: Database.Database, operation: StoredInteractionOperation): void {
  InteractionAcknowledgementSchema.parse(operation.acknowledgement)
  const existing = getInteractionOperation(db, operation.operationId)
  if (existing) {
    assertInteractionBinding(existing, operation)
    db.prepare(`UPDATE interaction_operations SET acknowledgement_json = ?, phase = 'settled'
      WHERE operation_id = ? AND request_digest = ?`).run(
      JSON.stringify(operation.acknowledgement), operation.operationId, operation.requestDigest,
    )
    return
  }
  insertInteractionOperation(db, operation, 'settled')
}

export function recordPendingInteractionOperation(db: Database.Database, operation: OperationInput): boolean {
  InteractionAcknowledgementSchema.parse(operation.acknowledgement)
  const result = db.prepare(`INSERT INTO interaction_operations
    (operation_id, caller_id, run_id, session_id, interaction_id, request_digest, acknowledgement_json, phase, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(operation_id) DO NOTHING`).run(
    operation.operationId, operation.callerId, operation.runId, operation.sessionId, operation.interactionId,
    operation.requestDigest, JSON.stringify(operation.acknowledgement), Date.now(),
  )
  const existing = getInteractionOperation(db, operation.operationId)
  if (!existing) throw new Error(`interaction operation ${JSON.stringify(operation.operationId)} was not durable`)
  assertInteractionBinding(existing, operation)
  return result.changes === 1
}

function insertInteractionOperation(
  db: Database.Database,
  operation: OperationInput,
  phase: StoredInteractionOperation['phase'],
): void {
  db.prepare(`INSERT INTO interaction_operations
    (operation_id, caller_id, run_id, session_id, interaction_id, request_digest, acknowledgement_json, phase, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    operation.operationId, operation.callerId, operation.runId, operation.sessionId, operation.interactionId,
    operation.requestDigest, JSON.stringify(operation.acknowledgement), phase, Date.now(),
  )
}

function assertInteractionBinding(existing: StoredInteractionOperation, operation: OperationInput): void {
  if (
    existing.callerId !== operation.callerId
    || existing.runId !== operation.runId
    || existing.sessionId !== operation.sessionId
    || existing.interactionId !== operation.interactionId
    || existing.requestDigest !== operation.requestDigest
  ) {
    throw new Error(`interaction operation ${JSON.stringify(operation.operationId)} is bound to different request data`)
  }
}

export function getInteractionOperation(db: Database.Database, operationId: string): StoredInteractionOperation | null {
  const row = db.prepare('SELECT * FROM interaction_operations WHERE operation_id = ?').get(operationId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    operationId: row.operation_id as string,
    callerId: row.caller_id as string,
    runId: row.run_id as string,
    sessionId: row.session_id as string,
    interactionId: row.interaction_id as string,
    requestDigest: row.request_digest as string,
    acknowledgement: JSON.parse(row.acknowledgement_json as string) as InteractionAcknowledgement,
    phase: row.phase === 'pending' ? 'pending' : 'settled',
  }
}

export function recordRetainedControlOperation(db: Database.Database, operation: StoredRetainedControlOperation): boolean {
  const result = db.prepare(`INSERT INTO retained_control_operations
    (operation_id, caller_id, kind, run_id, session_id, request_digest, acknowledgement_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING`).run(
    operation.operationId, operation.callerId, operation.kind, operation.runId, operation.sessionId,
    operation.requestDigest, JSON.stringify(operation.acknowledgement), Date.now(),
  )
  const existing = getRetainedControlOperation(db, operation.operationId)
  if (!existing) throw new Error(`retained control operation ${JSON.stringify(operation.operationId)} was not durable`)
  if (
    existing.callerId !== operation.callerId
    || existing.kind !== operation.kind
    || existing.runId !== operation.runId
    || existing.sessionId !== operation.sessionId
    || existing.requestDigest !== operation.requestDigest
  ) {
    throw new Error(`retained control operation ${JSON.stringify(operation.operationId)} is bound to different request data`)
  }
  return result.changes === 1
}

export function updateRetainedControlOperation(
  db: Database.Database,
  operationId: string,
  requestDigest: string,
  acknowledgement: Record<string, unknown>,
): void {
  db.prepare(`UPDATE retained_control_operations SET acknowledgement_json = ?
    WHERE operation_id = ? AND request_digest = ?
      AND json_extract(acknowledgement_json, '$.status') = 'pending'`).run(
    JSON.stringify(acknowledgement), operationId, requestDigest,
  )
}

export function getRetainedControlOperation(db: Database.Database, operationId: string): StoredRetainedControlOperation | null {
  const row = db.prepare('SELECT * FROM retained_control_operations WHERE operation_id = ?').get(operationId) as Record<string, unknown> | undefined
  if (!row) return null
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

export function findInteraction(db: Database.Database, sessionId: string, interactionId: string): InteractionRequest | null {
  const rows = db.prepare(
    'SELECT event_json FROM retained_events WHERE session_id = ? AND event_json LIKE ? ORDER BY session_sequence DESC',
  ).all(sessionId, '%"type":"interaction"%') as Array<{ event_json: string }>
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as { type?: string; request?: InteractionRequest }
    if (event.type === 'interaction' && event.request?.id === interactionId) return event.request
  }
  return null
}
