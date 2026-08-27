import Database from 'better-sqlite3'
import { RuntimeEventEnvelopeSchema, type RuntimeEventEnvelope } from '@tangle-network/agent-interface'
import type { RetainedEventRecord } from './store-contract.js'

export interface EventStoreContext {
  db: Database.Database
  hydrateRetainedEvent(row: Record<string, unknown>): RetainedEventRecord
}

export function appendRetainedEvent(ctx: EventStoreContext, sessionId: string, input: RuntimeEventEnvelope): RetainedEventRecord {
  RuntimeEventEnvelopeSchema.parse(input)
  return ctx.db.transaction((candidate: RuntimeEventEnvelope): RetainedEventRecord => {
    const existing = ctx.db.prepare('SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? AND sequence = ?').get(sessionId, candidate.runId, candidate.sequence) as Record<string, unknown> | undefined
    if (existing) {
      const hydrated = ctx.hydrateRetainedEvent(existing)
      if (hydrated.envelope.eventId !== candidate.eventId || JSON.stringify(hydrated.envelope.event) !== JSON.stringify(candidate.event)) throw new Error(`retained event ${JSON.stringify(candidate.eventId)} conflicts with an existing sequence`)
      return hydrated
    }
    const sessionSequence = (ctx.db.prepare('SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next FROM retained_events WHERE session_id = ?').get(sessionId) as { next: number }).next
    const envelope: RuntimeEventEnvelope = { ...candidate, cursor: String(sessionSequence) }
    ctx.db.prepare(`INSERT INTO retained_events (session_id, session_sequence, run_id, sequence, event_id, cursor, occurred_at, received_at, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, sessionSequence, envelope.runId, envelope.sequence, envelope.eventId, envelope.cursor, envelope.occurredAt ?? null, envelope.receivedAt, JSON.stringify(envelope.event),
    )
    ctx.db.prepare('UPDATE retained_sessions SET last_used_at = ? WHERE id = ?').run(Date.now(), sessionId)
    return { sessionId, sessionSequence, envelope }
  })(input)
}
export function retainedEventsAfter(ctx: EventStoreContext, sessionId: string, afterCursor = 0): RetainedEventRecord[] {
  const rows = ctx.db.prepare('SELECT * FROM retained_events WHERE session_id = ? AND session_sequence > ? ORDER BY session_sequence ASC').all(sessionId, afterCursor) as Record<string, unknown>[]
  return rows.map(row => ctx.hydrateRetainedEvent(row))
}
export function retainedEventsAfterRun(ctx: EventStoreContext, sessionId: string, runId: string, afterSequence = 0): RetainedEventRecord[] {
  const rows = ctx.db.prepare('SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? AND sequence > ? ORDER BY sequence ASC').all(sessionId, runId, afterSequence) as Record<string, unknown>[]
  return rows.map(row => ctx.hydrateRetainedEvent(row))
}
export function latestRetainedEventForRun(ctx: EventStoreContext, sessionId: string, runId: string): RetainedEventRecord | null {
  const row = ctx.db.prepare('SELECT * FROM retained_events WHERE session_id = ? AND run_id = ? ORDER BY sequence DESC LIMIT 1').get(sessionId, runId) as Record<string, unknown> | undefined
  return row ? ctx.hydrateRetainedEvent(row) : null
}
export function retainedRun(ctx: EventStoreContext & { getRetainedRun(runId: string): { sessionId: string } | null }, runId: string): { sessionId: string; lastSequence: number } | null {
  const row = ctx.db.prepare('SELECT session_id, MAX(sequence) AS last_sequence FROM retained_events WHERE run_id = ? GROUP BY session_id ORDER BY session_id LIMIT 1').get(runId) as { session_id: string; last_sequence: number } | undefined
  if (row) return { sessionId: row.session_id, lastSequence: row.last_sequence }
  const admission = ctx.getRetainedRun(runId)
  return admission ? { sessionId: admission.sessionId, lastSequence: 0 } : null
}
export function latestRetainedEvent(ctx: EventStoreContext, sessionId: string): RetainedEventRecord | null {
  const row = ctx.db.prepare('SELECT * FROM retained_events WHERE session_id = ? ORDER BY session_sequence DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined
  return row ? ctx.hydrateRetainedEvent(row) : null
}
