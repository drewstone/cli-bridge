import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { hostSpawner } from '../executors/host.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { BackendError } from './types.js'

interface FileAuth {
  auth_mode?: unknown
  tokens?: {
    id_token?: unknown
    account_id?: unknown
    access_token?: unknown
    refresh_token?: unknown
  }
  last_refresh?: unknown
  [key: string]: unknown
}

const OTHER_FILE_AUTH_MODES = new Set([
  'apikey', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey', 'bedrockAccessKeys', 'headers',
])

function authFileExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new BackendError('Codex account auth.json cannot be inspected', 'not_configured')
  }
}

function readFileAuth(path: string): FileAuth {
  let auth: FileAuth
  try { auth = JSON.parse(readFileSync(path, 'utf8')) as FileAuth } catch {
    throw new BackendError('Codex account auth.json is missing or invalid', 'not_configured')
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new BackendError('Codex account auth.json is invalid', 'not_configured')
  }
  return auth
}

/** Only an unconfined file-backed ChatGPT turn can rotate this host account during inference. */
export function isCodexSubscriptionAuth(path: string | undefined): boolean {
  if (!path || !authFileExists(path)) return false
  return classifyFileAuth(readFileAuth(path)) === 'subscription'
}

/** Codex exec selects these environment credentials before persisted auth.json. */
export function hasCodexEnvAuth(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CODEX_API_KEY?.trim() || env.CODEX_ACCESS_TOKEN?.trim())
}

function classifyFileAuth(auth: FileAuth): 'subscription' | 'external-access' | 'other' {
  const mode = auth.auth_mode ?? (
    auth.personal_access_token != null ? 'personalAccessToken'
      : auth.bedrock_api_key != null ? 'bedrockApiKey'
        : auth.bedrock_access_keys != null ? 'bedrockAccessKeys'
          : auth.OPENAI_API_KEY != null ? 'apikey' : 'chatgpt'
  )
  if (mode === 'chatgpt') return 'subscription'
  if (mode === 'chatgptAuthTokens') {
    if (typeof auth.tokens?.id_token !== 'string' || typeof auth.tokens.access_token !== 'string'
      || typeof auth.tokens.account_id !== 'string'
      || (auth.tokens.refresh_token !== undefined && auth.tokens.refresh_token !== '')
      || typeof auth.last_refresh !== 'string' || !Number.isFinite(Date.parse(auth.last_refresh))) {
      throw new BackendError('Externally managed Codex auth must contain access-only tokens', 'not_configured')
    }
    return 'external-access'
  }
  if (auth.tokens != null) {
    if (typeof auth.tokens !== 'object' || Array.isArray(auth.tokens) || 'refresh_token' in auth.tokens) {
      throw new BackendError('Codex auth mode cannot expose token data to the jail', 'not_configured')
    }
  }
  if (typeof mode === 'string' && OTHER_FILE_AUTH_MODES.has(mode)) return 'other'
  throw new BackendError('Codex account auth mode is unrecognized', 'not_configured')
}

function accessExpiry(token: unknown): number {
  if (typeof token !== 'string') return NaN
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : NaN
  } catch {
    return NaN
  }
}

