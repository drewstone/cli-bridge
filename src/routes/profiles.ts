/**
 * GET /v1/profiles — list cataloged AgentProfiles available for
 * sandbox dispatch. Each entry returns the id, basic metadata, and the
 * full profile body so callers can introspect what they'd be invoking
 * before sending a request.
 */

import { Hono } from 'hono'
import type { ProfileCatalog } from '../profiles/loader.js'

interface ProfileListEntry {
  id: string
  name?: string
  description?: string
  tags?: string[]
  loadedAt: string
}

export function mountProfiles(app: Hono, deps: { catalog: ProfileCatalog }): void {
  app.get('/v1/profiles', (c) => {
    const data: ProfileListEntry[] = deps.catalog.list().map((e) => ({
      id: e.id,
      name: e.profile.name,
      description: e.profile.description,
      tags: e.profile.tags,
      loadedAt: e.loadedAt,
    }))
    return c.json({ object: 'list', data })
  })

  app.get('/v1/profiles/:id', (c) => {
    const id = c.req.param('id')
    const profile = deps.catalog.get(id)
    if (!profile) {
      return c.json({ error: { message: `profile not found: ${id}`, type: 'not_found' } }, 404)
    }
    return c.json({ id, profile })
  })
}
