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
import { streamSSE } from 'hono/streaming'
import {
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
  type AgentExactRunControlRef,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import {
  type Run,
  type RunRegistry,
  RunReplayCursorError,
  type RunSnapshot,
} from '../runs/registry.js'
import type { RetainedEventRecord } from '../sessions/store.js'
import type { DurableRetainedRunSnapshot } from '../sessions/retained.js'
import { readBoundedJson } from '../sessions/retained/http.js'
import { RetainedSessionError } from '../sessions/retained/types.js'
import { resolveRunEventCursor, streamRunEvents } from './run-events.js'

const MAX_TERMINAL_WAIT_MS = 30_000

/**
 * Cancellation acknowledgements retained for idempotent replay.
 *
 * One entry per distinct `operationId`, and nothing ever removed them, so a
 * long-lived bridge accumulated one record per cancellation for the life of the
 * process. The cap is far above any caller's in-flight retry window: a record
 * only has to outlive the retries of the operation that created it, and the
 * oldest entry is the one least likely to still be retried.
 */
const MAX_RETAINED_CANCELLATIONS = 10_000

function retainCancellation(
  cancellations: Map<string, CancellationRecord>,
  operationId: string,
  record: CancellationRecord,
): void {
  cancellations.set(operationId, record)
  while (cancellations.size > MAX_RETAINED_CANCELLATIONS) {
    const oldest = cancellations.keys().next()
    if (oldest.done) break
    cancellations.delete(oldest.value)
  }
}

export function mountRuns(app: Hono, deps: {
  runs: RunRegistry
  /** Durable retained-run reads used after the in-memory Run has been retired. */
  retainedRuns?: {
    runSnapshot(runId: string): DurableRetainedRunSnapshot | null
    runLastSequence(runId: string): number
    assertRunReplayCursor(runId: string, afterSequence: number): void
    runEvents(runId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord>
  }
}): void {
  const cancellations = new Map<string, CancellationRecord>()

  app.get('/v1/runs/:id', async (c) => {
    const id = c.req.param('id')
    const run = deps.runs.get(id)
    if (!run) {
      const retained = deps.retainedRuns?.runSnapshot(id)
      if (!retained) return runNotFound(c)
      setRetainedRunHeaders(c, retained, deps.retainedRuns?.runLastSequence(id) ?? 0)
      return c.json(retained)
    }
    const waitMs = parseWaitMs(c)
    if (!waitMs.ok) return invalidWait(c, waitMs.message)
    const snapshot = await terminalSnapshot(run, waitMs.value)
    setRunHeaders(c, snapshot)
    return c.json(snapshot)
  })

  app.get('/v1/runs/:id/events', (c) => {
    const cursor = resolveRunEventCursor(
      c.req.header('Last-Event-ID'),
      c.req.header('X-Last-Event-Id'),
    )
    if (!cursor.ok) return invalidRequest(c, cursor.message)
    const id = c.req.param('id')
    const retained = deps.retainedRuns
    const retainedSnapshot = retained?.runSnapshot(id)
    if (retained && retainedSnapshot) {
      try {
        retained.assertRunReplayCursor(id, cursor.value)
      } catch (error) {
        if (error instanceof RunReplayCursorError) return replayCursorError(c, error)
        return retainedRunError(c, error)
      }
      setRetainedRunHeaders(c, retainedSnapshot, retained.runLastSequence(id))
      return streamRetainedRunEvents(c, (signal) => retained.runEvents(id, cursor.value, signal))
    }
    const run = deps.runs.get(id)
    if (!run) {
      if (!retained) return runNotFound(c)
      try {
        retained.assertRunReplayCursor(id, cursor.value)
      } catch (error) {
        if (error instanceof RunReplayCursorError) return replayCursorError(c, error)
        return retainedRunError(c, error)
      }
      return streamRetainedRunEvents(c, (signal) => retained.runEvents(id, cursor.value, signal))
    }
    try {
      run.assertReplayCursor(cursor.value)
    } catch (error) {
      if (error instanceof RunReplayCursorError) return replayCursorError(c, error)
      throw error
    }
    setRunHeaders(c, run.snapshot())
    return streamRunEvents(c, run, 'cli-bridge', cursor.value)
  })

  // POST (not DELETE) — cancelling mutates the run's lifecycle and is the
  // semantic counterpart to dispatch, not a resource deletion.
  app.post('/v1/runs/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const parsedBody = await cancellationBody(c)
    if (!parsedBody.ok) {
      return c.json({ error: { message: parsedBody.message, type: parsedBody.type } }, parsedBody.status)
    }
    if (parsedBody.request) {
      return exactCancellation(c, deps.runs, cancellations, id, parsedBody.request)
    }
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

interface CancellationRecord {
  readonly requestDigest: Sha256Digest
  readonly acknowledgement: AgentRunCancellationAcknowledgement
}

type CancellationBody =
  | { readonly ok: true; readonly request?: AgentRunCancellationRequest }
  | {
      readonly ok: false
      readonly message: string
      readonly status: 400 | 413
      readonly type: 'invalid_request_error' | 'request_too_large'
    }

async function cancellationBody(c: Context): Promise<CancellationBody> {
  try {
    const value = await readBoundedJson(c.req.raw)
    if (value === undefined) return { ok: true }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      return { ok: true }
    }
    const request = AgentRunCancellationRequestSchema.safeParse(value)
    if (!request.success) {
      return {
        ok: false,
        message: request.error.issues[0]?.message ?? 'invalid cancellation request',
        status: 400,
        type: 'invalid_request_error',
      }
    }
    return { ok: true, request: request.data }
  } catch (error) {
    if (error instanceof RetainedSessionError) {
      return {
        ok: false,
        message: error.message,
        status: error.status === 413 ? 413 : 400,
        type: error.code === 'request_too_large' ? 'request_too_large' : 'invalid_request_error',
      }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      status: 400,
      type: 'invalid_request_error',
    }
  }
}

async function exactCancellation(
  c: Context,
  runs: RunRegistry,
  cancellations: Map<string, CancellationRecord>,
  runId: string,
  request: AgentRunCancellationRequest,
): Promise<Response> {
  if (request.run.runId !== runId) {
    return invalidRequest(c, 'cancellation run id does not match the request path', 409)
  }
  const existing = cancellations.get(request.operationId)
  if (existing) {
    if (existing.requestDigest !== request.requestDigest) {
      const conflict = cancellationAcknowledgement({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: 'conflict',
        effect: 'unknown',
        existingRequestDigest: existing.requestDigest,
      })
      return c.json(conflict, 409)
    }
    const replayed = existing.acknowledgement.status === 'unknown'
      ? existing.acknowledgement
      : cancellationAcknowledgement({
          ...existing.acknowledgement,
          status: 'replayed',
        })
    return c.json(replayed, replayed.effect === 'cancel_requested' ? 202 : 200)
  }

  const run = runs.get(runId)
  if (!run) {
    const unknown = cancellationAcknowledgement({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      run: request.run,
      status: 'unknown',
      effect: 'unknown',
      message: 'this bridge process has no record of the run',
      retryable: false,
    })
    retainCancellation(cancellations, request.operationId, {
      requestDigest: request.requestDigest,
      acknowledgement: unknown,
    })
    return c.json(unknown)
  }
  if (request.run.requestDigest !== run.requestDigest) {
    return invalidRequest(c, 'cancellation request digest does not match the retained run', 409)
  }
  if (!runCoordinatesMatch(run, request.run)) {
    return c.json(
      {
        error: {
          message: 'cancellation run coordinates do not match the claimed run',
          type: 'run_identity_conflict',
          run_id: runId,
        },
      },
      409,
    )
  }

  const waitMs = parseWaitMs(c)
  if (!waitMs.ok) return invalidWait(c, waitMs.message)
  const cancelRequested = runs.cancel(runId)
  const snapshot = await terminalSnapshot(run, waitMs.value)
  setRunHeaders(c, snapshot)
  const effect = snapshot.status === 'cancelled'
    ? 'cancelled' as const
    : snapshot.terminal
      ? 'not_live' as const
      : 'cancel_requested' as const
  const acknowledgement = cancellationAcknowledgement({
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    run: request.run,
    status: 'accepted',
    effect,
    ...(!cancelRequested && effect === 'cancel_requested'
      ? { message: 'cancellation was already requested' }
      : {}),
  })
  retainCancellation(cancellations, request.operationId, {
    requestDigest: request.requestDigest,
    acknowledgement,
  })
  if (effect === 'cancel_requested') {
    c.header('Retry-After', '1')
    return c.json(acknowledgement, 202)
  }
  return c.json(acknowledgement)
}

function cancellationAcknowledgement(
  value: AgentRunCancellationAcknowledgement,
): AgentRunCancellationAcknowledgement {
  return AgentRunCancellationAcknowledgementSchema.parse(value)
}

function runCoordinatesMatch(run: Run, reference: AgentExactRunControlRef): boolean {
  const snapshot = run.snapshot()
  return snapshot.id === reference.runId
    && snapshot.requestDigest === reference.requestDigest
    && snapshot.provider === reference.provider
    && snapshot.environmentId === reference.environmentId
    && snapshot.sessionId === reference.sessionId
    && snapshot.executionId === reference.executionId
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

function setRetainedRunHeaders(c: Context, snapshot: DurableRetainedRunSnapshot, lastCanonicalSequence: number): void {
  c.header('X-Run-Id', snapshot.id)
  c.header('X-Run-Request-Digest', snapshot.requestDigest)
  c.header('X-Run-Status', snapshot.status)
  c.header('X-Run-State', snapshot.state)
  c.header('X-Run-Terminal', String(snapshot.terminal))
  c.header('X-Last-Event-Id', String(lastCanonicalSequence))
}

function streamRetainedRunEvents(
  c: Context,
  source: (signal: AbortSignal) => AsyncIterable<RetainedEventRecord>,
): Response {
  return streamSSE(c, async (stream) => {
    const controller = new AbortController()
    stream.onAbort(() => controller.abort())
    try {
      for await (const item of source(controller.signal)) {
        if (controller.signal.aborted) return
        await stream.writeSSE({
          id: String(item.envelope.sequence),
          event: item.envelope.event.type,
          data: JSON.stringify(item.envelope),
        })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'server_error',
          },
        }),
      })
    }
  })
}

