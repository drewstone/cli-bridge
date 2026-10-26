import { parseSeatSpec } from '@tangle-network/agent-interface'
import { BackendError, type ChatRequest, type NativeSubscriptionInvocation } from './backends/types.js'
import { localHarnesses, type Config } from './config.js'
import { detectLocalSeats } from './local-seats.js'
import { nativeObject as object, readClaudeNativeContext } from './lib/native-state.js'
import type { ModelEntry } from './model-entry.js'

type Authentication = ModelEntry['authentication']
export type CatalogRow = Omit<ModelEntry, 'authentication'>
export interface NativeModelFacts { provider: string | null; model?: string; authentication: Authentication }
export type CodexCatalogReader = (options: { model: string; cwd: string; env: NodeJS.ProcessEnv; flags: readonly string[]; signal?: AbortSignal }) => Promise<NativeModelFacts>
const unknown = (fix?: string): Authentication => ({ status: 'unknown', authMode: 'unknown', source: 'native_status', ...(fix ? { fix } : {}) })
const text = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) ? value : undefined

/** Native configuration/auth facts stay on the Bridge host. Each context is fresh for admission. */
export function createNativeCatalog(config: Config, codex?: CodexCatalogReader) {
  const context = (cwd: string, signal?: AbortSignal, sourceEnv: NodeJS.ProcessEnv = process.env, flags: readonly string[] = []) => {
    const cache = new Map<string, Promise<NativeModelFacts>>()
    return (row: CatalogRow): Promise<NativeModelFacts> => {
      const key = `${row.backend}:${row.provider ?? ''}:${row.backend === 'codex' || row.backend === 'pi' ? row.id : ''}`
      let pending = cache.get(key)
      if (!pending) {
        const descriptor = localHarnesses.find(([, harness]) => harness === row.backend)
        pending = (async (): Promise<NativeModelFacts> => {
          if (!descriptor) return { provider: row.provider, authentication: unknown() }
          const [name, harness, fix] = descriptor
          if (name === 'codex') return codex ? await codex({ model: row.id, cwd, env: sourceEnv, flags, signal }) : { provider: null, authentication: unknown('codex login status') }
          const { env, settings, flags: authFlags } = name === 'claude'
            ? await readClaudeNativeContext({ cwd, env: sourceEnv, flags }) : { env: sourceEnv, settings: [], flags: [] }
          const seat = (await detectLocalSeats({ config, harnesses: [harness], provider: row.provider ?? undefined, model: nativeModel(row.id), env, flags: authFlags, cwd, signal }))[0]!
          const { status, authMode, source } = seat
          let facts: NativeModelFacts = { provider: seat.provider, authentication: { status, authMode, source, ...(seat.fix ? { fix: seat.fix } : {}) } }
          if (name === 'claude') {
            facts.model = text(env.ANTHROPIC_MODEL) ?? settings.map((item) => text(item.model)).findLast(Boolean)
            const fixFor = (key: string): string => settings.some((item) => object(item.env)[key] !== undefined) || process.env[key] !== env[key] ? 'claude auth status --json' : `unset ${key}`
            const credential = env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : env.ANTHROPIC_API_KEY?.trim() ? 'ANTHROPIC_API_KEY' : null
            if (credential) facts.authentication = { status: 'configured', authMode: credential === 'ANTHROPIC_API_KEY' ? 'api_key' : 'unknown', source: 'native_store', fix: fixFor(credential) }
            const override = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
              .find((key) => env[key]?.trim() && !['0', 'false', 'off'].includes(env[key]!.toLowerCase()))
            if (override) facts = { ...facts, provider: null, authentication: { ...facts.authentication,
              fix: fixFor(override) } }
          }
          return facts
        })().catch((error) => { signal?.throwIfAborted(); return { provider: null, authentication: unknown(descriptor?.[2]) } })
        cache.set(key, pending)
      }
      return pending
    }
  }
  return {
    async admit(request: ChatRequest, backend: string, signal: AbortSignal): Promise<void> {
      if (!config.subscriptionsOnly) return
      let requestedProvider: string | null = null
      try { requestedProvider = parseSeatSpec(request.model).provider } catch { /* Unresolved native routes cannot assert a provider. */ }
      const descriptor = localHarnesses.find(([, harness]) => harness === backend)
      const refuse = (facts: NativeModelFacts, detail?: string): never => {
        const cause = !facts.provider ? 'provider_unresolved' : facts.authentication.authMode === 'api_key' ? 'api_key_selected'
          : facts.authentication.status === 'signed_out' || facts.authentication.status === 'missing' ? 'not_authenticated' : 'subscription_unverified'
        const fix = facts.authentication.fix ?? (facts.authentication.authMode === 'api_key' && descriptor
          ? [descriptor[0], ...descriptor[3]].join(' ') : descriptor?.[2]) ?? 'tangle graph run --help'
        throw new BackendError(`${detail ?? `Subscription authentication is required for the selected ${backend} route (${cause}).`} Run: ${fix}`,
          'subscription_required', undefined, { providerDispatch: 'not_started', subscription: { cause, fix, harness: backend, provider: facts.provider && /^[A-Za-z0-9._-]{1,128}$/u.test(facts.provider) ? facts.provider : null } })
      }
      if (!descriptor || request.execution && request.execution.kind !== 'host') refuse({ provider: null, authentication: unknown('tangle graph run --help') }, 'Subscription admission requires a configured native backend on the actual Bridge host.')
      if (request.protectedModelCredential) refuse({ provider: null, authentication: unknown('tangle graph run --help') }, 'A request-scoped model credential replaces native subscription authentication; remove that caller override.')
      let checked = false
      const check = async (invocation: NativeSubscriptionInvocation): Promise<void> => {
        if (invocation.credentialOverride || invocation.model !== request.model) refuse({ provider: null, authentication: unknown('tangle graph run --help') }, 'The effective native model credential or route differs from the admitted subscription request.')
        if (invocation.endpoint) {
          let endpoint: URL
          try { endpoint = new URL(invocation.endpoint) } catch { return refuse({ provider: null, authentication: unknown('tangle graph run --help') }) }
          if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) refuse({ provider: null, authentication: unknown('tangle graph run --help') })
        }
        if (invocation.executor !== 'host') refuse({ provider: null, authentication: unknown('tangle graph run --help') }, 'Subscription readiness must be checked in the actual native executor.')
        const facts = await context(invocation.cwd, signal, invocation.env, invocation.flags)({ id: invocation.model, backend, object: 'model',
          provider: invocation.provider ?? requestedProvider ?? descriptor?.[4] ?? null })
        if (requestedProvider && facts.provider !== requestedProvider) {
          facts.provider = null
          if (!facts.authentication.fix && descriptor) facts.authentication.fix = [descriptor[0], ...descriptor[3]].join(' ')
        }
        if (!facts.provider || facts.authentication.status !== 'authenticated' || facts.authentication.authMode !== 'subscription') refuse(facts)
        checked = true
      }
      request.subscriptionAdmission = { check, require() {
        if (!checked) refuse({ provider: null, authentication: unknown('tangle graph run --help') }, 'This native transport did not establish subscription admission.')
      } }
    },
    async describe(rows: readonly CatalogRow[]): Promise<ModelEntry[]> {
      const read = context(process.cwd())
      const output: ModelEntry[] = []
      for (const row of rows) {
        const facts = await read(row)
        output.push({ ...row, provider: facts.provider, authentication: facts.authentication,
          ...(facts.model && row.id === `${row.backend}/${facts.model}` ? { default: true } : {}),
          ...(row.backend === 'claude-code' && row.id === 'claude-code/opus' && !facts.model ? { recommended: true } : {}) })
        if (facts.model && !rows.some((entry) => entry.id === `${row.backend}/${facts.model}`)
          && !output.some((entry) => entry.id === `${row.backend}/${facts.model}`)) {
          output.push({ id: `${row.backend}/${facts.model}`, backend: row.backend, object: 'model',
            provider: facts.provider, authentication: facts.authentication, default: true })
        }
      }
      return output
    },
  }
}

function nativeModel(id: string): string | undefined {
  try { const seat = parseSeatSpec(id); return seat.provider && seat.model.startsWith(`${seat.provider}/`) ? seat.model.slice(seat.provider.length + 1) : seat.model } catch { return undefined }
}
