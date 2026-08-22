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
 * A slot is held for the lifetime of the SPAWNED PROCESS, which for a retained
 * backend (pi) is the whole live SESSION — spawn to session termination,
 * including the idle time between turns. Size the cap at peak live sessions,
 * not at peak concurrent turns.
 *
 * Tunables:
 *   BRIDGE_HOST_MAX_CONCURRENCY (default 4)
 *   BRIDGE_HOST_ACQUIRE_DEADLINE_MS (default 60_000)
 *   BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS (default 900_000) — ceiling on the
 *   per-request `execution.acquireTimeoutMs`.
 */

import { spawn } from 'node:child_process'
import { applyJail } from './jail-support.js'
import { ExecutorSaturatedError, type SpawnOpts, type SpawnResult, type Spawner } from './types.js'

const DEFAULT_MAX = 4
const DEFAULT_ACQUIRE_DEADLINE_MS = 60_000
/**
 * Ceiling on a caller-supplied acquire deadline. 15 minutes is the settle grace
 * a supervisor already grants a worker child, and a caller that is willing to
 * spend it waiting for a slot loses nothing by waiting: the slot frees or the
 * caller learns the box is full, and neither outcome costs a model call.
 */
const DEFAULT_MAX_ACQUIRE_DEADLINE_MS = 900_000

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
    private readonly maxAcquireDeadlineMs: number,
  ) {}

  /**
   * Wait for a slot, up to `requestedDeadlineMs` capped by the server maximum.
   *
   * The refusal is a typed capacity answer, not a spawn failure: it happens
   * before the child exists, so the caller can retry it with nothing lost.
   */
  async acquire(requestedDeadlineMs?: number): Promise<void> {
    this.acquires += 1
    const deadlineMs = this.resolveDeadline(requestedDeadlineMs)
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        this.timeouts += 1
        reject(saturated('host', 'host-executor', this.inFlight, this.max, this.waiters.length, deadlineMs))
      }, deadlineMs).unref()
      this.waiters.push({ resolve, reject, timer })
    })
  }

  /** A request may shorten or lengthen the wait, never past the server cap. */
  resolveDeadline(requestedDeadlineMs?: number): number {
    if (requestedDeadlineMs === undefined) return this.acquireDeadlineMs
    return Math.max(1, Math.min(requestedDeadlineMs, this.maxAcquireDeadlineMs))
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

  snapshot(): HostExecutorSnapshot {
    return {
      in_flight: this.inFlight,
      max: this.max,
      queued: this.waiters.length,
      acquire_deadline_ms: this.acquireDeadlineMs,
      max_acquire_deadline_ms: this.maxAcquireDeadlineMs,
      acquires: this.acquires,
      timeouts: this.timeouts,
    }
  }
}

/**
 * One saturation refusal, worded so the existing prose signature survives.
 *
 * Callers built retry loops on the exact shape
 * `(?:host-executor|scoped-host-executor|container-pool): acquire timeout after \d+ms`
 * before the typed fields existed, and those loops are still running, so
 * nothing may come between the executor name and that phrase. The
 * remedy sentence is gone on purpose: "reduce parallel callers" describes the
 * one-shot backends, and it is wrong for a retained backend whose slot is one
 * live session. The counts now say the same thing without asserting a cause,
 * and the body stays inside the 300-byte window a client reads it through.
 */
function saturated(
  executor: string,
  label: string,
  inFlight: number,
  max: number,
  queued: number,
  deadlineMs: number,
  /** Extra counts, appended INSIDE the parentheses so the prefix is unchanged. */
  detail?: string,
): ExecutorSaturatedError {
  const counts = `${detail ? `${detail}, ` : ''}in_flight=${inFlight}/${max}, queued=${queued}`
  return new ExecutorSaturatedError(
    executor,
    { in_flight: inFlight, max, queued, deadline_ms: deadlineMs },
    `${label}: acquire timeout after ${deadlineMs}ms (${counts})`,
  )
}

