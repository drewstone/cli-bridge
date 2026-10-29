/**
 * GET /v1/models — OpenAI-compatible model listing. Reports every
 * registered backend's harness prefix + known model aliases under it.
 *
 * Scheme: every id is `<harness>/<model>`. A caller routing through
 * tangle-router prefixes with `bridge/`; a direct cli-bridge call
 * skips that prefix.
 */

import type { Hono } from 'hono'
import { boundedProbe, resolveHealthProbeTimeoutMs } from '../backends/health.js'
import type { BackendRegistry } from '../backends/registry.js'
import type { ProfileCatalog } from '../profiles/loader.js'
import { discoverModels, parseOpencodeModels, parsePiModels, type ModelSpec } from '../lib/model-discovery.js'

import type { ModelEntry } from '../model-entry.js'
type CatalogRow = Omit<ModelEntry, 'authentication'>

const ALIASES: Record<string, readonly ModelSpec[]> = {
  'claude-code': ['sonnet', 'opus', 'haiku'].map((id) => ({ id })),
  'kimi-code': ['kimi-for-coding', 'kimi-k2.6'].map((id) => ({ id })),
  claudish: ['openrouter@deepseek/deepseek-r1', 'google@gemini-2.0-flash', 'zai@glm-4.6'].map((id) => ({ id })),
  cursor: [{ id: 'default', note: 'native configured model; explicit cursor/<model> routes are passed to cursor-agent' }],
  codex: [{ id: 'default', note: 'native no-override wire route; concrete native model required for a canonical seat' }],
}

// The opencode/pi catalogs are discovered live from each CLI's own model list
// (see lib/model-discovery.ts). These curated arrays are the never-empty
// FALLBACK seed used when discovery fails, and they also define which provider
// prefixes are routable — discovery keeps only models under these providers,
// dropping the CLI's free tiers and unconfigured providers.
const OPENCODE_MODELS: ReadonlyArray<ModelSpec> = [
  { id: 'kimi-for-coding/k3', note: 'Kimi K3 via the Kimi Code subscription' },
  { id: 'zai-coding-plan/glm-5.3', note: 'GLM 5.3 via the Z.ai coding plan' },
  { id: 'zai-coding-plan/glm-5-turbo', note: 'GLM 5 Turbo via the Z.ai coding plan' },
  { id: 'deepseek/deepseek-v4-pro' },
  { id: 'deepseek/deepseek-flash', note: 'DeepSeek V4.1 Flash; deepseek-v4-flash is a retired alias' },
  // The router seed makes tangle-router a routable opencode provider, so a host
  // whose direct provider account is unfunded can still reach the same model.
  { id: 'tangle-router/deepseek/deepseek-v4.1-flash', note: 'DeepSeek V4.1 Flash via opencode → tangle-router (TANGLE_API_KEY required)' },
]

const PI_MODELS: ReadonlyArray<ModelSpec> = [
  { id: 'deepseek/deepseek-v4-pro', note: 'DeepSeek V4 Pro via pi' },
  { id: 'deepseek/deepseek-v4-flash', note: 'DeepSeek V4 Flash via pi' },
  { id: 'deepseek/deepseek-v4.1-flash', note: 'DeepSeek V4.1 Flash via pi → tangle-router' },
  { id: 'moonshot/kimi-k2.5', note: 'Moonshot Kimi K2.5 via pi' },
  { id: 'moonshot/kimi-k2.6', note: 'Moonshot Kimi K2.6 via pi' },
  { id: 'moonshot/kimi-k2-thinking', note: 'Moonshot Kimi K2 Thinking via pi' },
  { id: 'kimi-for-coding-oauth/kimi-k2.6', note: 'Kimi K2.6 via pi kimi-for-coding-oauth extension' },
  { id: 'openai-codex/gpt-5.3-codex-spark', note: 'GPT-5.3 Codex Spark via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.4', note: 'GPT-5.4 via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.4-mini', note: 'GPT-5.4 Mini via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.5', note: 'GPT-5.5 via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.6-luna', note: 'GPT-5.6 Luna via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.6-sol', note: 'GPT-5.6 Sol via pi openai-codex extension' },
  { id: 'openai-codex/gpt-5.6-terra', note: 'GPT-5.6 Terra via pi openai-codex extension' },
  { id: 'zai-coding-paas/glm-5.1', note: 'GLM 5.1 via pi zai-coding-paas extension' },
  { id: 'zai-coding-paas/glm-5-turbo', note: 'GLM 5 Turbo via pi zai-coding-paas extension' },
  { id: 'zai-coding-paas/glm-5', note: 'GLM 5 via pi zai-coding-paas extension' },
  { id: 'zai-glm/glm-4.7', note: 'GLM 4.7 via pi zai-glm (Anthropic-compat)' },
  { id: 'tangle-router/gemini-3-pro-preview', note: 'Gemini 3 Pro Preview via pi → tangle-router (TANGLE_API_KEY required)' },
  { id: 'tangle-router/gemini-2.5-flash-lite', note: 'Gemini 2.5 Flash Lite via pi → tangle-router (TANGLE_API_KEY required)' },
  { id: 'tangle-router/gpt-5-mini', note: 'GPT-5 Mini via pi → tangle-router (TANGLE_API_KEY required)' },
]

