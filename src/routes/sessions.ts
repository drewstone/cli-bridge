/**
 * Legacy session-mapping fixture endpoints.
 *
 * The production server does not mount this helper.
 * Retained native sessions use `mountRetainedSessions` as their one canonical
 * `/v1/sessions` surface; this helper remains only for the pre-existing
 * mapping-store tests and callers that explicitly mount it themselves.
 */

import { Hono } from 'hono'
import type { SessionStore } from '../sessions/store.js'

export function mountLegacySessionMappings(app: Hono, deps: { sessions: SessionStore }): void {
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
