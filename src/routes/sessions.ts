/**
 * Session admin endpoints — list / delete session mappings. Useful for
 * debugging "which conversation am I resuming?" and for clearing state
 * after a backend rewrites its internal session format.
 */

import { Hono } from 'hono'
import type { SessionStore } from '../sessions/store.js'

export function mountSessions(app: Hono, deps: { sessions: SessionStore }): void {
  app.get('/v1/sessions', (c) => {
    const parsed = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Number.isNaN(parsed) ? 50 : Math.min(Math.max(1, parsed), 500)
    return c.json({ data: deps.sessions.list(limit) })
  })

  app.delete('/v1/sessions/:externalId', (c) => {
    const externalId = c.req.param('externalId')
    const backend = c.req.query('backend') ?? undefined
    const deleted = deps.sessions.delete(externalId, backend)
    return c.json({ deleted })
  })
}
