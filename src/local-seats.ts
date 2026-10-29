import { cursorEnvironment } from './lib/cursor-auth.js'
import { join, resolve } from 'node:path'
import { findGitDir } from './jail/types.js'
import { loadConfig, localHarnesses, type Config } from './config.js'
import { backendHome } from './jail/auth-preserve.js'
import { probeNativeStatus } from './lib/native-status.js'
import { nativeObject as object, nativeJson as decode, nativeIdentifier, readNativeState as state } from './lib/native-state.js'

export interface LocalSeat {
  harness: typeof localHarnesses[number][1]
  provider: string | null
  /** Native configured default, never a served model identity. */
  defaultModel?: string
  status: 'authenticated' | 'configured' | 'signed_out' | 'missing' | 'unknown'
  authMode: 'subscription' | 'api_key' | 'unknown'
  source: 'native_status' | 'native_store'
  fix?: string
}

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
  const results = await Promise.allSettled(localHarnesses.filter(([, harness]) => !options.harnesses || options.harnesses.includes(harness)).map(async ([key, harness, fix, args, provider]): Promise<LocalSeat> => {
    const bin = config[`${key}Bin`]
    const nativeArgs = key === 'pi' && options.provider
      ? ['auth', 'check', '--provider', options.provider, ...(options.model ? ['--model', options.model] : []), '--json', '--no-refresh'] : args
    const fact: LocalSeat = { harness, provider: null, status: 'unknown', authMode: 'unknown',
      source: key === 'kimi' || key === 'gemini' ? 'native_store' : 'native_status', fix }
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
    try {
      if (key === 'cursor') {
        const auth = decode(result.stdout)
        fact.provider = 'cursor'
        fact.status = native.env.CURSOR_API_KEY ? 'configured' : result.code === 0 && auth.isAuthenticated === true ? 'authenticated' : auth.isAuthenticated === false ? 'signed_out' : 'unknown'
        if (native.env.CURSOR_API_KEY) fact.source = 'native_store'
        fact.authMode = native.env.CURSOR_API_KEY ? 'api_key' : 'unknown'
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
      } else if (key === 'opencode' && options.provider && result.code === 0) {
        const auth = object((await state(join(env.XDG_DATA_HOME || join(env.HOME?.trim() || backendHome(), '.local/share'), 'opencode/auth.json')))[options.provider])
        const mode = auth.type === 'oauth' && typeof auth.refresh === 'string' && !!auth.refresh.trim() ? 'subscription'
          : auth.type === 'api' && typeof auth.key === 'string' && !!auth.key.trim() ? 'api_key' : 'unknown'
        Object.assign(fact, { provider: mode === 'unknown' ? null : options.provider, status: mode === 'unknown' ? 'unknown' : 'configured',
          authMode: mode, source: 'native_store', fix: 'opencode auth list --pure' })
      } else if (key === 'opencode' && result.code === 0) {
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
        const root = env.KIMI_CODE_HOME?.trim() || join(env.HOME?.trim() || backendHome(), '.kimi-code')
        const auth = await Promise.all(['kimi-code.json', 'managed:kimi-code.json'].map((file) => state(join(root, 'credentials', file))))
        const stored = auth.some((item) => typeof item.refresh_token === 'string' && !!item.refresh_token)
        fact.status = stored ? 'configured' : 'signed_out'; fact.authMode = stored ? 'subscription' : 'unknown'
      } else if (result.code === 0 && key === 'gemini') {
        Object.assign(fact, await geminiLoginState(env.HOME?.trim() || backendHome(), env))
      }
    } catch { /* Unrecognized or unsupported native output remains unknown. */ }
    if (fact.status === 'authenticated' || fact.status === 'configured' && !options.provider) delete fact.fix
    return fact
  }))
  options.signal?.throwIfAborted()
  return results.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value })
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
