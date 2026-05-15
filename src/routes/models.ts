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
import type { ProfileCatalog } from '../profiles/loader.js'

interface ModelEntry {
  id: string
  object: 'model'
  backend: string
  note?: string
}

const CODEX_MODELS = [
  'default',
  'gpt-5-codex',
  'gpt-5.4',
  'gpt-5.5',
] as const

const OPENCODE_MODELS: ReadonlyArray<{ id: string; note?: string }> = [
  { id: 'kimi-for-coding/k2p6', note: 'Kimi K2.6 via opencode provider' },
  { id: 'zai-coding-plan/glm-5.1', note: 'GLM 5.1 via configured coding provider' },
  { id: 'zai-coding-plan/glm-5-turbo', note: 'GLM 5 Turbo via configured coding provider' },
  { id: 'deepseek/deepseek-v4-pro' },
  { id: 'deepseek/deepseek-v4-flash', note: 'DeepSeek v4 light/flash tier' },
]

const PI_MODELS: ReadonlyArray<{ id: string; note?: string }> = [
  { id: 'deepseek/deepseek-v4-pro', note: 'DeepSeek V4 Pro via pi' },
  { id: 'deepseek/deepseek-v4-flash', note: 'DeepSeek V4 Flash via pi' },
  { id: 'moonshot/kimi-k2.5', note: 'Moonshot Kimi K2.5 via pi' },
  { id: 'moonshot/kimi-k2.6', note: 'Moonshot Kimi K2.6 via pi (api.moonshot.ai)' },
  { id: 'moonshot/kimi-k2-thinking', note: 'Moonshot Kimi K2 Thinking via pi' },
  { id: 'kimi-for-coding-oauth/kimi-for-coding', note: 'Kimi K2.6 via pi kimi-for-coding-oauth (Kimi-for-Coding OAuth)' },
  { id: 'openai-codex/gpt-5.3-codex', note: 'GPT-5.3-codex via pi openai-codex' },
  { id: 'openai-codex/gpt-5.4', note: 'GPT-5.4 via pi openai-codex' },
  { id: 'openai-codex/gpt-5.5', note: 'GPT-5.5 via pi openai-codex' },
  { id: 'zai-coding-paas/glm-5.1', note: 'GLM 5.1 via pi zai-coding-paas extension' },
  { id: 'zai-coding-paas/glm-5-turbo', note: 'GLM 5 Turbo via pi zai-coding-paas extension' },
  { id: 'zai-coding-paas/glm-5', note: 'GLM 5 via pi zai-coding-paas extension' },
  { id: 'zai-glm/glm-4.7', note: 'GLM 4.7 via pi zai-glm (Anthropic-compat)' },
]

export function mountModels(
  app: Hono,
  deps: { registry: BackendRegistry; catalog?: ProfileCatalog },
): void {
  app.get('/v1/models', async (c) => {
    const data: ModelEntry[] = []

    for (const b of deps.registry.all()) {
      const health = await b.health()
      if (health.state !== 'ready') continue

      switch (b.name) {
        case 'claude-code':
          for (const model of ['sonnet', 'opus', 'haiku']) {
            data.push({ id: `claude-code/${model}`, object: 'model', backend: b.name })
          }
          break
        case 'kimi-code':
          for (const model of ['kimi-for-coding', 'kimi-k2.6']) {
            data.push({ id: `kimi-code/${model}`, object: 'model', backend: b.name })
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
          // `codex/default` ⇒ no `-c model=...` override; codex CLI uses
          // whatever the user's local config specifies. Works on any
          // codex subscription tier — including ChatGPT accounts that
          // don't have entitlement for the gated `gpt-5-codex` alias.
          for (const model of CODEX_MODELS) {
            data.push({ id: `codex/${model}`, object: 'model', backend: b.name })
          }
          break
        case 'opencode':
          for (const model of OPENCODE_MODELS) {
            data.push({
              id: `opencode/${model.id}`,
              object: 'model',
              backend: b.name,
              ...(model.note ? { note: model.note } : {}),
            })
          }
          break
        case 'pi':
          for (const model of PI_MODELS) {
            data.push({
              id: `pi/${model.id}`,
              object: 'model',
              backend: b.name,
              ...(model.note ? { note: model.note } : {}),
            })
          }
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
        case 'sandbox':
          // Cataloged AgentProfiles — each becomes an addressable model id.
          // Inline profiles are also accepted via `model: "sandbox"` + body
          // field `agent_profile`, but those don't appear in the listing.
          for (const e of deps.catalog?.list() ?? []) {
            data.push({
              id: `sandbox/${e.id}`,
              object: 'model',
              backend: b.name,
              note: e.profile.description ?? 'sandbox AgentProfile',
            })
          }
          data.push({
            id: 'sandbox',
            object: 'model',
            backend: b.name,
            note: 'inline profile mode — pass full AgentProfile in body field `agent_profile`',
          })
          break
      }
    }

    return c.json({ object: 'list', data })
  })
}
