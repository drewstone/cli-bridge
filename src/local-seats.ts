import { spawn } from 'node:child_process'
import { cursorEnvironment, cursorPlanHasRoom } from './lib/cursor-auth.js'
import { join, resolve } from 'node:path'
import { findGitDir } from './jail/types.js'
import { loadConfig, localHarnesses, type Config } from './config.js'
import { backendHome } from './jail/auth-preserve.js'
import { probeNativeStatus, type NativeStatus } from './lib/native-status.js'
import { kapReady } from './backends/kimi-text-only.js'
import { killTree, killTreeSync } from './executors/process-tree.js'
import { nativeObject as object, nativeJson as decode, nativeIdentifier, readNativeState as state } from './lib/native-state.js'

export interface LocalSeat {
  harness: typeof localHarnesses[number][1]
  provider: string | null
  /** Native configured default, never a served model identity. */
  defaultModel?: string
  status: 'authenticated' | 'configured' | 'signed_out' | 'missing' | 'unknown'
  /** `free`: the harness's own catalog prices this exact model at zero and it needs no credential. */
  authMode: 'subscription' | 'free' | 'api_key' | 'unknown'
  /** `plan_key`: the stored key belongs to a flat-rate plan in the Bridge's plan-keyed provider table; `authMode` is `subscription`. */
  credential?: 'plan_key'
  source: 'native_status' | 'native_store' | 'native_catalog'
  fix?: string
}

/**
 * Native provider ids of flat-rate coding plans that a subscription pays for and a plan key authenticates.
 * Their per-token API siblings (`zai`, `moonshotai`) are other providers. Named here, never inferred from a key.
 */
const PLAN_KEYED_PROVIDERS: ReadonlySet<string> = new Set(['zai-coding-plan', 'kimi-for-coding'])

export interface LocalSeatOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  model?: string
  flags?: readonly string[]
  /** Resolve this native provider only; omitted retains aggregate harness inventory. */
  provider?: string
  harnesses?: readonly LocalSeat['harness'][]
  config?: Config
  timeoutMs?: number
  signal?: AbortSignal
}

