/**
 * GET /health — status of each registered backend + the server itself.
 * Useful as a liveness probe AND as "which CLIs am I currently able to
 * drive from this box?"
 */

import { Hono } from 'hono'
import type { BackendRegistry } from '../backends/registry.js'

export function mountHealth(app: Hono, deps: { registry: BackendRegistry }): void {
  app.get('/health', async (c) => {
    const probes = await Promise.all(deps.registry.all().map(b => b.health()))
    const any = probes.some(p => p.state === 'ready')
    return c.json({
      status: any ? 'ok' : 'degraded',
      backends: probes,
      ts: new Date().toISOString(),
    }, any ? 200 : 503)
  })
}
