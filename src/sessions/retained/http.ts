/** HTTP bindings for the retained-session service. */

import { streamSSE } from 'hono/streaming'
import type { Context, Hono } from 'hono'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { BackendError } from '../../backends/types.js'
import { ExecutorSaturatedError } from '../../executors/types.js'
import { setExactRunIdentityHeaders } from '../../runs/headers.js'
import { retainedCancellationAcknowledgement } from './control-acknowledgement.js'
import { RETAINED_MAX_HTTP_BODY_BYTES } from './schema.js'
import { RetainedSessionError } from './types.js'
import type { RetainedSessionService } from '../retained.js'

export function mountRetainedSessions(
  app: Hono,
  service: RetainedSessionService,
  options: { includeSessionList?: boolean; includeRunEvents?: boolean } = {},
): void {
  app.get('/v1/capabilities', async (c) => {
    const model = c.req.query('model')
    if (!model) {
      return c.json({ error: { message: 'model query parameter is required', type: 'invalid_request_error' } }, 400)
    }
    try {
      return c.json(await service.capabilities(model, c.req.raw.signal))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions', async (c) => {
    try {
      const body = await readBoundedJson(c.req.raw)
      return c.json(await service.create(service.parseCreate(body), c.req.raw.signal), 201)
    } catch (error) {
      return retainedError(c, error)
    }
  })

  if (options.includeSessionList !== false) {
    app.get('/v1/sessions', (c) => {
      const limit = parseLimit(c.req.query('limit'))
      return c.json({ object: 'list', data: service.list(limit) })
    })
  }

  app.get('/v1/sessions/:id', (c) => {
    try {
      return c.json(service.get(c.req.param('id')))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/turns', async (c) => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await readBoundedJson(c.req.raw)), {
        signal: c.req.raw.signal,
      })
      return c.json(
        { session: service.get(c.req.param('id')), run: result.run, context_boundary: result.contextBoundary },
        202,
      )
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/continue', async (c) => {
    try {
      const returnMode = c.req.query('return')
      if (returnMode !== undefined && returnMode !== 'admission') {
        throw new RetainedSessionError(
          'return must be admission when specified',
          400,
          'invalid_request_error',
        )
      }
      const input = service.parseNativeContinuation(await readBoundedJson(c.req.raw))
      const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
      const result = await service.continueNative(c.req.param('id'), input, {
        signal: c.req.raw.signal,
        callerId: caller,
        returnOnAdmission: returnMode === 'admission',
      })
      if (result.status === 202) {
        setExactRunIdentityHeaders(c, result.outcome.controlRef)
        c.header('Location', `/v1/runs/${encodeURIComponent(result.outcome.controlRef.runId)}`)
      }
      return c.json(result.outcome, result.status)
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/input', async (c) => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await readBoundedJson(c.req.raw)), {
        queue: true,
        signal: c.req.raw.signal,
      })
      return c.json(
        { session: service.get(c.req.param('id')), run: result.run, context_boundary: result.contextBoundary },
        202,
      )
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.get('/v1/sessions/:id/events', async (c) => {
    const cursor = parseCursor(c.req.header('last-event-id') ?? c.req.query('cursor'))
    if (!cursor.ok) return c.json({ error: { message: cursor.message, type: 'invalid_replay_cursor' } }, 400)
    try {
      service.assertReplayCursor(c.req.param('id'), cursor.value)
    } catch (error) {
      return retainedError(c, error)
    }
    const controller = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort())
      try {
        for await (const item of service.eventsForSession(c.req.param('id'), cursor.value, controller.signal)) {
          await stream.writeSSE({
            id: item.envelope.cursor,
            event: item.envelope.event.type,
            data: JSON.stringify(item.envelope),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted)
          await stream.writeSSE({ event: 'error', data: JSON.stringify(errorBody(error)) })
      }
    })
  })

  if (options.includeRunEvents !== false) app.get('/v1/runs/:runId/events', async (c) => {
    const cursor = parseCursor(c.req.header('last-event-id') ?? c.req.query('cursor'))
    if (!cursor.ok) return c.json({ error: { message: cursor.message, type: 'invalid_replay_cursor' } }, 400)
    try {
      service.assertRunReplayCursor(c.req.param('runId'), cursor.value)
    } catch (error) {
      return retainedError(c, error)
    }
    const controller = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort())
      try {
        for await (const item of service.runEvents(c.req.param('runId'), cursor.value, controller.signal)) {
          await stream.writeSSE({
            id: String(item.envelope.sequence),
            event: item.envelope.event.type,
            data: JSON.stringify(item.envelope),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted)
          await stream.writeSSE({ event: 'error', data: JSON.stringify(errorBody(error)) })
      }
    })
  })

  app.get('/v1/sessions/:id/transcript', (c) => {
    try {
      return c.json(service.transcript(c.req.param('id')))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.get('/v1/sessions/:id/status', (c) => {
    try {
      return c.json(service.get(c.req.param('id')))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/steer', async (c) => {
    try {
      const body = service.parseSteer(await readBoundedJson(c.req.raw))
      const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
      const result = await service.steer(c.req.param('id'), body, caller)
      return c.json(result.acknowledgement, result.status as 200 | 400 | 404 | 409 | 501 | 502)
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/cancel', async (c) => {
    try {
      const wait = parseWaitMs(c.req.query('wait_ms'))
      if (!wait.ok) throw new RetainedSessionError(wait.message, 400, 'invalid_request_error')
      const raw = await readBoundedJson(c.req.raw)
      const body = service.parseCancel(raw)
      const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
      const result = await service.cancel(c.req.param('id'), wait.value, body, caller)
      return c.json(
        retainedCancellationAcknowledgement(body, result.acknowledgement),
        result.status as 200 | 400 | 404 | 409 | 501 | 502,
      )
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/detach', (c) => {
    try {
      return c.json({ detached: true, session: service.detach(c.req.param('id')) })
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/close', async (c) => {
    try {
      return c.json({ closed: true, session: await service.close(c.req.param('id')) })
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/runs/:runId/interactions/:interactionId/respond', async (c) => {
    let body: unknown
    try {
      body = await readBoundedJson(c.req.raw)
    } catch (error) {
      return retainedError(c, error)
    }
    const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
    const result = await service.respond(body, caller, {
      runId: c.req.param('runId'),
      interactionId: c.req.param('interactionId'),
    })
    return c.json(result.acknowledgement, result.status as 200 | 400 | 404 | 409 | 429 | 502)
  })
}

function parseLimit(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '50', 10)
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 500) : 50
}

/** Read one JSON request without allowing an unbounded body allocation. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > RETAINED_MAX_HTTP_BODY_BYTES) {
    throw new RetainedSessionError(
      `request body exceeds ${RETAINED_MAX_HTTP_BODY_BYTES} bytes`,
      413,
      'request_too_large',
    )
  }
  const body = request.body
  if (!body) return undefined
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > RETAINED_MAX_HTTP_BODY_BYTES) {
        await reader.cancel()
        throw new RetainedSessionError(
          `request body exceeds ${RETAINED_MAX_HTTP_BODY_BYTES} bytes`,
          413,
          'request_too_large',
        )
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (size === 0) return undefined
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new RetainedSessionError('request body must be valid JSON', 400, 'invalid_request_error')
  }
}

function parseCursor(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined || raw === '') return { ok: true, value: 0 }
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) return { ok: false, message: 'replay cursor must be a non-negative integer' }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, message: 'replay cursor is too large' }
}

function parseWaitMs(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: 0 }
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) return { ok: false, message: 'wait_ms must be a non-negative integer' }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value <= 30_000
    ? { ok: true, value }
    : { ok: false, message: 'wait_ms must be at most 30000' }
}

function retainedError(c: Context, error: unknown): Response {
  // A full executor is a capacity answer on this surface too. A retained turn
  // that never got a slot made no model call, so it must not wear a 500: a
  // caller reads 5xx as "the bridge broke" and stops, where the correct action
  // is to wait for a live session to end and try the same turn again.
  if (error instanceof ExecutorSaturatedError) {
    c.header('Retry-After', String(RETAINED_EXECUTOR_RETRY_AFTER_SECONDS))
    return c.json({
      error: {
        type: error.code,
        capacity: true,
        provider_dispatch: 'not_started',
        status: error.httpStatus,
        executor: error.executor,
        ...error.snapshot,
        retry_after_ms: RETAINED_EXECUTOR_RETRY_AFTER_SECONDS * 1000,
        message: error.message,
      },
    }, 429)
  }
  const body = errorBody(error)
  const status =
    error instanceof RetainedSessionError
      ? error.status
      : error instanceof BackendError
        ? error.code === 'capability_denied' || error.code === 'not_configured'
          ? 501
          : error.code === 'parse_error'
            ? 400
            : 502
        : 500
  return c.json({ error: body }, status as 400 | 408 | 409 | 413 | 429 | 500 | 501 | 502 | 503)
}

/** Same fixed backoff the chat surface and the admission gate advertise. */
const RETAINED_EXECUTOR_RETRY_AFTER_SECONDS = 5

function errorBody(error: unknown): { message: string; type: string } {
  if (error instanceof RetainedSessionError) return { message: error.message, type: error.code }
  if (error instanceof BackendError) return { message: error.message, type: error.code }
  if (error instanceof Error) return { message: error.message, type: 'server_error' }
  return { message: String(error), type: 'server_error' }
}
