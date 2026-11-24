/**
 * GET /v1/profiles — list cataloged AgentProfiles. Each entry returns the id, basic metadata, and the full profile body
 * so callers can introspect what they'd be invoking before sending a request.
 *
 * POST /profiles/:id/v1/chat/completions — a chat completion with the cataloged profile `:id` applied. A caller that
 * can set only a base URL, such as a publisher's benchmark runner, reaches a profile through `<bridge>/profiles/<id>/v1`.
 */

import type { AgentProfile } from '@tangle-network/agent-interface'
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

  // The request runs exactly as /v1/chat/completions with `agent_profile` set to the catalog entry, on the harness its
  // `model` names, so admission, jail, caller tools and receipts are the chat route's own. An id the catalog lacks rereads
  // the directory once, so a profile written after start needs no restart; a changed profile needs a new id. A body that
  // already carries a profile is refused rather than merged. The chat route refuses system-role messages beside a profile,
  // and a runner cannot stop sending its own, so they move into the profile as `prompt.appendSystemPrompt`: the same
  // privileged position, after the profile's prompt.
  app.post('/profiles/:id/v1/chat/completions', async (c) => {
    const id = c.req.param('id')
    let profile = deps.catalog.get(id)
    if (!profile) {
      deps.catalog.reload()
      profile = deps.catalog.get(id)
    }
    if (!profile) return c.json({ error: { message: `profile not found: ${id}`, type: 'not_found' } }, 404)
    const body: unknown = await c.req.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400)
    }
    if ('agent_profile' in body) {
      return c.json({ error: { message: `/profiles/${id}/v1 applies the cataloged profile ${id}; a body agent_profile goes to /v1/chat/completions`, type: 'invalid_request_error' } }, 400)
    }
    const messages: unknown[] = Array.isArray((body as { messages?: unknown }).messages) ? (body as { messages: unknown[] }).messages : []
    const isSystem = (message: unknown) => (message as { role?: unknown } | null)?.role === 'system'
    const system = messages.filter(isSystem).map((message) => textOf((message as { content?: unknown }).content))
    if (system.includes(null)) return c.json({ error: { message: 'a system message must be text to join the profile prompt', type: 'invalid_request_error' } }, 400)
    const applied: AgentProfile = system.length === 0 ? profile : { ...profile, prompt: { ...profile.prompt,
      appendSystemPrompt: [profile.prompt?.appendSystemPrompt, ...system].filter((part) => typeof part === 'string' && part.length > 0).join('\n\n') } }
    const url = new URL(c.req.url)
    url.pathname = '/v1/chat/completions'
    const headers = new Headers(c.req.raw.headers)
    headers.delete('content-length')
    const forwarded = { ...body, ...(system.length ? { messages: messages.filter((message) => !isSystem(message)) } : {}), agent_profile: applied }
    return app.fetch(new Request(url, { method: 'POST', headers, body: JSON.stringify(forwarded), signal: c.req.raw.signal }), c.env)
  })
}

/** A message's text: a string, or text parts only; null for anything else. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.map((part) => (part as { type?: unknown; text?: unknown } | null)?.type === 'text' ? (part as { text?: unknown }).text : null)
  return parts.every((part): part is string => typeof part === 'string') ? parts.join('') : null
}
