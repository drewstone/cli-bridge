/**
 * GET /metrics — JSON snapshot of pool + host-semaphore counters.
 *
 * Operator dashboard surface. Each pool registered via
 * `registerPoolForMetrics` shows up under `pools[name]`; the host
 * semaphore is always present. Counters are cumulative since process
 * start; gauges (`in_flight`, `queued`) are current.
 *
 * Auth: covered by the bridge-wide BRIDGE_BEARER guard. No additional
 * controls; secrets/cost data aren't here, just operational counters.
 */

import type { Hono } from 'hono'
import { hostExecutorSnapshot } from '../executors/host.js'
import { scopedHostExecutorSnapshot } from '../executors/scoped-host.js'
import type { ContainerPool } from '../executors/container-pool.js'

const registeredPools = new Map<string, ContainerPool>()

export function registerPoolForMetrics(name: string, pool: ContainerPool): void {
  registeredPools.set(name, pool)
}

export function mountMetrics(app: Hono): void {
  app.get('/metrics', (c) => {
    const pools: Record<string, ReturnType<ContainerPool['snapshot']>> = {}
    for (const [name, pool] of registeredPools) pools[name] = pool.snapshot()
    return c.json({
      ts: new Date().toISOString(),
      host_executor: hostExecutorSnapshot(),
      scoped_host_executor: scopedHostExecutorSnapshot(),
      pools,
    })
  })
}