/** Ask the installed Codex app-server to refresh its own persistent account. */
async function refreshAccountWithCodex(bin: string, authPath: string, signal: AbortSignal): Promise<void> {
  const home = dirname(authPath)
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home }
  for (const key of [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const spawned = await hostSpawner(bin, ['-c', 'cli_auth_credentials_store="file"', 'app-server', '--stdio'], {
    cwd: home,
    env,
    signal: bounded,
    stdio: ['pipe', 'pipe', 'pipe'],
    envPassthroughKeys: ['SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
  })
  const child = spawned.child
  child.stderr?.on('data', () => { /* Drain diagnostics without logging credentials. */ })
  const onAbort = (): void => { void terminateSpawned(spawned) }
  bounded.addEventListener('abort', onAbort, { once: true })
  try {
    if (!child.stdin || !child.stdout) throw new Error('Codex account RPC has no stdio')
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const send = (message: Record<string, unknown>): void => {
      child.stdin!.write(`${JSON.stringify(message)}\n`)
    }
    const response = async (id: number): Promise<Record<string, unknown>> => {
      for (;;) {
        bounded.throwIfAborted()
        let onReadAbort: (() => void) | undefined
        const aborted = new Promise<never>((_, reject) => {
          onReadAbort = () => reject(bounded.reason)
          bounded.addEventListener('abort', onReadAbort, { once: true })
          if (bounded.aborted) onReadAbort()
        })
        let next: Awaited<ReturnType<typeof lines.next>>
        try { next = await Promise.race([lines.next(), aborted]) } finally {
          if (onReadAbort) bounded.removeEventListener('abort', onReadAbort)
        }
        if (next.done) throw new Error('Codex account RPC closed early')
        let value: Record<string, unknown>
        try { value = JSON.parse(next.value) as Record<string, unknown> } catch { continue }
        if (value.id === id) return value
      }
    }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cli-bridge', version: '0.3.0' } } })
    if (!('result' in await response(1))) throw new Error('Codex account RPC initialization failed')
    send({ method: 'initialized', params: {} })
    send({ id: 2, method: 'account/read', params: { refreshToken: true } })
    if (!('result' in await response(2))) throw new Error('Codex account RPC refresh failed')
  } catch {
    throw new BackendError('Codex account refresh did not complete', signal.aborted ? 'aborted' : 'upstream')
  } finally {
    bounded.removeEventListener('abort', onAbort)
    const termination = await terminateSpawned(spawned)
    spawned.release()
    if (termination !== 'stopped') {
      throw new BackendError('Codex account refresh process termination is unconfirmed', 'upstream')
    }
  }
}

/**
 * A jailed Codex receives an access-only credential. The refresh capability
 * stays in the trusted account home, outside the agent-writable jail.
 */
export async function prepareCodexJailAuth(
  bin: string,
  authPath: string | undefined,
  configPath: string | undefined,
  turnTimeoutMs: number,
  signal: AbortSignal,
  readConfine: boolean,
): Promise<{ homePath: string; subscription: boolean; cleanup(): void }> {
  // API-key and Router launches may authenticate entirely from the child env.
  // Their selected home need not contain an auth.json file.
  if (!authPath || !authFileExists(authPath)) return writeJailHome(null, configPath, false)
  const auth = readFileAuth(authPath)
  const accountId = auth.tokens?.account_id
  const mode = classifyFileAuth(auth)
  if (mode === 'subscription') {
    if (process.platform !== 'linux' || !readConfine) {
      throw new BackendError('Jailed Codex subscription turns require Linux fs-jail read confinement', 'not_configured')
    }
    if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 4 * 60 * 60 * 1000) {
      throw new BackendError('Jailed Codex subscription turns require a bounded deadline', 'not_configured')
    }
    if (typeof accountId !== 'string' || !accountId || typeof auth.tokens?.refresh_token !== 'string'
      || !auth.tokens.refresh_token) {
      throw new BackendError('Codex subscription account has no refreshable auth', 'not_configured')
    }
    // Native Codex proactively refreshes five minutes before expiry.
    const requiredUntil = Date.now() + turnTimeoutMs + 6 * 60_000
    if (!(accessExpiry(auth.tokens.access_token) > requiredUntil)) {
      await refreshAccountWithCodex(bin, authPath, signal)
    }
    const current = readFileAuth(authPath)
    if (classifyFileAuth(current) !== 'subscription' || current.tokens?.account_id !== accountId
      || !(accessExpiry(current.tokens?.access_token) > requiredUntil)) {
      throw new BackendError('Codex account access token will expire during the jailed turn', 'upstream')
    }
    if (typeof current.tokens?.id_token !== 'string' || typeof current.tokens.access_token !== 'string'
      || typeof current.last_refresh !== 'string' || !Number.isFinite(Date.parse(current.last_refresh))) {
      throw new BackendError('Codex subscription account is missing access credentials', 'not_configured')
    }
    return writeJailHome({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: current.tokens.id_token,
        access_token: current.tokens.access_token,
        account_id: accountId,
        refresh_token: '',
      },
      last_refresh: current.last_refresh,
    }, configPath, true)
  }
  if (mode === 'external-access') {
    return writeJailHome({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: auth.tokens!.id_token,
        access_token: auth.tokens!.access_token,
        account_id: auth.tokens!.account_id,
        refresh_token: '',
      },
      last_refresh: auth.last_refresh,
    }, configPath, false)
  }
  return writeJailHome(auth, configPath, false)
}

function writeJailHome(auth: FileAuth | null, configPath: string | undefined, subscription: boolean): {
  homePath: string
  subscription: boolean
  cleanup(): void
} {
  const homePath = mkdtempSync(join(tmpdir(), 'cli-bridge-codex-jail-'))
  try {
    if (auth) writeFileSync(join(homePath, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
    const config = configPath && existsSync(configPath) ? readFileSync(configPath) : '\n'
    writeFileSync(join(homePath, 'config.toml'), config, { mode: 0o600 })
    return {
      homePath,
      subscription,
      cleanup: () => rmSync(homePath, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(homePath, { recursive: true, force: true })
    throw error
  }
}