/** Query local login state without an inference, refresh, or credential in the returned value. */
export async function detectLocalSeats(options: LocalSeatOptions = {}): Promise<LocalSeat[]> {
  options.signal?.throwIfAborted()
  const env = options.env ?? process.env
  const config = options.config ?? loadConfig(env)
  const timeout = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 30_000) throw new Error('seat inventory timeoutMs must be between 1 and 30000')
  const probe = (bin: string, args: readonly string[], nativeEnv = env) => probeNativeStatus(bin, args, { timeoutMs: timeout, signal: options.signal, cwd: options.cwd, env: nativeEnv })
  const selected = localHarnesses.filter(([, harness]) => !options.harnesses || options.harnesses.includes(harness))
  const results = await Promise.allSettled(selected.map(async ([key, harness, fix, args, provider]): Promise<LocalSeat | LocalSeat[]> => {
    const bin = config[`${key}Bin`]
    const nativeArgs = key === 'pi' && options.provider
      ? ['auth', 'check', '--provider', options.provider, ...(options.model ? ['--model', options.model] : []), '--json', '--no-refresh'] : args
    const fact: LocalSeat = { harness, provider: null, status: 'unknown', authMode: 'unknown',
      source: key === 'gemini' ? 'native_store' : 'native_status', fix }
    const native = await (key === 'claude' ? readClaudeNativeContext({ cwd: options.cwd ?? process.cwd(), env, flags: options.flags ?? [] }) : Promise.resolve().then(async () => ({ env: key === 'cursor' ? await cursorEnvironment(env) : env, flags: [], settings: [] as Record<string, unknown>[] }))).catch(() => null)
    if (!native) return fact
    if (key === 'claude') {
      const { env, settings } = native
      fact.defaultModel = nativeIdentifier(env.ANTHROPIC_MODEL ?? settings.map((item) => item.model).findLast((value) => typeof value === 'string'))
      const fixFor = (key: string): string => settings.some((item) => object(item.env)[key] !== undefined) || process.env[key] !== env[key] ? 'claude auth status --json' : `unset ${key}`
      const credential = env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : env.ANTHROPIC_API_KEY?.trim() ? 'ANTHROPIC_API_KEY' : null
      const override = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].find((key) => env[key]?.trim() && !['0', 'false', 'off'].includes(env[key]!.toLowerCase()))
      if (credential || override || settings.some((item) => typeof item.apiKeyHelper === 'string' && item.apiKeyHelper.trim())) return {
        ...fact, provider: override ? null : provider, status: 'configured', source: 'native_store',
        authMode: !override && credential === 'ANTHROPIC_API_KEY' ? 'api_key' : 'unknown',
        fix: credential ? fixFor(credential) : override ? fixFor(override) : 'claude auth status --json',
      }
    }
    const result = await probe(bin, [...native.flags, ...nativeArgs], native.env)
    if (result.code === 'ENOENT') { delete fact.fix; return { ...fact, status: 'missing' } }
    // Inventory omits fixes for configured rows; a provider-scoped read keeps the next command.
    const settle = (seat: LocalSeat): LocalSeat => {
      if (seat.status === 'authenticated' || seat.status === 'configured' && !options.provider) delete seat.fix
      return seat
    }
    try {
      if (key === 'cursor') {
        const auth = decode(result.stdout)
        const signedIn = result.code === 0 && auth.isAuthenticated === true
        // An enrolled token is the plan's own headless credential only while its plan reading shows room.
        const plan = !!native.env.CURSOR_API_KEY && await cursorPlanHasRoom(env)
        fact.provider = 'cursor'
        fact.status = native.env.CURSOR_API_KEY ? plan && signedIn ? 'authenticated' : 'configured'
          : signedIn ? 'authenticated' : auth.isAuthenticated === false ? 'signed_out' : 'unknown'
        if (native.env.CURSOR_API_KEY) fact.source = 'native_store'
        fact.authMode = native.env.CURSOR_API_KEY ? plan ? 'subscription' : 'api_key' : 'unknown'
        if (plan) fact.credential = 'plan_key'
      } else if (key === 'claude' && (result.code === 0 || result.code === 1)) {
        const auth = decode(result.stdout)
        fact.provider = auth.apiProvider === 'firstParty' ? provider : null
        if (auth.loggedIn === false) fact.status = 'signed_out'
        if (result.code === 0 && auth.loggedIn === true) {
          fact.status = 'authenticated'
          fact.authMode = native.env.ANTHROPIC_AUTH_TOKEN ? 'unknown'
            : auth.authMethod === 'claude.ai' || auth.authMethod === 'oauth_token' && !!native.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? 'subscription'
            : auth.authMethod === 'api_key' ? 'api_key' : 'unknown'
        }
      } else if (key === 'codex') {
        const output = result.stdout + result.stderr
        if (result.code === 0 && /Logged in using ChatGPT\b/u.test(output)) {
          fact.status = 'authenticated'; fact.authMode = 'subscription'
        } else if (result.code === 0 && /Logged in using an API key\b/u.test(output)) {
          fact.status = 'authenticated'; fact.authMode = 'api_key'
        } else if (result.code === 1 && /Not logged in\b/u.test(output)) fact.status = 'signed_out'
      } else if (key === 'opencode' && result.code === 0) {
        const store = await state(join(env.XDG_DATA_HOME || join(env.HOME?.trim() || backendHome(), '.local/share'), 'opencode/auth.json'))
        // Inventory reports each stored provider credential on its own row, as model admission reads it.
        const providers = options.provider ? [options.provider] : Object.keys(store).filter((id) => nativeIdentifier(id) === id).sort()
        if (providers.length) return await Promise.all(providers.map(async (id) => settle(
          { ...fact, ...await opencodeProviderSeat(id, object(store[id]), options.model, (args) => probe(bin, args, native.env)) })))
        const output = (result.stdout + result.stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
        fact.authMode = /\boauth\b/iu.test(output) ? 'subscription' : /\bapi\b/iu.test(output) ? 'api_key' : 'unknown'
        fact.status = fact.authMode !== 'unknown' ? 'authenticated' : /\b0 credentials?\b/iu.test(output) ? 'signed_out' : 'unknown'
      } else if (key === 'pi') {
        const checks = options.provider ? [result] : [result, ...await Promise.all(['anthropic', 'github-copilot', 'google-gemini-cli'].map((provider) =>
          probe(bin, ['auth', 'check', '--provider', provider, '--json', '--no-refresh'])))]
        const auth: Array<Record<string, unknown>> = checks.flatMap((check) => { try { return [{ ...decode(check.stdout), exit: check.code }] } catch { return [] } })
        const ready = auth.filter((item) => item.exit === 0 && item.status === 'ready')
        fact.authMode = ready.some((item) => item.authType === 'oauth') ? 'subscription'
          : ready.some((item) => item.authType === 'api_key' || item.authType === 'apiKey') ? 'api_key' : 'unknown'
        if (options.provider && ready.length === 1 && ready[0]!.provider === options.provider) fact.provider = options.provider
        fact.status = ready.length ? 'authenticated' : auth.length === checks.length && auth.every((item) =>
          (item.exit === 0 || item.exit === 1) && item.status === 'not_ready') ? 'signed_out' : 'unknown'
      } else if (result.code === 0 && key === 'kimi') {
        Object.assign(fact, await kimiLoginState(bin, native.env, options.model, provider, { timeoutMs: timeout, signal: options.signal, cwd: options.cwd }))
      } else if (result.code === 0 && key === 'gemini') {
        Object.assign(fact, await geminiLoginState(env.HOME?.trim() || backendHome(), env))
      }
    } catch { /* Unrecognized or unsupported native output remains unknown. */ }
    return settle(fact)
  }))
  options.signal?.throwIfAborted()
  return results.flatMap((result) => { if (result.status === 'rejected') throw result.reason; return result.value })
}

