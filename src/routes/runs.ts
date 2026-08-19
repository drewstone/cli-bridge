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
} from '@tangle-network/agent-interface'
import {
  type Run,
  type RunRegistry,
  RunReplayCursorError,
  type RunSnapshot,
} from '../runs/registry.js'
import type { RetainedEventRecord, SessionStore } from '../sessions/store.js'
import type { DurableRetainedRunSnapshot } from '../sessions/retained.js'
import { readBoundedJson } from '../sessions/retained/http.js'
import { RetainedSessionError } from '../sessions/retained/types.js'
import { resolveRunEventCursor, streamChatDeltaEvents, streamRunEvents } from './run-events.js'
import { setExactRunIdentityHeaders, setRunIdentityHeaders } from '../runs/headers.js'
import { isSafeWireIdentifier } from '../runs/identifiers.js'
import { retainedChatDeltas } from '../runs/persisted-chat-event.js'

const MAX_TERMINAL_WAIT_MS = 30_000

/**
 * Exact cancellation idempotency is persisted by SessionStore.
 *
 * The store is the only authority across bridge process restarts.
 */
export function mountRuns(app: Hono, deps: {
  runs: RunRegistry
  /** Durable retained-run reads used after the in-memory Run has been retired. */
  retainedRuns?: {
    runSnapshot(runId: string): DurableRetainedRunSnapshot | null
    runLastSequence(runId: string): number
    assertRunReplayCursor(runId: string, afterSequence: number): void
    runEvents(runId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord>
  }
  /** The existing SQLite store owns exact cancellation idempotency. */
  retainedStore?: Pick<SessionStore, 'recordRetainedControlOperation' | 'updateRetainedControlOperation' | 'getRetainedControlOperation' | 'getRetainedRun'>
}): void {

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
      if (deps.retainedStore?.getRetainedRun(id)?.owner === 'one-shot') {
        return streamChatDeltaEvents(
          c,
          (signal) => retainedChatDeltas(retained.runEvents(id, cursor.value, signal)),
          'cli-bridge',
        )
      }
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
      if (deps.retainedStore?.getRetainedRun(id)?.owner === 'one-shot') {
        return streamChatDeltaEvents(
          c,
          (signal) => retainedChatDeltas(retained.runEvents(id, cursor.value, signal)),
          'cli-bridge',
        )
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
      return exactCancellation(c, deps.runs, deps.retainedStore, id, parsedBody.request)
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
    if (!exactCancellationIdentifiersAreSafe(request.data)) {
      return {
        ok: false,
        message: 'cancellation identifiers must be bounded values without control characters',
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
  store: Pick<SessionStore, 'recordRetainedControlOperation' | 'updateRetainedControlOperation' | 'getRetainedControlOperation' | 'getRetainedRun'> | undefined,
  runId: string,
  request: AgentRunCancellationRequest,
): Promise<Response> {
  setExactRunIdentityHeaders(c, request.run)
  if (request.run.runId !== runId) {
    return invalidRequest(c, 'cancellation run id does not match the request path', 409)
  }
  if (!store) {
    return c.json(
      { error: { message: 'exact cancellation requires the canonical persisted run store', type: 'server_error' } },
      503,
    )
  }

  const existing = store.getRetainedControlOperation(request.operationId)
  if (existing) {
    if (
      existing.kind !== 'cancel'
      || existing.requestDigest !== request.requestDigest
      || existing.runId !== request.run.runId
      || existing.sessionId !== request.run.sessionId
    ) return exactCancellationConflict(c, request, existing.requestDigest)
    const settled = storedExactAcknowledgement(existing)
    if (settled) {
      const replayed = settled.status === 'unknown'
        ? settled
        : cancellationAcknowledgement({ ...settled, status: 'replayed' })
      return c.json(replayed, replayed.effect === 'cancel_requested' ? 202 : 200)
    }
  }

  const run = runs.get(runId)
  if (!run) {
    const admission = store.getRetainedRun(runId)
    if (!admission) {
      const unknown = cancellationAcknowledgement({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: 'unknown',
        effect: 'unknown',
        message: 'the canonical run store has no record of the run',
        retryable: false,
      })
      persistExactAcknowledgement(store, request, unknown)
      return c.json(unknown)
    }
    if (!admissionMatchesRequest(admission, request)) {
      return exactCancellationConflict(c, request, admission.requestDigest)
    }
    const durableSnapshot = recordSnapshot(admission.snapshot)
    const acknowledgement = durableSnapshot?.terminal
      ? cancellationAcknowledgement({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: 'accepted',
          effect: durableSnapshot.status === 'cancelled' ? 'cancelled' : 'not_live',
        })
      : cancellationAcknowledgement({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: 'unknown',
          effect: 'unknown',
          message: 'the run was not live after bridge restart; its cancellation effect is unknown',
          retryable: false,
        })
    persistExactAcknowledgement(store, request, acknowledgement)
    return c.json(acknowledgement)
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
  if (!existing) persistExactPending(store, request)
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
  persistExactAcknowledgement(store, request, acknowledgement)
  if (effect === 'cancel_requested') {
    c.header('Retry-After', '1')
    return c.json(acknowledgement, 202)
  }
  return c.json(acknowledgement)
}

function exactCancellationIdentifiersAreSafe(request: AgentRunCancellationRequest): boolean {
  return [
    request.operationId,
    request.run.runId,
    request.run.provider,
    request.run.environmentId,
    request.run.sessionId,
    request.run.executionId,
  ].every(isSafeWireIdentifier)
}

function exactCancellationConflict(
  c: Context,
  request: AgentRunCancellationRequest,
  existingRequestDigest: string,
): Response {
  const conflict = cancellationAcknowledgement({
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    run: request.run,
    status: 'conflict',
    effect: 'unknown',
    existingRequestDigest: existingRequestDigest as `sha256:${string}`,
  })
  return c.json(conflict, 409)
}

function storedExactAcknowledgement(
  operation: { acknowledgement: Record<string, unknown> },
): AgentRunCancellationAcknowledgement | null {
  if (operation.acknowledgement.phase === 'pending') return null
  return cancellationAcknowledgement(operation.acknowledgement as unknown as AgentRunCancellationAcknowledgement)
}

function persistExactPending(
  store: Pick<SessionStore, 'recordRetainedControlOperation'>,
  request: AgentRunCancellationRequest,
): void {
  store.recordRetainedControlOperation({
    operationId: request.operationId,
    callerId: 'cli-bridge.exact-cancellation',
    kind: 'cancel',
    runId: request.run.runId,
    sessionId: request.run.sessionId,
    requestDigest: request.requestDigest,
    acknowledgement: { phase: 'pending' },
  })
}

function persistExactAcknowledgement(
  store: Pick<SessionStore, 'recordRetainedControlOperation' | 'updateRetainedControlOperation'>,
  request: AgentRunCancellationRequest,
  acknowledgement: AgentRunCancellationAcknowledgement,
): void {
  const inserted = store.recordRetainedControlOperation({
    operationId: request.operationId,
    callerId: 'cli-bridge.exact-cancellation',
    kind: 'cancel',
    runId: request.run.runId,
    sessionId: request.run.sessionId,
    requestDigest: request.requestDigest,
    acknowledgement: JSON.parse(JSON.stringify(acknowledgement)) as Record<string, unknown>,
  })
  if (!inserted) {
    store.updateRetainedControlOperation(
      request.operationId,
      request.requestDigest,
      JSON.parse(JSON.stringify(acknowledgement)) as Record<string, unknown>,
    )
  }
}

function admissionMatchesRequest(
  admission: NonNullable<ReturnType<SessionStore['getRetainedRun']>>,
  request: AgentRunCancellationRequest,
): boolean {
  return admission.runId === request.run.runId
    && admission.requestDigest === request.run.requestDigest
    && admission.provider === request.run.provider
    && admission.environmentId === request.run.environmentId
    && admission.sessionId === request.run.sessionId
    && admission.executionId === request.run.executionId
}

function recordSnapshot(value: unknown): { terminal: boolean; status: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { terminal?: unknown; status?: unknown }
  return typeof candidate.terminal === 'boolean' && typeof candidate.status === 'string'
    ? { terminal: candidate.terminal, status: candidate.status }
    : null
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
  setRunIdentityHeaders(c, snapshot)
  c.header('X-Run-Status', snapshot.status)
  c.header('X-Run-State', snapshot.state)
  c.header('X-Run-Terminal', String(snapshot.terminal))
  c.header('X-Last-Event-Id', String(snapshot.lastSeq))
  if (snapshot.replay.expiresAt !== null) {
    c.header('X-Run-Replay-Expires-At', String(snapshot.replay.expiresAt))
  }
}

function setRetainedRunHeaders(c: Context, snapshot: DurableRetainedRunSnapshot, lastCanonicalSequence: number): void {
  setRunIdentityHeaders(c, snapshot)
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
