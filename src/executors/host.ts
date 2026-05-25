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
import type { SpawnOpts, SpawnResult, Spawner } from './types.js'

const DEFAULT_MAX = 4
const DEFAULT_ACQUIRE_DEADLINE_MS = 60_000

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
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

  async acquire(): Promise<void> {
    this.acquires += 1
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        this.timeouts += 1
        reject(
          new Error(
            `host-executor: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(in_flight=${this.inFlight}/${this.max}, queued=${this.waiters.length}). ` +
              `Reduce parallel callers or raise BRIDGE_HOST_MAX_CONCURRENCY.`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      this.waiters.push({ resolve, reject, timer })
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
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

export const hostSpawner: Spawner = async (bin, args, opts) => {
  await hostSemaphore.acquire()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    hostSemaphore.release()
  }
  try {
    // detached: true → child is the leader of a new process group whose
    // pgid equals its pid. kill(-pid, sig) reaches every descendant. We
    // do NOT call child.unref() — the bridge still owns the child for
    // the lifetime of the chat() call.
    const child = spawn(bin, args, {
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: sanitizeHostEnv(opts.env),
      detached: true,
    })
    // Synchronous error capture — Node fires 'error' on nextTick for spawn
    // failures (ENOENT/EACCES) which runs BEFORE the awaiter's microtask;
    // if a backend attaches its listener after `await`, the event already
    // happened. Capturing here guarantees we don't lose it.
    let spawnError: Error | null = null
    child.on('error', (err) => { spawnError = err })
    // Auto-release the semaphore on exit/error, regardless of whether
    // the backend remembered to call release(). Idempotent double-call.
    child.once('exit', release)
    child.once('error', release)
    const result: SpawnResult = {
      child,
      release,
      spawnError: () => spawnError,
    }
    return result
  } catch (err) {
    release()
    throw err
  }
}

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

export function sanitizeHostEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
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
  'GH_TOKEN',
  'GITHUB_TOKEN',
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
  'TANGLE_',
  'ZAI_',
  'ZHIPU_',
]
