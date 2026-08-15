/**
 * Session admin endpoints — list / delete session mappings. Useful for
 * debugging "which conversation am I resuming?" and for clearing state
 * after a backend rewrites its internal session format.
 */

import { Hono } from 'hono'
import type { SessionStore } from '../sessions/store.js'
import type { RetainedSessionService } from '../sessions/retained.js'

export function mountSessions(app: Hono, deps: {
  sessions: SessionStore
  /** The retained API shares this resource path with legacy session mappings. */
  retained?: Pick<RetainedSessionService, 'list'>
}): void {
  app.get('/v1/sessions', (c) => {
    const parsed = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Number.isNaN(parsed) ? 50 : Math.min(Math.max(1, parsed), 500)
    const legacy = deps.sessions.list(limit)
    if (!deps.retained) return c.json({ data: legacy })
    return c.json({ object: 'list', data: [...deps.retained.list(limit), ...legacy] })
  })

  app.delete('/v1/sessions/:externalId', (c) => {
    const externalId = c.req.param('externalId')
    const backend = c.req.query('backend') ?? undefined
    const deleted = deps.sessions.delete(externalId, backend)
    return c.json({ deleted })
  })
}
