/** Durable session identity, retained-run, event, and operation storage. */

import Database from 'better-sqlite3'
import type {
  AgentEnvironmentCapabilities,
  InteractionRequest,
  RuntimeEventEnvelope,
} from '@tangle-network/agent-interface'
import {
  sanitizeLegacySessionMetadata,
  SessionExecutionAbortedError,
  SessionIdentityConflictError,
  type RetainedEventRecord,
  type RetainedRunAdmission,
  type RetainedRunClaim,
  type RetainedSessionRecord,
  type RetainedSessionStatus,
  type SessionExecutionLane,
  type SessionExecutionLease,
  type SessionExecutionWaiter,
  type SessionRecord,
  type StoredInteractionOperation,
  type StoredRetainedControlOperation,
} from './store-contract.js'
import {
  appendRetainedEvent,
  latestRetainedEvent,
  latestRetainedEventForRun,
  retainedEventsAfter,
  retainedEventsAfterRun,
  retainedRun,
  type EventStoreContext,
} from './store-events.js'
import {
  findInteraction,
  getInteractionOperation,
  getRetainedControlOperation,
  recordInteractionOperation,
  recordPendingInteractionOperation,
  recordRetainedControlOperation,
  updateRetainedControlOperation,
} from './store-operations.js'
import {
  claimRetainedRun,
  createRetained,
  getRetained,
  getRetainedRun,
  listRetained,
  updateRetained,
  updateRetainedRun,
  type RetainedStoreContext,
} from './store-retained.js'
import { openSessionDatabase, restrictDatabaseFiles } from './store-database.js'

export * from './store-contract.js'

export class SessionStore {
  private readonly db: Database.Database
  private readonly databasePath: string
  private readonly executionLanes = new Map<string, SessionExecutionLane>()

  constructor(dataDir: string) {
    const opened = openSessionDatabase(dataDir)
    this.db = opened.db
    this.databasePath = opened.databasePath
  }

  get(externalId: string, backend: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE external_id = ? AND backend = ?')
      .get(externalId, backend) as Record<string, unknown> | undefined
    return row ? this.hydrate(row) : null
  }

  claimSessionIdentity(id: string, kind: 'legacy' | 'retained'): void {
    const existing = this.db.prepare('SELECT kind FROM session_identities WHERE id = ?')
      .get(id) as { kind: 'legacy' | 'retained' } | undefined
    if (existing && existing.kind !== kind) throw new SessionIdentityConflictError(id, kind, existing.kind)
    if (!existing) this.db.prepare(
      'INSERT INTO session_identities (id, kind, created_at) VALUES (?, ?, ?)',
    ).run(id, kind, Date.now())
  }

  acquireExecution(externalId: string, backend: string, signal?: AbortSignal): Promise<SessionExecutionLease> {
    if (signal?.aborted) return Promise.reject(new SessionExecutionAbortedError())
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
    const metadata = sanitizeLegacySessionMetadata({ ...(existing?.metadata ?? {}), ...(args.metadata ?? {}) })
    this.db.prepare(`INSERT INTO sessions
      (external_id, backend, internal_id, cwd, turns, created_at, last_used_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id, backend) DO UPDATE SET internal_id = excluded.internal_id,
        cwd = excluded.cwd, turns = excluded.turns, last_used_at = excluded.last_used_at,
        metadata_json = excluded.metadata_json`).run(
      args.externalId, args.backend, args.internalId, args.cwd ?? null, turns, createdAt, now, JSON.stringify(metadata),
    )
    return { externalId: args.externalId, backend: args.backend, internalId: args.internalId, cwd: args.cwd ?? null, turns, createdAt, lastUsedAt: now, metadata }
  }