export interface HostExecutorSnapshot {
  in_flight: number
  max: number
  queued: number
  /** Default wait a request with no `execution.acquireTimeoutMs` gets. */
  acquire_deadline_ms: number
  /** Ceiling this executor applies to a request-supplied acquire deadline. */
  max_acquire_deadline_ms: number
  acquires: number
  timeouts: number
}

/** Shared by the scoped-host executor, whose refusal is the same condition. */
export { saturated as executorSaturatedError }

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const hostSemaphore = new HostSemaphore(
  readEnvInt('BRIDGE_HOST_MAX_CONCURRENCY', DEFAULT_MAX),
  readEnvInt('BRIDGE_HOST_ACQUIRE_DEADLINE_MS', DEFAULT_ACQUIRE_DEADLINE_MS),
  readEnvInt('BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS', DEFAULT_MAX_ACQUIRE_DEADLINE_MS),
)

export const hostSpawner: Spawner = async (bin, args, opts) => {
  await hostSemaphore.acquire(opts.acquireDeadlineMs)
  let released = false
  let jailCleanup: (() => Promise<void> | void) | undefined
  const release = (): void => {
    if (released) return
    released = true
    hostSemaphore.release()
    // Idempotent: release() guards on `released`, so the jail cleanup
    // (e.g. an SBPL profile temp dir) fires exactly once whether release
    // is triggered by the backend's finally block or the child exit/error
    // listeners below.
    if (jailCleanup) void Promise.resolve(jailCleanup()).catch(() => {})
  }
  try {
    // Wrap (bin, args) in the OS write-jail when a spec is present;
    // otherwise this is a pass-through and (bin, args, env) are unchanged.
    const jailed = await applyJail(bin, args, opts)
    jailCleanup = jailed.cleanup
    // detached: true → child is the leader of a new process group whose
    // pgid equals its pid. kill(-pid, sig) reaches every descendant. We
    // do NOT call child.unref() — the bridge still owns the child for
    // the lifetime of the chat() call.
    const child = spawn(jailed.bin, jailed.args, {
      signal: opts.signal,
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: sanitizeHostEnv(jailed.env, opts.cwd),
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
hostSpawner.executionEnvironment = 'host'

/** Diagnostics for /metrics and /health. */
export function hostExecutorSnapshot(): HostExecutorSnapshot {
  return hostSemaphore.snapshot()
}

/**
 * The wait this executor would grant for a requested acquire deadline.
 *
 * The chat route calls this to CAP a caller's `execution.acquireTimeoutMs`
 * once, at the wire boundary, so the resolved number is what the response and
 * the executor agree on.
 */
export function resolveHostAcquireDeadlineMs(requestedDeadlineMs?: number): number {
  return hostSemaphore.resolveDeadline(requestedDeadlineMs)
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
    // Trace-context keys pass only when they are NOT the daemon's own ambient
    // value. A backend that stamps per-request trace context (pi, from
    // `ChatRequest.childTrace`) produces a value the daemon env does not
    // hold, and that correlation must reach the child. A backend that spreads
    // the whole `process.env` (codex, opencode, kimi, gemini) copies the
    // BRIDGE's launch-time `TRACEPARENT` — e.g. from a traced shell that
    // restarted the daemon — and letting that through would parent every
    // child's spans under the bridge's own launch context instead of its
    // caller's trace. Same value as ambient = inherited, so it stays stripped.
    if (TRACE_PROPAGATION_ENV_KEYS.has(key)) {
      if (process.env[key] !== value) out[key] = value
      continue
    }
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

/**
 * Trace-context vars a backend may stamp into a child env so the harness
 * joins its caller's trace: W3C `TRACEPARENT`, plus agent-runtime's legacy
 * `TRACE_ID` / `PARENT_SPAN_ID` fallback pair — the exact spellings its
 * `readTraceContextFromEnv` reads at child startup. Guarded in the filter
 * above: request-stamped values pass, the daemon's own ambient values never
 * do.
 */
const TRACE_PROPAGATION_ENV_KEYS = new Set([
  'TRACEPARENT',
  'TRACE_ID',
  'PARENT_SPAN_ID',
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
