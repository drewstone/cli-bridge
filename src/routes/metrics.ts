/** Host executor counters used by deployment idle checks. Covered by the bearer guard. */
import type { Hono } from 'hono'
import { hostExecutorSnapshot } from '../executors/host.js'
import { scopedHostExecutorSnapshot } from '../executors/scoped-host.js'

export function mountMetrics(app: Hono): void {
  app.get('/metrics', (c) => c.json({
    ts: new Date().toISOString(),
    host_executor: hostExecutorSnapshot(),
    scoped_host_executor: scopedHostExecutorSnapshot(),
  }))
}