function retainedRunError(c: Context, error: unknown): Response {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    'code' in error &&
    typeof error.status === 'number' &&
    typeof error.code === 'string'
  ) {
    return c.json(
      { error: { message: error instanceof Error ? error.message : String(error), type: error.code } },
      error.status as 400 | 404 | 409 | 500 | 501 | 502 | 503,
    )
  }
  return c.json(
    { error: { message: error instanceof Error ? error.message : String(error), type: 'server_error' } },
    500,
  )
}

function invalidWait(c: Context, message: string): Response {
  return c.json({ error: { message, type: 'invalid_request_error' } }, 400)
}

function invalidRequest(c: Context, message: string, status: 400 | 409 = 400): Response {
  return c.json({ error: { message, type: 'invalid_request_error' } }, status)
}

function replayCursorError(c: Context, error: RunReplayCursorError): Response {
  return c.json(
    {
      error: {
        message: error.message,
        type: error.code,
        run_id: error.runId,
        requested_event_id: error.cursor,
        first_available_event_id: error.firstAvailableSeq,
        last_event_id: error.lastSeq,
      },
    },
    error.reason === 'expired' ? 410 : 409,
  )
}

function runNotFound(c: Context): Response {
  return c.json({ error: { message: 'run not found', type: 'not_found_error' } }, 404)
}
