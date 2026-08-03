/**
 * Host spawner — node's `spawn` wrapped in a counting semaphore.
 *
 * Two layered protections:
 *   1. Detached process group (`detached: true`, kill(-pid)) so SIGTERM
 *      reaches the whole subtree — opencode/claude/kimi each fork helpers
 *      (model HTTP client, MCP servers, ripgrep, etc.) that would otherwise
 *      orphan to PID 1. Production evidence: 9+ orphan `opencode run`
 *      processes reparented to PID 1 with elapsed > 24h, each 300-600 MB.
 *   2. Process-wide counting semaphore so parallel clients can't
 *      fork-bomb the host. Default cap 4; each `claude --print` is
 *      500MB-2GB resident, so 16 unchecked spawns OOM a 32GB box and
 *      sshd can't fork a login shell. This is the box-protection layer.
 *
 * Tunables:
 *   BRIDGE_HOST_MAX_CONCURRENCY (default 4)
 *   BRIDGE_HOST_ACQUIRE_DEADLINE_MS (default 60_000)
 */

import { spawn } from 'node:child_process'
import { applyJail } from './jail-support.js'
import { killTree, retryCleanupUntilSuccessful } from './process-tree.js'
import {
  ExecutorAbortedError,
  throwIfExecutorAborted,
  type SpawnOpts,
  type SpawnResult,
  type Spawner,
} from './types.js'

const DEFAULT_MAX = 4
const DEFAULT_ACQUIRE_DEADLINE_MS = 60_000

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

class HostSemaphore {
  private inFlight = 0
  private readonly waiters: Waiter[] = []
  /** Cumulative counters for /metrics. */
  acquires = 0
  timeouts = 0

  constructor(
    private readonly max: number,
    private readonly acquireDeadlineMs: number,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    this.acquires += 1
    throwIfExecutorAborted(signal)
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx < 0) return
        const [waiter] = this.waiters.splice(idx, 1)
        if (waiter?.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        this.timeouts += 1
        reject(
          new Error(
            `host-executor: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(in_flight=${this.inFlight}/${this.max}, queued=${this.waiters.length}). ` +
              `Reduce parallel callers or raise BRIDGE_HOST_MAX_CONCURRENCY.`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      const waiter: Waiter = { resolve, reject, timer, signal }
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx < 0) return
        this.waiters.splice(idx, 1)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new ExecutorAbortedError(signal?.reason))
      }
      waiter.onAbort = onAbort
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  release(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      clearTimeout(next.timer)
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(new ExecutorAbortedError(next.signal.reason))
        continue
      }
      next.resolve()
      return
    }
    this.inFlight -= 1
  }

  snapshot(): { in_flight: number; max: number; queued: number; acquires: number; timeouts: number } {
    return {
      in_flight: this.inFlight,
      max: this.max,
      queued: this.waiters.length,
      acquires: this.acquires,
      timeouts: this.timeouts,
    }
  }
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const hostSemaphore = new HostSemaphore(
  readEnvInt('BRIDGE_HOST_MAX_CONCURRENCY', DEFAULT_MAX),
  readEnvInt('BRIDGE_HOST_ACQUIRE_DEADLINE_MS', DEFAULT_ACQUIRE_DEADLINE_MS),
)

interface HostSpawnerDependencies {
  semaphore: Pick<HostSemaphore, 'acquire' | 'release'>
  spawnProcess: typeof spawn
  applyJailFn: typeof applyJail
  killTreeFn: typeof killTree
}

const defaultHostSpawnerDependencies: HostSpawnerDependencies = {
  semaphore: hostSemaphore,
  spawnProcess: spawn,
  applyJailFn: applyJail,
  killTreeFn: killTree,
}

