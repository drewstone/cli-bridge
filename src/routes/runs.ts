/**
 * Run admin endpoints — explicit cancel + status for durable runs.
 *
 * Cancel is the ONLY client-initiated path that kills a running CLI
 * subprocess. A socket disconnect does not (the job survives so the
 * client can reconnect); this endpoint is how a caller says "I actually
 * want this stopped." It aborts the run's owned controller, which the
 * backend honors via its `signal → killTree` wiring.
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import type { Run, RunRegistry, RunSnapshot } from '../runs/registry.js'

const MAX_TERMINAL_WAIT_MS = 30_000

export function mountRuns(app: Hono, deps: { runs: RunRegistry }): void {
  app.get('/v1/runs/:id', async (c) => {
    const run = deps.runs.get(c.req.param('id'))
    if (!run) return runNotFound(c)
    const waitMs = parseWaitMs(c)
    if (!waitMs.ok) return invalidWait(c, waitMs.message)
    const snapshot = await terminalSnapshot(run, waitMs.value)
    setRunHeaders(c, snapshot)
    return c.json(snapshot)
  })

  // POST (not DELETE) — cancelling mutates the run's lifecycle and is the
  // semantic counterpart to dispatch, not a resource deletion.
  app.post('/v1/runs/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const run = deps.runs.get(id)
    // Unknown is not proof that a process is gone. Return 404 so a cleanup caller cannot
    // reinterpret "this bridge has no record" as a terminal acknowledgement.
    if (!run) return runNotFound(c)
    const waitMs = parseWaitMs(c)
    if (!waitMs.ok) return invalidWait(c, waitMs.message)

    const cancelRequested = deps.runs.cancel(id)
    const snapshot = await terminalSnapshot(run, waitMs.value)
    setRunHeaders(c, snapshot)
    const body = {
      cancelled: snapshot.status === 'cancelled',
      cancel_requested: cancelRequested,
      terminal: snapshot.terminal,
      run: snapshot,
    }
    if (!snapshot.terminal) {
      c.header('Retry-After', '1')
      return c.json(body, 202)
    }
    return c.json(body)
  })
}

type WaitMsResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

function parseWaitMs(c: Context): WaitMsResult {
  const raw = c.req.query('wait_ms')
  if (raw === undefined) return { ok: true, value: 0 }
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    return { ok: false, message: 'wait_ms must be a non-negative base-10 integer' }
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_TERMINAL_WAIT_MS) {
    return {
      ok: false,
      message: `wait_ms must be at most ${MAX_TERMINAL_WAIT_MS}`,
    }
  }
  return { ok: true, value }
}

async function terminalSnapshot(run: Run, waitMs: number): Promise<RunSnapshot> {
  const current = run.snapshot()
  if (current.terminal || waitMs === 0) return current
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RunSnapshot>((resolve) => {
    timer = setTimeout(() => resolve(run.snapshot()), waitMs)
  })
  try {
    return await Promise.race([run.whenTerminal(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function setRunHeaders(c: Context, snapshot: RunSnapshot): void {
  c.header('X-Run-Id', snapshot.id)
  c.header('X-Run-Request-Digest', snapshot.requestDigest)
  c.header('X-Run-Status', snapshot.status)
  c.header('X-Run-State', snapshot.state)
  c.header('X-Run-Terminal', String(snapshot.terminal))
  c.header('X-Last-Event-Id', String(snapshot.lastSeq))
  if (snapshot.replay.expiresAt !== null) {
    c.header('X-Run-Replay-Expires-At', String(snapshot.replay.expiresAt))
  }
}

function invalidWait(c: Context, message: string): Response {
  return c.json({ error: { message, type: 'invalid_request_error' } }, 400)
}

function runNotFound(c: Context): Response {
  return c.json({ error: { message: 'run not found', type: 'not_found_error' } }, 404)
}