/**
 * One OpenCode provider's stored credential. A plan key is a subscription; it is authenticated once OpenCode's own
 * catalog lists the requested model (any model when none is named) for that provider. No model turn is sent.
 */
async function opencodeProviderSeat(provider: string, auth: Record<string, unknown>, model: string | undefined,
  probe: (args: readonly string[]) => Promise<NativeStatus>): Promise<Omit<LocalSeat, 'harness'>> {
  const mode = auth.type === 'oauth' && typeof auth.refresh === 'string' && !!auth.refresh.trim() ? 'subscription'
    : auth.type === 'api' && typeof auth.key === 'string' && !!auth.key.trim() ? 'api_key' : 'unknown'
  const seat: Omit<LocalSeat, 'harness'> = { provider: mode === 'unknown' ? null : provider, status: mode === 'unknown' ? 'unknown' : 'configured',
    authMode: mode, source: 'native_store', fix: 'opencode auth list --pure' }
  if (mode === 'api_key' && PLAN_KEYED_PROVIDERS.has(provider)) {
    Object.assign(seat, { authMode: 'subscription', credential: 'plan_key' })
    // `--pure`: the turn's config loads Bridge plugins, whose cold start outlasts the probe timeout.
    const listed = await probe(['models', provider, '--pure'])
    const ids = listed.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n').map((line) => line.trim())
    if (listed.code === 0 && ids.some((id) => model ? id === `${provider}/${model}` : id.startsWith(`${provider}/`)))
      Object.assign(seat, { status: 'authenticated', source: 'native_catalog', fix: `opencode models ${provider} --pure` })
  }
  // With no stored credential, OpenCode can still serve a model its own catalog prices at zero
  // (`opencode/*-free` needs no login). That route spends nothing, so it is ready as a free route.
  if (mode === 'unknown' && model) {
    const listed = await probe(['models', provider, '--verbose', '--pure'])
    if (listed.code === 0 && opencodeFreeModel(listed.stdout, provider, model))
      Object.assign(seat, { provider, status: 'authenticated', authMode: 'free', source: 'native_catalog',
        fix: `opencode models ${provider} --verbose --pure` })
  }
  return seat
}

/** Kimi Code's membership endpoint. A key here draws the plan's own quota; Moonshot platform endpoints bill per token. */
const KIMI_CODE_PLAN_ENDPOINT = 'https://api.kimi.com/coding/v1'

