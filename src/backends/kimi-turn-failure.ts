import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readSync, fstatSync, readFileSync, realpathSync, watch } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir, hostname } from 'node:os'
import type { SpawnResult } from '../executors/types.js'
import { BackendReportedFailureError } from '../runs/error-shape.js'

// Kimi Code 2.7.2 writes turn.ended to the main agent's wire. Print mode
// publishes neither that event nor its final session hint when the turn fails.
// Bind the native session by its first-party process lease, never by "latest".
const sessionLease = /^(session_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.lock(?:\.tmp-(\d+)-[0-9a-f-]{36})?$/i
const maximumWireTail = 4 * 1024 * 1024
const providerMessages = new Map([
  ['provider.api_error', 'The provider rejected the request.'],
  ['provider.filtered', 'The provider blocked the response.'],
  ['provider.rate_limit', 'The provider rate limit was reached.'],
  ['provider.auth_error', 'Provider authentication failed.'],
  ['provider.connection_error', 'The connection to the provider failed.'],
  ['provider.overloaded', 'The provider is overloaded.'],
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Moonshot agent-core-v2 _base/utils/workdir-slug.ts, encodeWorkDirKey.
function workspaceKey(cwd: string): string {
  const directory = realpathSync(cwd).replaceAll('\\', '/').replace(/\/+$/, '')
  const slug = basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '')
  const hash = createHash('sha256').update(directory).digest('hex').slice(0, 12)
  return `wd_${slug === '.' || slug === '..' || !slug ? 'workspace' : slug}_${hash}`
}

function belongsToChild(pid: unknown, spawned: SpawnResult): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false
  if (spawned.child.pid === pid && spawned.child.exitCode == null && spawned.child.signalCode == null) return true
  // systemd-run can supervise a different PID. Only the *exact* scope
  // assigned by the host executor is another proof of process ownership.
  return process.platform === 'linux' && !!spawned.scope &&
    readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').some(line =>
      line.startsWith('0::/') && line.slice(3).split('/').includes(spawned.scope!))
}

function readLease(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) return
    const bytes = Buffer.alloc(stat.size)
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return
    return JSON.parse(bytes.toString('utf8'))
  } finally { closeSync(fd) }
}

interface WireCursor { size: number; dev: number; ino: number }

export function kimiNativeHome(env: NodeJS.ProcessEnv): string {
  return env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code')
}

function wirePath(root: string, cwd: string, id: string): string {
  return join(root, 'sessions', workspaceKey(cwd), id, 'agents', 'main', 'wire.jsonl')
}

async function readWireTail(path: string, cursor?: WireCursor): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (cursor && (stat.dev !== cursor.dev || stat.ino !== cursor.ino || stat.size < cursor.size))) return ''
    const boundary = cursor?.size ?? 0
    const start = Math.max(boundary, stat.size - maximumWireTail)
    const bytes = Buffer.alloc(stat.size - start)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset)
      if (!bytesRead) return ''
      offset += bytesRead
    }
    if (start === boundary) return bytes.toString('utf8')
    const newline = bytes.indexOf(10)
    return newline < 0 ? '' : bytes.subarray(newline + 1).toString('utf8')
  } finally { await file.close() }
}

function providerFailure(error: unknown): BackendReportedFailureError | undefined {
  if (!record(error) || typeof error.code !== 'string') return
  const description = providerMessages.get(error.code)
  if (!description) return
  const code = record(error.details) ? error.details.statusCode : undefined
  const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined
  const quota = error.code === 'provider.api_error' && error.name === 'APIProviderQuotaExhaustedError'
  return new BackendReportedFailureError(
    `Kimi: ${quota ? 'The provider subscription quota is exhausted.' : description}`,
    error.code,
    { nativeProvider: { ...(status === undefined ? {} : { status }), ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}) } },
  )
}

