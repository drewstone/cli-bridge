import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, localHarnesses, type Config } from './config.js'
import { backendHome } from './jail/auth-preserve.js'
import { killTree, killTreeSync } from './executors/process-tree.js'

export interface LocalSeat {
  harness: typeof localHarnesses[number][1]
  status: 'authenticated' | 'configured' | 'signed_out' | 'missing' | 'unknown'
  authMode: 'subscription' | 'api_key' | 'unknown'
  source: 'native_status' | 'native_store'
  fix?: string
}

export interface LocalSeatOptions {
  config?: Config
  timeoutMs?: number
  signal?: AbortSignal
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const decode = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('native auth status is not an object')
  return value as Record<string, unknown>
}
const state = async (path: string): Promise<Record<string, unknown>> => {
  try { return decode(await readFile(path, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** Query local login state without an inference, refresh, or credential in the returned value. */
export async function detectLocalSeats(options: LocalSeatOptions = {}): Promise<LocalSeat[]> {
  options.signal?.throwIfAborted()
  const config = options.config ?? loadConfig()
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 30_000) throw new Error('seat inventory timeoutMs must be between 1 and 30000')
  const probe = (bin: string, args: readonly string[]) => new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve, reject) => {
    if (options.signal?.aborted) { resolve({ code: 'ABORT_ERR', stdout: '', stderr: '' }); return }
    let interrupted: string | undefined
    const stop = (cause: string) => { interrupted = cause; killTreeSync(child, 'SIGKILL') }
    const onAbort = () => stop('ABORT_ERR')
    const child = execFile(bin, [...args], { timeout, killSignal: 'SIGKILL', detached: process.platform !== 'win32',
      maxBuffer: 65536, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void killTree(child, { gracefulMs: 0 }).then(() =>
        resolve({ code: interrupted ?? (error ? error.code ?? 'unknown' : 0), stdout, stderr }), reject)
    })
    const timer = setTimeout(() => stop('ETIMEDOUT'), timeout)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    child.stdin?.end()
  })
  const results = await Promise.allSettled(localHarnesses.map(async ([key, harness, fix, args]): Promise<LocalSeat> => {
    const bin = config[`${key}Bin`]
    const result = await probe(bin, args)
    const fact: LocalSeat = { harness, status: 'unknown', authMode: 'unknown',
      source: key === 'kimi' || key === 'gemini' ? 'native_store' : 'native_status', fix }
    if (result.code === 'ENOENT') { delete fact.fix; return { ...fact, status: 'missing' } }
    try {
      if (key === 'claude' && (result.code === 0 || result.code === 1)) {
        const auth = decode(result.stdout)
        if (auth.loggedIn === false) fact.status = 'signed_out'
        if (result.code === 0 && auth.loggedIn === true) {
          fact.status = 'authenticated'
          fact.authMode = auth.authMethod === 'claude.ai' || auth.authMethod === 'oauth_token' ? 'subscription'
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
        const output = (result.stdout + result.stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
        fact.authMode = /\boauth\b/iu.test(output) ? 'subscription' : /\bapi\b/iu.test(output) ? 'api_key' : 'unknown'
        fact.status = fact.authMode !== 'unknown' ? 'authenticated' : /\b0 credentials?\b/iu.test(output) ? 'signed_out' : 'unknown'
      } else if (key === 'pi') {
        const checks = [result, ...await Promise.all(['anthropic', 'github-copilot', 'google-gemini-cli'].map((provider) =>
          probe(bin, ['auth', 'check', '--provider', provider, '--json', '--no-refresh'])))]
        const auth: Array<Record<string, unknown>> = checks.flatMap((check) => { try { return [{ ...decode(check.stdout), exit: check.code }] } catch { return [] } })
        const ready = auth.filter((item) => item.exit === 0 && item.status === 'ready')
        fact.authMode = ready.some((item) => item.authType === 'oauth') ? 'subscription'
          : ready.some((item) => item.authType === 'api_key' || item.authType === 'apiKey') ? 'api_key' : 'unknown'
        fact.status = ready.length ? 'authenticated' : auth.length === checks.length && auth.every((item) =>
          (item.exit === 0 || item.exit === 1) && item.status === 'not_ready') ? 'signed_out' : 'unknown'
      } else if (result.code === 0 && key === 'kimi') {
        const root = process.env.KIMI_CODE_HOME?.trim() || join(backendHome(), '.kimi-code')
        const auth = await Promise.all(['kimi-code.json', 'managed:kimi-code.json'].map((file) => state(join(root, 'credentials', file))))
        const stored = auth.some((item) => typeof item.refresh_token === 'string' && !!item.refresh_token)
        fact.status = stored ? 'configured' : 'signed_out'; fact.authMode = stored ? 'subscription' : 'unknown'
      } else if (result.code === 0 && key === 'gemini') {
        Object.assign(fact, await geminiLoginState(backendHome(), process.env))
      }
    } catch { /* Unrecognized or unsupported native output remains unknown. */ }
    if (fact.status === 'authenticated' || fact.status === 'configured') delete fact.fix
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
