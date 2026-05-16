/**
 * GET /health — status of each registered backend + the server itself.
 *
 * Cached + bounded by design. The watchdog hits this endpoint once per
 * 60s on every bridge instance (5 bridges × 1 probe = 5 calls/min);
 * each call previously fork-exec'd `--version` on every CLI backend
 * (claude, kimi, opencode, …). Under heavy review load — fork+exec
 * stalls when the box's load average climbs past `nproc` — those
 * subprocess spawns can sit in the kernel for >5 s. The watchdog's
 * `curl --max-time 5` then SIGKILLs the bridge because /health looked
 * unresponsive, even though every chat request was healthy.
 *
 * Two defenses, layered:
 *
 *   1. Per-probe timeout (`PROBE_TIMEOUT_MS`). We Promise.race each
 *      backend's `health()` against a timer; a wedged spawn surfaces
 *      as `state: 'error', detail: 'health probe timed out'` instead
 *      of hanging the whole /health endpoint. Independent of any
 *      transport-layer timeout the caller imposes.
 *
 *   2. TTL cache (`HEALTH_CACHE_MS`). Successful probes are memoized
 *      for the TTL window (default 30 s). Watchdog calls return
 *      cached results in <1 ms — the only spawn cost is once per
 *      cache-eviction. `?force=1` bypasses the cache for debugging.
 *
 * Tradeoff: a backend that DIES between probes (CLI crashes or
 * uninstalls) will be reported `ready` for up to the cache TTL.
 * We accept that — the watchdog's job is server liveness, not CLI
 * supervision, and the cost of falsely killing live bridges has
 * proven much worse than the cost of briefly reporting a dead CLI
 * as ready. Set `BRIDGE_HEALTH_CACHE_MS=0` to disable the cache
 * entirely if you need real-time CLI status.
 */

import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'
import type { Backend, BackendHealth } from '../backends/types.js'

const DEFAULT_HEALTH_CACHE_MS = 30_000
const DEFAULT_PROBE_TIMEOUT_MS = 3_500

interface CacheEntry {
  probedAt: number
  health: BackendHealth
}

type ProbeBackend = (backend: Backend) => Promise<BackendHealth>

export interface MountHealthOptions {
  /** Override cache TTL for tests; defaults to BRIDGE_HEALTH_CACHE_MS env or 30 s. */
  cacheMs?: number
  /** Override per-probe timeout for tests; defaults to BRIDGE_HEALTH_PROBE_TIMEOUT_MS env or 3.5 s. */
  probeTimeoutMs?: number
  /** Injectable now() for cache-TTL tests. */
  now?: () => number
  /** Injectable probe runner — tests bypass real `b.health()`. */
  probe?: ProbeBackend
}

export function mountHealth(
  app: Hono,
  deps: { registry: BackendRegistry },
  options: MountHealthOptions = {},
): void {
  const cacheMs = options.cacheMs ?? resolveEnvMs('BRIDGE_HEALTH_CACHE_MS', DEFAULT_HEALTH_CACHE_MS)
  const probeTimeoutMs = options.probeTimeoutMs ?? resolveEnvMs('BRIDGE_HEALTH_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS)
  const now = options.now ?? Date.now
  const probe = options.probe ?? ((b) => boundedProbe(b, probeTimeoutMs))
  const cache = new Map<string, CacheEntry>()

  app.get('/health', async (c) => {
    const force = c.req.query('force') === '1'
    const ts = now()
    // Run all backend probes in parallel — independent CLIs have no
    // shared resource that benefits from serial execution. `boundedProbe`
    // already enforces a per-backend ceiling, so the whole request
    // returns within ~probeTimeoutMs even in the worst case.
    const probes: BackendHealth[] = await Promise.all(
      deps.registry.all().map(async (b) => {
        const cached = cache.get(b.name)
        if (!force && cached && cacheMs > 0 && ts - cached.probedAt < cacheMs) {
          return cached.health
        }
        const fresh = await probe(b)
        cache.set(b.name, { probedAt: ts, health: fresh })
        return fresh
      }),
    )
    const any = probes.some((p) => p.state === 'ready')
    return c.json({
      status: any ? 'ok' : 'degraded',
      backends: probes,
      ts: new Date(ts).toISOString(),
    }, any ? 200 : 503)
  })
}

/**
 * Run `backend.health()` with a hard ceiling. If the underlying probe
 * exceeds `timeoutMs` (which happens when the CLI spawn wedges under
 * heavy load or the binary's I/O stalls), short-circuit to a synthetic
 * `error` result. The actual spawn is left running — caller policy is
 * "report and move on"; an orphan `--version` subprocess is bounded
 * by the OS reaping it after its own `_exit()`. We do NOT use this as
 * a vehicle to forcibly kill the spawn — the cost of killing a
 * legitimately-slow probe is worse than letting it complete in the
 * background.
 *
 * Exported for tests.
 */
export async function boundedProbe(
  backend: Backend,
  timeoutMs: number,
): Promise<BackendHealth> {
  if (timeoutMs <= 0) return backend.health()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout: Promise<BackendHealth> = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        name: backend.name,
        state: 'error',
        detail: `health probe timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      backend.health().then((result) => {
        if (timer) clearTimeout(timer)
        return result
      }, (err) => {
        if (timer) clearTimeout(timer)
        return {
          name: backend.name,
          state: 'error' as const,
          detail: err instanceof Error ? err.message : String(err),
        }
      }),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resolveEnvMs(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}
