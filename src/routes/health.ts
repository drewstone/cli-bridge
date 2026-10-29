/**
 * Bounded backend health with per-probe provenance. Healthy verdicts use the
 * regular TTL; faults use a short negative TTL and one request-driven refresh.
 * Warm fault responses never wait for that refresh. ?force=1 waits for a fresh
 * shared probe; disabling caching restores fresh probes on every request.
 */

import { getHeapStatistics } from 'node:v8'
import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'
import type { Backend, BackendHealth } from '../backends/types.js'
import { boundedProbe, resolveHealthProbeTimeoutMs } from '../backends/health.js'
import type { AdmissionGate } from '../admission.js'
import type { RunRegistry } from '../runs/registry.js'
import { hostExecutorSnapshot } from '../executors/host.js'
import { scopedHostExecutorSnapshot } from '../executors/scoped-host.js'

const DEFAULT_HEALTH_CACHE_MS = 30_000
const DEFAULT_HEALTH_NEGATIVE_CACHE_MS = 1_000

interface CacheEntry {
  probedAt: number
  completedAt: number
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

/**
 * Heap pressure, reported so a caller can see the wall before it hits one.
 *
 * A bridge that dies of heap exhaustion gives an operator no warning at all —
 * memory growth produces no log line, and the first signal is a dead port that
 * takes every in-flight run with it. `used_pct` is what a fleet launcher checks
 * before dispatching a wave; `runs_retained` and `run_replay_bytes` say how
 * much of the heap the durable run registry is accountable for.
 */
/**
 * Executor-slot occupancy, so a launcher can gate admission BEFORE it spawns.
 *
 * The counts were only on `/metrics`, and a fleet launcher that watches
 * `/health` therefore dispatched into a full box and lost the spawn to an
 * acquire timeout. `in_flight`/`max` is the number to gate on; `queued` says
 * how many callers are already waiting for the same slots.
 *
 * A slot is held for the life of the spawned PROCESS. For a retained backend
 * (pi) that is one live SESSION, idle turns included — so `max` is a ceiling on
 * concurrent live sessions, not on concurrent turns.
 */
function executorSnapshot(): Record<string, unknown> {
  return {
    ...hostExecutorSnapshot(),
    scoped_host: scopedHostExecutorSnapshot(),
  }
}

function memorySnapshot(runs?: RunRegistry): Record<string, unknown> {
  const usage = process.memoryUsage()
  const limit = getHeapStatistics().heap_size_limit
  return {
    heap_used_bytes: usage.heapUsed,
    heap_total_bytes: usage.heapTotal,
    heap_limit_bytes: limit,
    heap_used_pct: limit > 0 ? Math.round((usage.heapUsed / limit) * 1000) / 10 : null,
    rss_bytes: usage.rss,
    external_bytes: usage.external,
    ...(runs ? { runs_retained: runs.size(), run_replay_bytes: runs.retainedBytes() } : {}),
  }
}

export function mountHealth(
  app: Hono,
  deps: { registry: BackendRegistry; admission?: AdmissionGate; runs?: RunRegistry },
  options: MountHealthOptions = {},
): void {
  const cacheMs = options.cacheMs ?? resolveEnvMs('BRIDGE_HEALTH_CACHE_MS', DEFAULT_HEALTH_CACHE_MS)
  const negativeCacheMs = cacheMs > 0 ? resolveEnvMs('BRIDGE_HEALTH_NEGATIVE_CACHE_MS', DEFAULT_HEALTH_NEGATIVE_CACHE_MS) : 0
  const probeTimeoutMs = options.probeTimeoutMs ?? resolveHealthProbeTimeoutMs()
  const now = options.now ?? Date.now
  const probe = options.probe ?? ((b) => boundedProbe(b, probeTimeoutMs))
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<CacheEntry>>()

  const probeFresh = (backend: Backend): Promise<CacheEntry> => {
    const existing = inFlight.get(backend.name)
    if (existing) return existing

    const pending = (async () => {
      const probedAt = now()
      const health = await probe(backend)
      const fresh = { probedAt, completedAt: now(), health }
      cache.set(backend.name, fresh)
      return fresh
    })()
    inFlight.set(backend.name, pending)
    void pending.finally(() => {
      if (inFlight.get(backend.name) === pending) inFlight.delete(backend.name)
    }).catch(() => {})
    return pending
  }

  app.get('/health', async (c) => {
    const force = c.req.query('force') === '1'
    const ts = now()
    // Run all backend probes in parallel — independent CLIs have no
    // shared resource that benefits from serial execution. `boundedProbe`
    // already enforces a per-backend ceiling, so the whole request
    // returns within ~probeTimeoutMs even in the worst case.
    const probes: ReportedHealth[] = await Promise.all(
      deps.registry.all().map(async (b) => {
        const cached = cache.get(b.name)
        if (!force && cached && cached.health.state !== 'ready' && negativeCacheMs > 0) {
          if (ts - cached.completedAt >= negativeCacheMs) void probeFresh(b).catch(() => {})
          return { ...cached.health, probed_at: new Date(cached.probedAt).toISOString(), cached: true }
        }
        const pending = inFlight.get(b.name)
        if (pending) {
          const fresh = await pending
          return { ...fresh.health, probed_at: new Date(fresh.probedAt).toISOString(), cached: false }
        }
        // Successful verdicts keep their regular TTL; faults refresh above.
        if (!force
          && cached
          && cached.health.state === 'ready'
          && cacheMs > 0
          && ts - cached.probedAt < cacheMs) {
          return { ...cached.health, probed_at: new Date(cached.probedAt).toISOString(), cached: true }
        }
        const fresh = await probeFresh(b)
        return { ...fresh.health, probed_at: new Date(fresh.probedAt).toISOString(), cached: false }
      }),
    )
    const any = probes.some((p) => p.state === 'ready')
    // `status` and the HTTP code are what a watchdog reads, and they are derived
    // from verdicts that may be remembered rather than measured — a bridge whose
    // last container was removed 5 s ago still answers ok/200 until the TTL
    // expires. Per-backend `cached`/`probed_at` made that visible to a reader who
    // inspects `backends[]`; these two fields make it visible to one who does
    // not. `?force=1` re-measures.
    const cachedVerdicts = probes.some((p) => p.cached)
    const oldestProbedAt = probes
      .map((p) => p.probed_at)
      .sort()[0]
    return c.json({
      status: any ? 'ok' : 'degraded',
      /** True when at least one verdict behind `status` was not measured on this request. */
      cached_verdicts: cachedVerdicts,
      /** When the OLDEST verdict behind `status` was measured. Not the same as `ts`. */
      ...(oldestProbedAt ? { oldest_probed_at: oldestProbedAt } : {}),
      backends: probes,
      ...(deps.admission ? { admission: deps.admission.snapshot() } : {}),
      executor: executorSnapshot(),
      memory: memorySnapshot(deps.runs),
      ts: new Date(now()).toISOString(),
    }, any ? 200 : 503)
  })
}

/**
 * A backend verdict plus its own provenance. `probed_at` is when the verdict
 * was MEASURED, which is not the response's `ts`; `cached` says outright whether
 * this request re-measured. Without both, a caller cannot tell a live failure
 * from a remembered one.
 */
export interface ReportedHealth extends BackendHealth {
  probed_at: string
  cached: boolean
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
export { boundedProbe }

function resolveEnvMs(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}
