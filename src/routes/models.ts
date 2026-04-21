/**
 * GET /v1/models — OpenAI-compatible model listing. Static-ish for now;
 * reports the aliases each backend claims + a marker for which backend
 * serves them. Clients like Cursor / Claude Desktop / aider will call
 * this on connect to populate model pickers.
 */

import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'

interface ModelEntry {
  id: string
  object: 'model'
  backend: string
  note?: string
}

export function mountModels(app: Hono, deps: { registry: BackendRegistry }): void {
  app.get('/v1/models', async (c) => {
    const data: ModelEntry[] = []

    for (const b of deps.registry.all()) {
      const health = await b.health()
      if (health.state !== 'ready') continue

      // Static catalog by backend. When backends gain dynamic model
      // discovery (claude --list-models, codex list-models), swap in.
      switch (b.name) {
        case 'claude':
          for (const id of ['claude', 'claude-sonnet', 'claude-opus', 'claude-haiku', 'sonnet', 'opus', 'haiku']) {
            data.push({ id, object: 'model', backend: b.name })
          }
          break
        case 'codex':
          for (const id of ['codex', 'gpt-5-codex']) {
            data.push({ id, object: 'model', backend: b.name, note: 'stubbed' })
          }
          break
        case 'opencode':
          data.push({ id: 'kimi-for-coding', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'passthrough':
          for (const id of ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'kimi-k2-0905-preview', 'glm-4.6', 'glm-4-plus']) {
            data.push({ id, object: 'model', backend: b.name, note: 'forwards to vendor API — requires key' })
          }
          break
      }
    }

    return c.json({ object: 'list', data })
  })
}