/** Routable provider prefixes = the distinct providers named in each fallback seed. */
const providersOf = (specs: readonly ModelSpec[]): string[] => [...new Set(specs.map((m) => m.id.split('/')[0]!))]
const OPENCODE_PROVIDERS = providersOf(OPENCODE_MODELS)
const PI_PROVIDERS = providersOf(PI_MODELS)

interface ModelCatalogDependencies {
  registry: BackendRegistry
  catalog?: ProfileCatalog
  opencodeBin?: string
  piBin?: string
  cwd?: string
  describe: (rows: readonly CatalogRow[], signal?: AbortSignal) => Promise<ModelEntry[]>
}

/** The HTTP and local consumers use identical route collection and native facts. */
export async function collectModels(deps: ModelCatalogDependencies, signal?: AbortSignal): Promise<ModelEntry[]> {
    signal?.throwIfAborted()
  const data: CatalogRow[] = []
  const add = (backend: string, models: readonly ModelSpec[], prefix = `${backend}/`, providerSeparator?: '/' | '@'): void => {
    for (const model of models) data.push({ id: prefix + model.id, object: 'model', backend,
      provider: providerSeparator ? model.id.split(providerSeparator)[0]! : null,
      ...(model.note ? { note: model.note } : {}) })
  }
  for (const backend of deps.registry.all()) {
    const health = await boundedProbe(backend, resolveHealthProbeTimeoutMs(), signal)
    signal?.throwIfAborted()
    if (health.state !== 'ready') continue
    const name = backend.name
    if (name === 'opencode' || name === 'pi') {
      const isPi = name === 'pi'
      add(name, await discoverModels(name, {
        bin: (isPi ? deps.piBin : deps.opencodeBin) ?? name,
        args: isPi ? ['--offline', '--list-models'] : ['models'],
        providers: isPi ? PI_PROVIDERS : OPENCODE_PROVIDERS,
        parse: isPi ? parsePiModels : parseOpencodeModels,
        fallback: isPi ? PI_MODELS : OPENCODE_MODELS,
      }, { cwd: deps.cwd, signal }), undefined, '/')
    } else if (name === 'sandbox') {
      add(name, (deps.catalog?.list() ?? []).map((entry) => ({ id: entry.id,
        note: entry.profile.description ?? 'sandbox AgentProfile' })))
      data.push({ id: 'sandbox', object: 'model', backend: name, provider: null,
        note: 'inline profile mode — pass full AgentProfile in body field `agent_profile`' })
    } else add(name, ALIASES[name] ?? [], undefined, name === 'claudish' ? '@' : undefined)
  }
  const described = await deps.describe(data, signal)
  signal?.throwIfAborted()
  return described
}

export function mountModels(app: Hono, deps: ModelCatalogDependencies): void {
  app.get('/v1/models', async (c) => c.json({ object: 'list', data: await collectModels(deps, c.req.raw.signal) }))
}