/**
 * Kimi Code's own local server answers whether its managed subscription login holds a token (`GET /api/v1/auth`)
 * and which configured provider serves a model (`GET /api/v1/config`). Both read local state: no model turn,
 * token refresh or credential leaves the server. A model served by any other Kimi provider is not this subscription,
 * unless that provider is a Kimi Code membership key (`kimiPlanKey`).
 */
async function kimiLoginState(bin: string, env: NodeJS.ProcessEnv, model: string | undefined, provider: string | null,
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<Pick<LocalSeat, 'provider' | 'status' | 'authMode' | 'fix' | 'credential' | 'source'>> {
  const stop = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])])
  stop.throwIfAborted()
  // The server otherwise refreshes its model catalog on start, which can refresh the OAuth token and calls Kimi's API.
  const child = spawn(bin, ['web', '--json', '--host', '127.0.0.1', '--port', '0'], { cwd: options.cwd,
    env: { ...env, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  // A timeout or caller abort stops the server at once; otherwise it gets the default grace to save its own state.
  const kill = () => killTreeSync(child, 'SIGKILL')
  stop.addEventListener('abort', kill, { once: true })
  child.once('error', kill)
  try {
    const ready = await kapReady(child)
    if (!ready) return { provider: null, status: 'unknown', authMode: 'unknown' }
    const read = async (path: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`${ready.origin}/api/v1/${path}`, { headers: { authorization: `Bearer ${ready.token}` }, redirect: 'error', signal: stop })
      const reply = object(await response.json())
      if (!response.ok || reply.code !== 0) throw new Error(`kimi ${path} answered HTTP ${response.status}`)
      return object(reply.data)
    }
    const [auth, config] = await Promise.all([read('auth'), read('config')])
    const managed = object(auth.managed_provider)
    // Kimi keys a model as `kimi-code/<model>`, the id the Bridge passes as `--model`; no model means Kimi's default.
    const route = model ? `kimi-code/${model}` : nativeIdentifier(config.default_model)
    const served = route === undefined ? managed.name : object(object(config.models)[route]).provider
    // A key-only provider serves turns while the managed login reads `unauthenticated`, so the key is read first.
    if (typeof served === 'string' && object(object(config.providers)[served]).has_api_key === true
      && await kimiPlanKey(bin, env, served, { ...options, signal: stop }))
      return { provider, status: 'authenticated', authMode: 'subscription', credential: 'plan_key', source: 'native_store' }
    if (auth.managed_provider === null || ['unauthenticated', 'expired', 'revoked'].includes(managed.status as string))
      return { provider: null, status: 'signed_out', authMode: 'unknown' }
    if (managed.status !== 'authenticated') return { provider: null, status: 'unknown', authMode: 'unknown' }
    if (served === managed.name) return { provider, status: 'authenticated', authMode: 'subscription' }
    const other = typeof served === 'string' ? object(object(config.providers)[served]) : {}
    return { provider: null, status: served === undefined ? 'unknown' : 'configured',
      authMode: other.has_api_key === true ? 'api_key' : 'unknown', fix: 'kimi provider list' }
  } finally {
    stop.removeEventListener('abort', kill)
    await killTree(child)
  }
}

/**
 * True when Kimi's own provider list shows `provider` as a Kimi Code membership key: the `kimi` type on the plan's
 * coding endpoint with a non-empty key and no OAuth table. The local server's `has_api_key` is also true for an
 * OAuth-only provider whose key is empty, and Kimi refuses a provider holding both ("mutually exclusive"), so only this
 * listing tells a usable key apart. The key is tested for presence and dropped; it never leaves this function.
 */
async function kimiPlanKey(bin: string, env: NodeJS.ProcessEnv, provider: string,
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<boolean> {
  const listed = await probeNativeStatus(bin, ['provider', 'list', '--json'], { ...options, env })
  if (listed.code !== 0) return false
  const entry = object(object(decode(listed.stdout).providers)[provider])
  const endpoint = typeof entry.baseUrl === 'string' && URL.canParse(entry.baseUrl) ? new URL(entry.baseUrl) : undefined
  return entry.type === 'kimi' && entry.oauth === undefined && typeof entry.apiKey === 'string' && !!entry.apiKey.trim()
    && !!endpoint && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
    && `${endpoint.origin}${endpoint.pathname.replace(/\/+$/u, '')}` === KIMI_CODE_PLAN_ENDPOINT
}

/**
 * True when `opencode models <provider> --verbose` prices `<provider>/<model>` at zero for input,
 * output and cache. The command prints each model's id line, then its catalog entry as a JSON
 * object whose closing brace is the first unindented `}`. Anything unparsable is not free.
 */
function opencodeFreeModel(output: string, provider: string, model: string): boolean {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n').map((line) => line.trimEnd())
  const start = lines.indexOf(`${provider}/${model}`), end = start < 0 ? -1 : lines.indexOf('}', start + 1)
  if (start < 0 || lines[start + 1] !== '{' || end < 0) return false
  try {
    const cost = object(object(JSON.parse(lines.slice(start + 1, end + 1).join('\n'))).cost), cache = object(cost.cache)
    return [cost.input, cost.output, cache.read ?? 0, cache.write ?? 0].every((value) => value === 0)
  } catch { return false }
}

/** Read Gemini's selected native auth mode without retrieving a key from its keychain. */
export async function geminiLoginState(home: string, env: NodeJS.ProcessEnv): Promise<Pick<LocalSeat, 'status' | 'authMode'>> {
  const root = join(home, '.gemini')
  const settings = await state(join(root, 'settings.json'))
  const selected = object(object(settings.security).authentication).selectedType ?? settings.selectedAuthType
    ?? (env.GEMINI_API_KEY?.trim() ? 'gemini-api-key' : undefined)
  if (selected === 'gemini-api-key') return { status: env.GEMINI_API_KEY?.trim() ? 'configured' : 'unknown', authMode: 'api_key' }
  if (selected !== undefined && selected !== 'oauth-personal') return { status: 'unknown', authMode: 'unknown' }
  const auth = await state(join(root, 'oauth_creds.json'))
  const stored = typeof auth.refresh_token === 'string' && !!auth.refresh_token
  return { status: stored ? 'configured' : 'signed_out', authMode: stored ? 'subscription' : 'unknown' }
}

/** Project exactly the read-only native settings selectors, then resolve their effective environment once. */
async function readClaudeNativeContext(options: { cwd: string; env: NodeJS.ProcessEnv; flags: readonly string[] }) {
  const flags = options.flags.flatMap((flag, index) => flag === '--settings' || flag === '--setting-sources' ? [flag, options.flags[index + 1] ?? ''] : [])
  const root = findGitDir(options.cwd)?.repoRoot ?? options.cwd
  const index = flags.lastIndexOf('--setting-sources')
  const sources = (index < 0 ? 'user,project,local' : flags[index + 1] ?? '').split(',')
  const paths = [sources.includes('user') ? join(options.env.CLAUDE_CONFIG_DIR || join(options.env.HOME || backendHome(), '.claude'), 'settings.json') : null,
    sources.includes('project') ? join(root, '.claude/settings.json') : null, sources.includes('local') ? join(root, '.claude/settings.local.json') : null,
    ...flags.flatMap((flag, index) => flag === '--settings' && !flags[index + 1]!.trimStart().startsWith('{') ? [resolve(options.cwd, flags[index + 1]!)] : [])]
  const settings = await Promise.all(paths.filter((path): path is string => path !== null).map(state))
  for (let index = 0; index < flags.length; index++) if (flags[index] === '--settings' && flags[index + 1]!.trimStart().startsWith('{')) settings.push(object(JSON.parse(flags[index + 1]!)))
  if (settings.some((item) => Object.entries(object(item.env)).some(([key, value]) => key.includes('\0') || typeof value !== 'string' || value.includes('\0')))) throw new Error('Native settings environment contains an invalid entry')
  return { settings, flags, env: Object.assign({}, options.env, ...settings.map((item) => object(item.env))) as NodeJS.ProcessEnv }
}
