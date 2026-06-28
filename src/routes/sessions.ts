/**
 * Session admin endpoints — list / delete session mappings. Useful for
 * debugging "which conversation am I resuming?" and for clearing state
 * after a backend rewrites its internal session format.
 */

import { Hono } from 'hono'
import type { SessionRecord, SessionStore } from '../sessions/store.js'

const REDACTED = '[redacted]'

function sanitizeSessionForAdmin(session: SessionRecord): SessionRecord {
  return {
    ...session,
    metadata: sanitizeValue(session.metadata) as Record<string, unknown>,
  }
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item))
  if (!value || typeof value !== 'object') return value

  const clean: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    clean[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(child)
  }
  return clean
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|bearer|authorization|credential|private[_-]?key/i.test(key)
}

export function mountSessions(app: Hono, deps: { sessions: SessionStore }): void {
  app.get('/v1/sessions', (c) => {
    const parsed = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Number.isNaN(parsed) ? 50 : Math.min(Math.max(1, parsed), 500)
    return c.json({ data: deps.sessions.list(limit).map(sanitizeSessionForAdmin) })
  })

  app.delete('/v1/sessions/:externalId', (c) => {
    const externalId = c.req.param('externalId')
    const backend = c.req.query('backend') ?? undefined
    const deleted = deps.sessions.delete(externalId, backend)
    return c.json({ deleted })
  })
}