  list(limit = 100): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY last_used_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map(row => this.hydrate(row))
  }

  delete(externalId: string, backend?: string): number {
    const deleted = backend
      ? this.db.prepare('DELETE FROM sessions WHERE external_id = ? AND backend = ?').run(externalId, backend).changes
      : this.db.prepare('DELETE FROM sessions WHERE external_id = ?').run(externalId).changes
    const remaining = this.db.prepare('SELECT 1 FROM sessions WHERE external_id = ? LIMIT 1').get(externalId)
    if (!remaining) this.db.prepare("DELETE FROM session_identities WHERE id = ? AND kind = 'legacy'").run(externalId)
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
    jailPolicy?: RetainedSessionRecord['jailPolicy']
  }): RetainedSessionRecord {
    return createRetained(this.retainedContext(), args)
  }

  getRetained(id: string): RetainedSessionRecord | null {
    return getRetained(this.retainedContext(), id)
  }

  listRetained(limit = 100): RetainedSessionRecord[] {
    return listRetained(this.retainedContext(), limit)
  }

  updateRetained(
    id: string,
    patch: Partial<Pick<RetainedSessionRecord, 'cwd' | 'turns' | 'status' | 'runId' | 'internalId' | 'metadata' | 'profileMaterializationReceipt' | 'contextBoundary'>>,
  ): RetainedSessionRecord | null {
    return updateRetained(this.retainedContext(), id, patch)
  }

  claimRetainedRun(input: {
    runId: string
    sessionId: string
    executionId: string
    requestDigest: string
    snapshot: unknown
  }): RetainedRunClaim {
    return claimRetainedRun(this.retainedContext(), input)
  }

  getRetainedRun(runId: string): RetainedRunAdmission | null {
    return getRetainedRun(this.retainedContext(), runId)
  }

  updateRetainedRun(runId: string, requestDigest: string, snapshot: unknown): RetainedRunAdmission {
    return updateRetainedRun(this.retainedContext(), runId, requestDigest, snapshot)
  }

  appendRetainedEvent(sessionId: string, input: RuntimeEventEnvelope): RetainedEventRecord {
    return appendRetainedEvent(this.eventContext(), sessionId, input)
  }

  retainedEventsAfter(sessionId: string, afterCursor = 0): RetainedEventRecord[] {
    return retainedEventsAfter(this.eventContext(), sessionId, afterCursor)
  }

  retainedEventsAfterRun(sessionId: string, runId: string, afterSequence = 0): RetainedEventRecord[] {
    return retainedEventsAfterRun(this.eventContext(), sessionId, runId, afterSequence)
  }

  latestRetainedEventForRun(sessionId: string, runId: string): RetainedEventRecord | null {
    return latestRetainedEventForRun(this.eventContext(), sessionId, runId)
  }

  retainedRun(runId: string): { sessionId: string; lastSequence: number } | null {
    return retainedRun({ ...this.eventContext(), getRetainedRun: id => this.getRetainedRun(id) }, runId)
  }

  latestRetainedEvent(sessionId: string): RetainedEventRecord | null {
    return latestRetainedEvent(this.eventContext(), sessionId)
  }

  recordInteractionOperation(operation: StoredInteractionOperation): void {
    recordInteractionOperation(this.db, operation)
  }

  recordPendingInteractionOperation(operation: Omit<StoredInteractionOperation, 'phase'>): boolean {
    return recordPendingInteractionOperation(this.db, operation)
  }

  getInteractionOperation(operationId: string): StoredInteractionOperation | null {
    return getInteractionOperation(this.db, operationId)
  }

  recordRetainedControlOperation(operation: StoredRetainedControlOperation): boolean {
    return recordRetainedControlOperation(this.db, operation)
  }

  updateRetainedControlOperation(operationId: string, requestDigest: string, acknowledgement: Record<string, unknown>): void {
    updateRetainedControlOperation(this.db, operationId, requestDigest, acknowledgement)
  }

  getRetainedControlOperation(operationId: string): StoredRetainedControlOperation | null {
    return getRetainedControlOperation(this.db, operationId)
  }

  findInteraction(sessionId: string, interactionId: string): InteractionRequest | null {
    return findInteraction(this.db, sessionId, interactionId)
  }

  close(): void {
    for (const lane of this.executionLanes.values()) {
      for (const waiter of lane.waiters.splice(0)) {
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new SessionExecutionAbortedError())
      }
    }
    this.executionLanes.clear()
    restrictDatabaseFiles(this.databasePath)
    this.db.close()
    restrictDatabaseFiles(this.databasePath)
  }

  private retainedContext(): RetainedStoreContext {
    return {
      db: this.db,
      getRetained: id => this.getRetained(id),
      claimSessionIdentity: (id, kind) => this.claimSessionIdentity(id, kind),
      hydrateRetained: row => this.hydrateRetained(row),
    }
  }

  private eventContext(): EventStoreContext {
    return { db: this.db, hydrateRetainedEvent: row => this.hydrateRetainedEvent(row) }
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
        if (this.executionLanes.get(key) === lane) this.executionLanes.delete(key)
      },
    }
  }

  private hydrate(row: Record<string, unknown>): SessionRecord {
    let rawMetadata: unknown = {}
    try { rawMetadata = JSON.parse((row.metadata_json as string) || '{}') } catch { /* discard malformed legacy metadata */ }
    return {
      externalId: row.external_id as string,
      backend: row.backend as string,
      internalId: row.internal_id as string,
      cwd: (row.cwd as string | null) ?? null,
      turns: row.turns as number,
      createdAt: row.created_at as number,
      lastUsedAt: row.last_used_at as number,
      metadata: sanitizeLegacySessionMetadata(rawMetadata),
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
      profileMaterializationReceipt: row.profile_receipt_json ? JSON.parse(row.profile_receipt_json as string) as Record<string, unknown> : null,
      contextBoundary: row.context_boundary_json ? JSON.parse(row.context_boundary_json as string) as Record<string, unknown> : null,
      jailPolicy: row.jail_policy_json ? JSON.parse(row.jail_policy_json as string) as RetainedSessionRecord['jailPolicy'] : null,
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