function matchTurn(wire: string, prompt: string, since: number, until: number): BackendReportedFailureError | undefined {
  let promptTurn: number | undefined
  let ending: BackendReportedFailureError | undefined
  for (const line of wire.split('\n')) {
    if (!line.trim()) continue
    const event: unknown = JSON.parse(line)
    if (!record(event) || event.agentId !== 'main' || typeof event.turnId !== 'number' ||
        typeof event.time !== 'number' || event.time < since || event.time > until) continue
    if (event.type === 'turn.prompt' && Array.isArray(event.input) && event.input.length > 0 &&
        event.input.every(part => record(part) && part.type === 'text' && typeof part.text === 'string') &&
        event.input.map(part => part.text).join('') === prompt) {
      if (promptTurn !== undefined) return
      promptTurn = event.turnId
    } else if (event.type === 'turn.ended' && promptTurn === event.turnId) {
      if (ending !== undefined || event.reason !== 'failed') return
      ending = providerFailure(event.error) ?? new BackendReportedFailureError('Kimi: The native turn failed.', 'upstream')
    }
  }
  return ending
}

async function readBoundFailure(path: string, prompt: string, since: number, cursor?: WireCursor) {
  const until = Date.now()
  try {
    if (realpathSync(path) !== path) return
    return matchTurn(await readWireTail(path, cursor), prompt, since, until)
  } catch { return }
}

// ACP supplies its session ID on its own RPC connection. Take the byte boundary
// just before session/prompt, so past failures and replayed turns cannot attest
// to this request, even on resume with an identical prompt in the same millisecond.
export async function bindKimiAcpTurn(home: string, cwd: string, sessionId: string, fresh: boolean) {
  if (!sessionLease.test(sessionId + '.lock')) return
  try {
    const path = wirePath(realpathSync(home), cwd, sessionId)
    let cursor: WireCursor | undefined
    try {
      if (realpathSync(path) !== path) return
      const stat = await lstat(path)
      if (!stat.isFile()) return
      cursor = { size: stat.size, dev: stat.dev, ino: stat.ino }
    } catch (error) {
      if (!fresh || (error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    const since = Date.now()
    return (prompt: string) => readBoundFailure(path, prompt, since, cursor)
  } catch { return }
}

export function observeKimiPrintSession(home: string, cwd: string, spawned: SpawnResult, since: number) {
  try {
    const root = realpathSync(home)
    const locks = join(root, 'locks', 'sessions')
    if (realpathSync(locks) !== locks) return
    let session: string | undefined
    let ambiguous = false
    let candidate: { id: string; pid: number } | undefined
    const watcher = watch(locks, { persistent: false }, (_event, name) => {
      const parts = name && sessionLease.exec(name)
      if (!parts || ambiguous) return
      const id = parts[1]!
      try {
        // Kimi stages its lease as <session>.lock.tmp-<pid>-<uuid>, then
        // hard-links it to <session>.lock. Never open another process's lease.
        if (parts[2]) {
          const pid = Number(parts[2])
          if (!belongsToChild(pid, spawned)) return
          if (candidate && candidate.id !== id) { ambiguous = true; return }
          candidate = { id, pid }
        }
        if (candidate?.id !== id) return
        const { pid } = candidate
        const holder = readLease(join(locks, id + '.lock'))
        if (!record(holder) || holder.version !== 1 || holder.hostname !== hostname() ||
            typeof holder.startedAt !== 'number' || holder.startedAt < since ||
            holder.pid !== pid || !belongsToChild(pid, spawned)) return
        session = id
      } catch { /* A lock may already be gone. Missing proof stays unknown. */ }
    })
    watcher.on('error', () => { ambiguous = true; watcher.close() })
    return {
      close: () => watcher.close(),
      async failure(prompt: string): Promise<BackendReportedFailureError | undefined> {
        if (!session || ambiguous) return
        try { return await readBoundFailure(wirePath(root, cwd, session), prompt, since) } catch { return }
      },
    }
  } catch { return }
}
