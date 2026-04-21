/**
 * GET /v1/models — OpenAI-compatible model listing. Reports every
 * registered backend's harness prefix + known model aliases under it.
 *
 * Scheme: every id is `<harness>/<model>`. A caller routing through
 * tangle-router prefixes with `bridge/`; a direct cli-bridge call
 * skips that prefix.
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

      switch (b.name) {
        case 'claude':
          for (const model of ['sonnet', 'opus', 'haiku']) {
            data.push({ id: `claude/${model}`, object: 'model', backend: b.name })
          }
          break
        case 'claudish':
          // claudish accepts any <provider>@<model> string — just document
          // a couple of examples; opencode/claudish's own docs list more.
          for (const model of ['openrouter@deepseek/deepseek-r1', 'google@gemini-2.0-flash', 'zai@glm-4.6']) {
            data.push({ id: `claudish/${model}`, object: 'model', backend: b.name })
          }
          break
        case 'codex':
          data.push({ id: 'codex/gpt-5-codex', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'opencode':
          data.push({ id: 'opencode/kimi-for-coding', object: 'model', backend: b.name, note: 'stubbed — Kimi Code via opencode-kimi-full' })
          data.push({ id: 'opencode/anthropic/claude-sonnet-4-5', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'factory':
          data.push({ id: 'factory/droid', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'amp':
          data.push({ id: 'amp/default', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'forge':
          data.push({ id: 'forge/anthropic/claude-sonnet-4-5', object: 'model', backend: b.name, note: 'stubbed' })
          break
        case 'passthrough':
          for (const id of ['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-3-5-sonnet', 'moonshot/kimi-k2-0905-preview', 'zai/glm-4.6']) {
            data.push({ id, object: 'model', backend: b.name, note: 'forwards to vendor API — requires key' })
          }
          break
      }
    }

    return c.json({ object: 'list', data })
  })
}
