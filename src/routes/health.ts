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
 * `ready` verdicts use the normal cache TTL. Failed verdicts use a shorter
 * retry delay (default 5 s), and one backend can have only one live probe.
 * This preserves fast recovery without allowing watchdog bursts to queue the
 * same stalled process repeatedly. A long-lived cached failure is the worse of
 * the two errors in both directions:
 *
 *   - It cannot recover. Once a fault was cached, fixing the underlying
 *     cause changed nothing until the process restarted. Measured on
 *     this host: a bridge up for ten days served the identical
 *     `No such container` detail after the image was rebuilt and the
 *     directories restored, with `active=0 queued=0` — idle, not busy.
 *   - It looked live while doing it. The response stamps a fresh
 *     top-level `ts` on a verdict from an older probe, which reads as
 *     "just checked, still broken". That is worse than reporting
 *     nothing, so each backend now carries its OWN `probed_at` and a
 *     `cached` flag: no verdict can borrow the response's freshness.
 *
 * The original reason for caching survives untouched — a healthy pool
 * still answers watchdog probes from memory in <1 ms, so the fork+exec
 * storm that got live bridges SIGKILLed cannot come back.
 *
 * Tradeoff kept: a backend that DIES between probes is reported `ready`
 * for up to the cache TTL. `?force=1` bypasses the cache;
 * `BRIDGE_HEALTH_CACHE_MS=0` disables it.
 */

import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'
import type { Backend, BackendHealth } from '../backends/types.js'
import type { AdmissionGate } from '../admission.js'
import { boundedProbe, resolveHealthProbeTimeoutMs } from '../backends/health.js'

export { boundedProbe } from '../backends/health.js'

const DEFAULT_HEALTH_CACHE_MS = 30_000
const DEFAULT_FAILURE_RETRY_BACKOFF_MS = 5_000

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
  /** Minimum delay before retrying a failed probe; defaults to 5 s. */
  failureRetryBackoffMs?: number
  /** Injectable now() for cache-TTL tests. */
  now?: () => number
  /** Injectable probe runner — tests bypass real `b.health()`. */
  probe?: ProbeBackend
}

export function mountHealth(
  app: Hono,
  deps: { registry: BackendRegistry; admission?: AdmissionGate },
  options: MountHealthOptions = {},
): void {
  const cacheMs = options.cacheMs ?? resolveEnvMs('BRIDGE_HEALTH_CACHE_MS', DEFAULT_HEALTH_CACHE_MS)
  const probeTimeoutMs = options.probeTimeoutMs ?? resolveHealthProbeTimeoutMs()
  const failureRetryBackoffMs = options.failureRetryBackoffMs
    ?? resolveEnvMs('BRIDGE_HEALTH_FAILURE_RETRY_BACKOFF_MS', DEFAULT_FAILURE_RETRY_BACKOFF_MS)
  const now = options.now ?? Date.now
  const probe = options.probe ?? ((b) => boundedProbe(b, probeTimeoutMs))
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<CacheEntry>>()

  const runProbe = (backend: Backend): Promise<CacheEntry> => {
    const existing = inFlight.get(backend.name)
    if (existing) return existing
    const probedAt = now()
    const started = probe(backend).then(
      health => ({ probedAt, health }),
      error => ({
        probedAt,
        health: {
          name: backend.name,
          state: 'error' as const,
          detail: error instanceof Error ? error.message : String(error),
        },
      }),
    )
    inFlight.set(backend.name, started)
    void started.then(entry => {
      cache.set(backend.name, entry)
      if (inFlight.get(backend.name) === started) inFlight.delete(backend.name)
    })
    return started
  }

  app.get('/health', async (c) => {
    const force = c.req.query('force') === '1'
    const ts = now()
    // Different backends probe in parallel. Calls for the same backend share
    // one in-flight operation, and `boundedProbe` enforces its time limit.
    const probes: ReportedHealth[] = await Promise.all(
      deps.registry.all().map(async (b) => {
        const cached = cache.get(b.name)
        const reuseFor = cached?.health.state === 'ready' ? cacheMs : failureRetryBackoffMs
        if (!force
          && cached
          && reuseFor > 0
          && ts - cached.probedAt < reuseFor) {
          return { ...cached.health, probed_at: new Date(cached.probedAt).toISOString(), cached: true }
        }
        const fresh = await runProbe(b)
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
      ts: new Date(ts).toISOString(),
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

function resolveEnvMs(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}