export function createHostSpawner(
  overrides: Partial<HostSpawnerDependencies> = {},
): Spawner {
  const dependencies = { ...defaultHostSpawnerDependencies, ...overrides }
  return async (bin, args, opts) => {
    await dependencies.semaphore.acquire(opts.signal)
    let released = false
    let jailCleanup: (() => Promise<void> | void) | undefined
    try {
      // Wrap (bin, args) in the OS write-jail when a spec is present;
      // otherwise this is a pass-through and (bin, args, env) are unchanged.
      const jailed = await dependencies.applyJailFn(bin, args, opts)
      jailCleanup = jailed.cleanup
      throwIfExecutorAborted(opts.signal)
      // detached: true → child is the leader of a new process group whose
      // pgid equals its pid. kill(-pid, sig) reaches every descendant. We
      // do NOT call child.unref() — the bridge still owns the child for
      // the lifetime of the chat() call.
      const child = dependencies.spawnProcess(jailed.bin, jailed.args, {
        stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        // Pi supplies an already-audited exact environment. Re-filtering it
        // here would silently drop selected providers such as DEEPSEEK and
        // tempt callers to restore ambient process.env. All other backends keep
        // the historical host allowlist.
        env: opts.exactEnv ? jailed.env : sanitizeHostEnv(jailed.env, opts.cwd),
        detached: true,
      })
      // Synchronous error capture — Node fires 'error' on nextTick for spawn
      // failures (ENOENT/EACCES) which runs BEFORE the awaiter's microtask;
      // if a backend attaches its listener after `await`, the event already
      // happened. Capturing here guarantees we don't lose it.
      let spawnError: Error | null = null
      child.on('error', (err) => { spawnError = err })
      let finalization: Promise<void> | null = null
      let onAbort: (() => void) | undefined
      const finalizeOwnership = (): Promise<void> => {
        if (released) return Promise.resolve()
        if (finalization) return finalization
        const attempt = (async () => {
          // A leader exit is not ownership proof: descendants can remain in its
          // process group. Capacity and jail state stay owned until both are gone.
          await dependencies.killTreeFn(child)
          if (jailCleanup) await jailCleanup()
          if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
          released = true
          dependencies.semaphore.release()
        })()
        finalization = attempt
        void attempt.catch(() => {
          if (finalization === attempt) finalization = null
          retryCleanupUntilSuccessful(finalizeOwnership)
        })
        return attempt
      }
      const release = (): void => {
        void finalizeOwnership().catch(error => {
          console.error('[cli-bridge] host ownership cleanup failed:', error)
        })
      }
      // Natural exit still starts descendant cleanup so direct spawner users do
      // not strand capacity. A failed proof keeps the token held.
      child.once('exit', release)
      child.once('error', release)
      onAbort = (): void => { void finalizeOwnership() }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) onAbort()
      const result: SpawnResult = {
        child,
        terminate: finalizeOwnership,
        release,
        spawnError: () => spawnError,
      }
      return result
    } catch (err) {
      let cleanupError: unknown
      if (jailCleanup) {
        try { await jailCleanup() } catch (error) { cleanupError = error }
      }
      if (cleanupError === undefined && !released) dependencies.semaphore.release()
      if (cleanupError !== undefined) {
        const finishFailedSpawn = async (): Promise<void> => {
          await jailCleanup?.()
          if (!released) {
            released = true
            dependencies.semaphore.release()
          }
        }
        retryCleanupUntilSuccessful(finishFailedSpawn)
        throw new AggregateError([err, cleanupError], 'host spawn failed and jail cleanup also failed')
      }
      throw err
    }
  }
}

export const hostSpawner: Spawner = createHostSpawner()

/** Diagnostics for /metrics. */
export function hostExecutorSnapshot(): {
  in_flight: number
  max: number
  queued: number
  acquires: number
  timeouts: number
} {
  return hostSemaphore.snapshot()
}

export function sanitizeHostEnv(env: NodeJS.ProcessEnv | undefined, cwd?: string): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined

  const out: NodeJS.ProcessEnv = {}
  for (const key of BASE_HOST_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.length > MAX_ENV_VALUE_BYTES) continue
    if (BASE_HOST_ENV_KEYS.has(key) || PROXIED_ENV_KEYS.has(key) || PROXIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out[key] = value
    }
  }

  // PWD must agree with the spawn cwd. The inherited value is the BRIDGE
  // daemon's cwd, and some CLIs resolve their working directory from $PWD
  // instead of getcwd() — opencode does, so a stale PWD makes the agent
  // operate (read/WRITE) in the bridge's own directory instead of the
  // request workspace, silently escaping every per-request cwd.
  if (cwd) out.PWD = cwd

  return out
}

const MAX_ENV_VALUE_BYTES = 16_384

const BASE_HOST_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'PWD',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'PNPM_HOME',
])

const PROXIED_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_OAUTH_TOKEN',
  'BRIDGE_BEARER',
  'CLI_BRIDGE_BEARER',
  'CURSOR_API_KEY',
  'GEMINI_SYSTEM_MD',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MCP_DIRECT_TOOLS',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TANGLE_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
])

const PROXIED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'CURSOR_',
  'KIMI_',
  'MOONSHOT_',
  'OPENAI_',
  'OPENCODE_',
  'PI_',
  'TANGLE_',
  'ZAI_',
  'ZHIPU_',
]
