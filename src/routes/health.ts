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
 * Only `ready` verdicts are cached. A failing backend is RE-PROBED on
 * every request, because a cached failure is the worse of the two
 * errors in both directions:
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
 * storm that got live bridges SIGKILLed cannot come back. Re-probing
 * only the already-failing backends costs one spawn per failing backend
 * per request, bounded by `PROBE_TIMEOUT_MS`.
 *
 * Tradeoff kept: a backend that DIES between probes is reported `ready`
 * for up to the cache TTL. `?force=1` bypasses the cache;
 * `BRIDGE_HEALTH_CACHE_MS=0` disables it.
 */

import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'
import type { Backend, BackendHealth } from '../backends/types.js'
import type { AdmissionGate } from '../admission.js'

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
  deps: { registry: BackendRegistry; admission?: AdmissionGate },
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
    const probes: ReportedHealth[] = await Promise.all(
      deps.registry.all().map(async (b) => {
        const cached = cache.get(b.name)
        // Reusable only while it says `ready`: a fault must be retried so a
        // fixed fault recovers without restarting the process.
        if (!force
          && cached
          && cached.health.state === 'ready'
          && cacheMs > 0
          && ts - cached.probedAt < cacheMs) {
          return { ...cached.health, probed_at: new Date(cached.probedAt).toISOString(), cached: true }
        }
        const probedAt = now()
        const fresh = await probe(b)
        cache.set(b.name, { probedAt, health: fresh })
        return { ...fresh, probed_at: new Date(probedAt).toISOString(), cached: false }
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
