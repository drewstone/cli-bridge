import Database from 'better-sqlite3'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import {
  parseSafeRetainedMetadata,
  type RetainedJailPolicy,
  type RetainedRunAdmission,
  type RetainedRunClaim,
  type RetainedSessionRecord,
} from './store-contract.js'

export interface RetainedStoreContext {
  db: Database.Database
  getRetained(id: string): RetainedSessionRecord | null
  claimSessionIdentity(id: string, kind: 'legacy' | 'retained'): void
  hydrateRetained(row: Record<string, unknown>): RetainedSessionRecord
}

export function createRetained(ctx: RetainedStoreContext, args: {
  id: string
  createRequestDigest: string
  backend: string
  model: string
  cwd?: string | null
  metadata?: Record<string, unknown>
  capabilities: AgentEnvironmentCapabilities
  profileMaterializationReceipt?: Record<string, unknown> | null
  jailPolicy?: RetainedJailPolicy | null
}): RetainedSessionRecord {
  if (ctx.getRetained(args.id)) throw new Error(`retained session ${JSON.stringify(args.id)} already exists`)
  const metadata = parseSafeRetainedMetadata(args.metadata)
  ctx.claimSessionIdentity(args.id, 'retained')
  const now = Date.now()
  ctx.db.prepare(`INSERT INTO retained_sessions
    (id, create_request_digest, backend, model, cwd, turns, status, run_id, internal_id, created_at, last_used_at,
     metadata_json, capabilities_json, profile_receipt_json, context_boundary_json, jail_policy_json)
    VALUES (?, ?, ?, ?, ?, 0, 'created', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`).run(
    args.id, args.createRequestDigest, args.backend, args.model, args.cwd ?? null, now, now,
    JSON.stringify(metadata), JSON.stringify(args.capabilities),
    args.profileMaterializationReceipt ? JSON.stringify(args.profileMaterializationReceipt) : null,
    args.jailPolicy ? JSON.stringify(args.jailPolicy) : null,
  )
  return ctx.getRetained(args.id)!
}

export function getRetained(ctx: RetainedStoreContext, id: string): RetainedSessionRecord | null {
  const row = ctx.db.prepare('SELECT * FROM retained_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? ctx.hydrateRetained(row) : null
}
export function listRetained(ctx: RetainedStoreContext, limit = 100): RetainedSessionRecord[] {
  const rows = ctx.db.prepare('SELECT * FROM retained_sessions ORDER BY last_used_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
  return rows.map(row => ctx.hydrateRetained(row))
}
export function updateRetained(
  ctx: RetainedStoreContext,
  id: string,
  patch: Partial<Pick<RetainedSessionRecord, 'cwd' | 'turns' | 'status' | 'runId' | 'internalId' | 'metadata' | 'profileMaterializationReceipt' | 'contextBoundary'>>,
): RetainedSessionRecord | null {
  const current = ctx.getRetained(id)
  if (!current) return null
  const next = { ...current, ...patch, metadata: parseSafeRetainedMetadata(patch.metadata ?? current.metadata), lastUsedAt: Date.now() }
  ctx.db.prepare(`UPDATE retained_sessions SET cwd = ?, turns = ?, status = ?, run_id = ?, internal_id = ?,
    last_used_at = ?, metadata_json = ?, profile_receipt_json = ?, context_boundary_json = ? WHERE id = ?`).run(
    next.cwd, next.turns, next.status, next.runId, next.internalId, next.lastUsedAt, JSON.stringify(next.metadata),
    next.profileMaterializationReceipt ? JSON.stringify(next.profileMaterializationReceipt) : null,
    next.contextBoundary ? JSON.stringify(next.contextBoundary) : null, id,
  )
  return ctx.getRetained(id)
}

export function claimRetainedRun(ctx: RetainedStoreContext, input: {
  runId: string; sessionId: string; executionId: string; requestDigest: string; snapshot: unknown
}): RetainedRunClaim {
  return ctx.db.transaction((): RetainedRunClaim => {
    const now = Date.now()
    const inserted = ctx.db.prepare(`INSERT INTO retained_run_admissions
      (run_id, session_id, execution_id, request_digest, snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING`).run(
      input.runId, input.sessionId, input.executionId, input.requestDigest, JSON.stringify(input.snapshot), now, now,
    )
    const admission = getRetainedRun(ctx, input.runId)
    if (!admission) throw new Error(`retained run admission ${JSON.stringify(input.runId)} was not persisted`)
    if (admission.sessionId !== input.sessionId || admission.executionId !== input.executionId || admission.requestDigest !== input.requestDigest) return { kind: 'conflict', admission }
    return { kind: inserted.changes === 1 ? 'created' : 'replayed', admission }
  })()
}
export function getRetainedRun(ctx: RetainedStoreContext, runId: string): RetainedRunAdmission | null {
  const row = ctx.db.prepare('SELECT * FROM retained_run_admissions WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    runId: row.run_id as string, sessionId: row.session_id as string, executionId: row.execution_id as string,
    requestDigest: row.request_digest as string, snapshot: JSON.parse(row.snapshot_json as string) as unknown,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number,
  }
}
export function updateRetainedRun(ctx: RetainedStoreContext, runId: string, requestDigest: string, snapshot: unknown): RetainedRunAdmission {
  const updated = ctx.db.prepare(`UPDATE retained_run_admissions SET snapshot_json = ?, updated_at = ? WHERE run_id = ? AND request_digest = ?`).run(JSON.stringify(snapshot), Date.now(), runId, requestDigest)
  if (updated.changes !== 1) throw new Error(`retained run ${JSON.stringify(runId)} is not bound to this request`)
  return getRetainedRun(ctx, runId)!
}
