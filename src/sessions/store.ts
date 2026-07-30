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
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

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

export interface SessionExecutionLease {
  release(): void
}

export class SessionExecutionAbortedError extends Error {
  constructor() {
    super('session execution was cancelled while waiting for the previous turn')
    this.name = 'SessionExecutionAbortedError'
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

export class SessionStore {
  private db: Database.Database
  private readonly executionLanes = new Map<string, SessionExecutionLane>()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    const path = join(dataDir, 'sessions.sqlite')
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
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
    `)
  }

  get(externalId: string, backend: string): SessionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM sessions WHERE external_id = ? AND backend = ?',
    ).get(externalId, backend) as Record<string, unknown> | undefined
    if (!row) return null
    return this.hydrate(row)
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
    const now = Date.now()
    const existing = this.get(args.externalId, args.backend)
    const turns = existing ? existing.turns + 1 : 1
    const createdAt = existing?.createdAt ?? now
    const metadata = { ...(existing?.metadata ?? {}), ...(args.metadata ?? {}) }
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

  list(limit = 100): SessionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions ORDER BY last_used_at DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[]
    return rows.map(r => this.hydrate(r))
  }

  delete(externalId: string, backend?: string): number {
    if (backend) {
      return this.db.prepare(
        'DELETE FROM sessions WHERE external_id = ? AND backend = ?',
      ).run(externalId, backend).changes
    }
    return this.db.prepare(
      'DELETE FROM sessions WHERE external_id = ?',
    ).run(externalId).changes
  }

  close(): void {
    for (const lane of this.executionLanes.values()) {
      for (const waiter of lane.waiters.splice(0)) {
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new SessionExecutionAbortedError())
      }
    }
    this.executionLanes.clear()
    this.db.close()
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
      metadata: JSON.parse((row.metadata_json as string) || '{}'),
    }
  }
}
