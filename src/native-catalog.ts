import { parseSeatSpec } from '@tangle-network/agent-interface'
import { BackendError, type ChatRequest, type NativeSubscriptionInvocation } from './backends/types.js'
import { localHarnesses, type Config } from './config.js'
import { detectLocalSeats, type LocalSeat } from './local-seats.js'
import type { ModelEntry } from './model-entry.js'
import { CLAUDE_SETTING_SOURCE_FLAGS } from './backends/claude.js'

export type CatalogRow = Omit<ModelEntry, 'authentication'>
export type NativeModelFacts = Omit<LocalSeat, 'harness'>
export type CodexCatalogReader = (options: { model: string; cwd: string; env: NodeJS.ProcessEnv; flags: readonly string[]; signal?: AbortSignal }) => Promise<NativeModelFacts>
const unknown = (fix?: string): NativeModelFacts => ({ provider: null, status: 'unknown', authMode: 'unknown', source: 'native_status', ...(fix ? { fix } : {}) })

/** Native configuration/auth facts stay on the Bridge host. Each context is fresh for admission. */
export function createNativeCatalog(config: Config, codex?: CodexCatalogReader, cwd = process.cwd()) {
  const context = (cwd: string, signal?: AbortSignal, sourceEnv: NodeJS.ProcessEnv = process.env, flags?: readonly string[]) => {
    const cache = new Map<string, Promise<NativeModelFacts>>()
    return (row: CatalogRow): Promise<NativeModelFacts> => {
      const key = `${row.backend}:${row.provider ?? ''}:${row.backend === 'codex' || row.backend === 'pi' ? row.id : ''}`
      const pending = cache.get(key)
      if (pending) return pending
      const descriptor = localHarnesses.find(([, harness]) => harness === row.backend)
      const facts = (async (): Promise<NativeModelFacts> => {
        if (!descriptor) return { ...unknown(), provider: row.provider }
        if (descriptor[0] === 'codex') return codex ? await codex({ model: row.id, cwd, env: sourceEnv, flags: flags ?? [], signal }) : unknown('codex login status')
        return (await detectLocalSeats({ config, harnesses: [descriptor[1]], provider: row.provider ?? undefined, model: nativeModel(row.id), env: sourceEnv, flags: flags ?? (row.backend === 'claude-code' ? CLAUDE_SETTING_SOURCE_FLAGS : []), cwd, signal }))[0]!
      })().catch((error) => { signal?.throwIfAborted(); return unknown(descriptor?.[2]) })
      cache.set(key, facts)
      return facts
    }
  }
  return {
    async admit(request: ChatRequest, backend: string, signal: AbortSignal): Promise<void> {
      if (!config.subscriptionsOnly) return
      let requestedProvider: string | null = null
      try { requestedProvider = parseSeatSpec(request.model).provider } catch { /* Unresolved native routes cannot assert a provider. */ }
      const descriptor = localHarnesses.find(([, harness]) => harness === backend)
      const refuse = (facts: NativeModelFacts, detail?: string): never => {
        const cause = !facts.provider ? 'provider_unresolved' : facts.authMode === 'api_key' ? 'api_key_selected'
          : facts.status === 'signed_out' || facts.status === 'missing' ? 'not_authenticated' : 'subscription_unverified'
        const fix = facts.fix ?? (facts.authMode === 'api_key' && descriptor
          ? [descriptor[0], ...descriptor[3]].join(' ') : descriptor?.[2]) ?? 'tangle graph run --help'
        throw new BackendError(`${detail ?? `Subscription authentication is required for the selected ${backend} route (${cause}).`} Run: ${fix}`,
          'subscription_required', undefined, { providerDispatch: 'not_started', subscription: { cause, fix, harness: backend, provider: facts.provider && /^[A-Za-z0-9._-]{1,128}$/u.test(facts.provider) ? facts.provider : null } })
      }
      if (!descriptor || request.execution && request.execution.kind !== 'host') refuse(unknown('tangle graph run --help'), 'Subscription admission requires a configured native backend on the actual Bridge host.')
      if (request.protectedModelCredential) refuse(unknown('tangle graph run --help'), 'A request-scoped model credential replaces native subscription authentication; remove that caller override.')
      let checked = false
      const check = async (invocation: NativeSubscriptionInvocation): Promise<void> => {
        if (invocation.credentialOverride || invocation.model !== request.model) refuse(unknown('tangle graph run --help'), 'The effective native model credential or route differs from the admitted subscription request.')
        if (invocation.endpoint) {
          let endpoint: URL
          try { endpoint = new URL(invocation.endpoint) } catch { return refuse(unknown('tangle graph run --help')) }
          if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) refuse(unknown('tangle graph run --help'))
        }
        if (invocation.executor !== 'host') refuse(unknown('tangle graph run --help'), 'Subscription readiness must be checked in the actual native executor.')
        const facts = await context(invocation.cwd, signal, invocation.env, invocation.flags)({ id: invocation.model, backend, object: 'model',
          provider: invocation.provider ?? requestedProvider ?? descriptor?.[4] ?? null })
        if (requestedProvider && facts.provider !== requestedProvider) {
          facts.provider = null
          if (!facts.fix && descriptor) facts.fix = [descriptor[0], ...descriptor[3]].join(' ')
        }
        if (!facts.provider || facts.status !== 'authenticated' || facts.authMode !== 'subscription') refuse(facts)
        checked = true
      }
      request.subscriptionAdmission = { check, require() {
        if (!checked) refuse(unknown('tangle graph run --help'), 'This native transport did not establish subscription admission.')
      } }
    },
    async describe(rows: readonly CatalogRow[], signal?: AbortSignal): Promise<ModelEntry[]> {
      signal?.throwIfAborted()
      const read = context(cwd, signal)
      const output: ModelEntry[] = []
      for (const row of rows) {
        const facts = await read(row)
        signal?.throwIfAborted()
        const authentication = { status: facts.status, authMode: facts.authMode, source: facts.source, ...(facts.fix ? { fix: facts.fix } : {}) }
        output.push({ ...row, provider: facts.provider, authentication,
          ...(facts.defaultModel && row.id === `${row.backend}/${facts.defaultModel}` ? { default: true } : {}),
          ...(row.backend === 'claude-code' && row.id === 'claude-code/opus' && !facts.defaultModel ? { recommended: true } : {}) })
        if (facts.defaultModel && !rows.some((entry) => entry.id === `${row.backend}/${facts.defaultModel}`)
          && !output.some((entry) => entry.id === `${row.backend}/${facts.defaultModel}`)) {
          output.push({ id: `${row.backend}/${facts.defaultModel}`, backend: row.backend, object: 'model',
            provider: facts.provider, authentication, default: true })
        }
      }
      return output
    },
  }
}

function nativeModel(id: string): string | undefined {
  try { const seat = parseSeatSpec(id); return seat.provider && seat.model.startsWith(`${seat.provider}/`) ? seat.model.slice(seat.provider.length + 1) : seat.model } catch { return undefined }
}
