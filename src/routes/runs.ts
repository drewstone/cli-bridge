/**
 * Run admin endpoints — explicit cancel + status for durable runs.
 *
 * Cancel is the ONLY client-initiated path that kills a running CLI
 * subprocess. A socket disconnect does not (the job survives so the
 * client can reconnect); this endpoint is how a caller says "I actually
 * want this stopped." It aborts the run's owned controller, which the
 * backend honors via its `signal → killTree` wiring.
 */

import { Hono } from 'hono'
import type { RunRegistry } from '../runs/registry.js'

export function mountRuns(app: Hono, deps: { runs: RunRegistry }): void {
  app.get('/v1/runs/:id', (c) => {
    const run = deps.runs.get(c.req.param('id'))
    if (!run) return c.json({ error: { message: 'run not found', type: 'not_found_error' } }, 404)
    return c.json(run.snapshot())
  })

  // POST (not DELETE) — cancelling mutates the run's lifecycle and is the
  // semantic counterpart to dispatch, not a resource deletion.
  app.post('/v1/runs/:id/cancel', (c) => {
    const cancelled = deps.runs.cancel(c.req.param('id'))
    if (!cancelled) {
      // Already terminal or unknown — idempotent success-ish: nothing to kill.
      return c.json({ cancelled: false }, 200)
    }
    return c.json({ cancelled: true })
  })
}
