import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_CREDENTIAL_LENGTH = 16 * 1024
const OPAQUE_BEARER_REFRESH_MS = 5 * 60_000
const BEARER_REFRESH_MARGIN_MS = 5 * 60_000
const AUTH_COMMAND_TIMEOUT_MS = 15_000

export interface PiAuthCredential {
  readonly token: string
  readonly refreshable: boolean
  resolve(signal: AbortSignal): Promise<string>
}

export async function resolvePiAuthCredential(options: {
  bin: string
  provider: string
  model: string
  apiMode: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<PiAuthCredential> {
  if (options.apiMode === 'openai-codex-responses') {
    return bearerCredential(options)
  }

  try {
    const token = await runPiAuth(options, 'print-api-key')
    return {
      token,
      refreshable: false,
      async resolve() {
        return token
      },
    }
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) throw error
    return bearerCredential(options)
  }
}

async function bearerCredential(options: {
  bin: string
  provider: string
  model: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<PiAuthCredential> {
  let token = await runPiAuth(options, 'print-bearer-token')
  let refreshAfterMs = bearerRefreshAfterMs(token)
  let inFlight: Promise<string> | null = null

  const refresh = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    if (Date.now() < refreshAfterMs) return token
    if (!inFlight) {
      const refreshController = new AbortController()
      inFlight = runPiAuth(
        { ...options, signal: refreshController.signal },
        'print-bearer-token',
      ).then((next) => {
        token = next
        refreshAfterMs = bearerRefreshAfterMs(next)
        return next
      })
        .finally(() => {
          inFlight = null
        })
    }
    return abortable(inFlight, signal)
  }

  return {
    token,
    refreshable: true,
    resolve: refresh,
  }
}

async function runPiAuth(
  options: {
    bin: string
    provider: string
    model: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  },
  command: 'print-api-key' | 'print-bearer-token',
): Promise<string> {
  const args = [
    'auth',
    command,
    '--provider',
    options.provider,
    '--model',
    options.model,
    ...(command === 'print-bearer-token' ? ['--min-expiry', '5m'] : []),
  ]
  const result = await execFileAsync(options.bin, args, {
    env: options.env,
    encoding: 'utf8',
    signal: options.signal,
    timeout: AUTH_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  })
  return exactCredential(result.stdout)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function abortError(): Error {
  const error = new Error('pi auth request aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function exactCredential(value: string): string {
  const token = value.trim()
  if (
    token.length === 0
    || token.length > MAX_CREDENTIAL_LENGTH
    || /[\r\n\0]/u.test(token)
  ) {
    throw new Error('pi auth returned no single-line credential')
  }
  return token
}

function bearerRefreshAfterMs(token: string): number {
  const expiresAtMs = jwtExpiryMs(token)
  if (expiresAtMs === null) return Date.now() + OPAQUE_BEARER_REFRESH_MS
  return Math.max(Date.now(), expiresAtMs - BEARER_REFRESH_MARGIN_MS)
}

function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || typeof (parsed as { exp?: unknown }).exp !== 'number'
      || !Number.isSafeInteger((parsed as { exp: number }).exp)
    ) {
      return null
    }
    return (parsed as { exp: number }).exp * 1_000
  } catch {
    return null
  }
}
