import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_CREDENTIAL_LENGTH = 16 * 1024
const OPAQUE_BEARER_REFRESH_MS = 5 * 60_000
const BEARER_REFRESH_MARGIN_MS = 5 * 60_000
const AUTH_COMMAND_TIMEOUT_MS = 15_000

type PiAuthCommand = 'print-api-key' | 'print-bearer-token'
type PiAuthOutcome = 'exit' | 'timeout' | 'aborted' | 'missing' | 'output_limit' | 'invalid_output' | 'failed'

interface PiAuthAttempt {
  command: PiAuthCommand
  outcome: PiAuthOutcome
  elapsedMs: number
  exitCode?: number
}

class PiAuthCommandError extends Error {
  constructor(readonly attempt: PiAuthAttempt) {
    super(formatAttempt(attempt))
    this.name = attempt.outcome === 'aborted' ? 'AbortError' : 'PiAuthCommandError'
  }
}

/** Only fixed helper names, exit status and monotonic durations cross this boundary. */
export class PiAuthResolutionError extends Error {
  readonly backendCode: 'not_configured' | 'cli_missing' | 'timeout' | 'aborted' | 'upstream'

  constructor(readonly diagnosticId: string, readonly attempts: readonly PiAuthAttempt[]) {
    super(`pi auth helper failed id=${diagnosticId} (${attempts.map(formatAttempt).join('; ')})`)
    this.name = 'PiAuthResolutionError'
    this.backendCode = attempts.some((attempt) => attempt.outcome === 'aborted') ? 'aborted'
      : attempts.some((attempt) => attempt.outcome === 'timeout') ? 'timeout'
      : attempts.some((attempt) => attempt.outcome === 'missing') ? 'cli_missing'
      : attempts.every((attempt) => attempt.outcome === 'exit' || attempt.outcome === 'invalid_output')
        ? 'not_configured'
        : 'upstream'
  }
}

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
  const diagnosticId = randomUUID()
  if (options.apiMode === 'openai-codex-responses') {
    try {
      return await bearerCredential(options, diagnosticId)
    } catch (error) {
      throw new PiAuthResolutionError(diagnosticId, [commandAttempt(error, 'print-bearer-token')])
    }
  }

  try {
    const token = await runPiAuth(options, 'print-api-key', diagnosticId)
    return {
      token,
      refreshable: false,
      async resolve() {
        return token
      },
    }
  } catch (error) {
    const first = commandAttempt(error, 'print-api-key')
    if (options.signal.aborted || first.outcome === 'aborted') {
      throw new PiAuthResolutionError(diagnosticId, [first])
    }
    try {
      return await bearerCredential(options, diagnosticId)
    } catch (fallbackError) {
      throw new PiAuthResolutionError(diagnosticId, [first, commandAttempt(fallbackError, 'print-bearer-token')])
    }
  }
}

async function bearerCredential(options: {
  bin: string
  provider: string
  model: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}, diagnosticId: string): Promise<PiAuthCredential> {
  let token = await runPiAuth(options, 'print-bearer-token', diagnosticId)
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
        randomUUID(),
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
  command: PiAuthCommand,
  diagnosticId: string,
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
  const started = performance.now()
  try {
    const result = await execFileAsync(options.bin, args, {
      env: options.env,
      encoding: 'utf8',
      signal: options.signal,
      timeout: AUTH_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
    const token = exactCredential(result.stdout)
    console.info(`[pi-auth] id=${diagnosticId} command=${command} outcome=ok elapsed_ms=${elapsedMs(started)}`)
    return token
  } catch (error) {
    const attempt = classifyAttempt(command, error, options.signal, elapsedMs(started))
    console.warn(`[pi-auth] id=${diagnosticId} ${formatAttempt(attempt)}`)
    throw new PiAuthCommandError(attempt)
  }
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

function formatAttempt(attempt: PiAuthAttempt): string {
  const exit = attempt.exitCode === undefined ? '' : ` exit_code=${attempt.exitCode}`
  return `command=${attempt.command} outcome=${attempt.outcome}${exit} elapsed_ms=${attempt.elapsedMs}`
}

function classifyAttempt(
  command: PiAuthCommand,
  error: unknown,
  signal: AbortSignal,
  durationMs: number,
): PiAuthAttempt {
  if (signal.aborted || isAbortError(error)) return { command, outcome: 'aborted', elapsedMs: durationMs }
  if (error instanceof InvalidPiCredentialError) {
    return { command, outcome: 'invalid_output', elapsedMs: durationMs }
  }
  const childError = error as { code?: unknown; killed?: unknown; signal?: unknown } | null
  if (childError?.code === 'ENOENT') return { command, outcome: 'missing', elapsedMs: durationMs }
  if (childError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { command, outcome: 'output_limit', elapsedMs: durationMs }
  }
  if (childError?.code === 'ETIMEDOUT' || (childError?.killed === true && childError?.signal === 'SIGKILL')) {
    return { command, outcome: 'timeout', elapsedMs: durationMs }
  }
  if (typeof childError?.code === 'number' && Number.isSafeInteger(childError.code)) {
    return { command, outcome: 'exit', exitCode: childError.code, elapsedMs: durationMs }
  }
  return { command, outcome: 'failed', elapsedMs: durationMs }
}

function commandAttempt(error: unknown, command: PiAuthCommand): PiAuthAttempt {
  if (error instanceof PiAuthCommandError) return error.attempt
  return { command, outcome: 'failed', elapsedMs: 0 }
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
    throw new InvalidPiCredentialError()
  }
  return token
}

class InvalidPiCredentialError extends Error {}

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
