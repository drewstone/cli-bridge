/** HTTP bindings for the retained-session service. */

import { streamSSE } from 'hono/streaming'
import type { Context, Hono } from 'hono'
import {
  canonicalCandidateDigest,
  type AgentRunCancellationRequest,
  type AgentRunControlRef,
  type AgentEnvironmentCapabilities,
} from '@tangle-network/agent-interface'
import { BackendError } from '../../backends/types.js'
import type { RetainedEventRecord } from '../store.js'
import { retainedCancellationAcknowledgement } from './control-acknowledgement.js'
import {
  RetainedSessionError,
  type RetainedControlAcknowledgement,
  type RetainedSessionView,
  type RetainedTurnResult,
} from './types.js'
import type { RetainedCreateInput, RetainedTurnInput } from './schema.js'

/** The HTTP layer depends on the service contract, not the facade that composes it. */
export interface RetainedSessionHttpService {
  capabilities(model: string, signal?: AbortSignal): Promise<AgentEnvironmentCapabilities>
  parseCreate(value: unknown): RetainedCreateInput
  create(input: RetainedCreateInput, signal?: AbortSignal): Promise<RetainedSessionView>
  list(limit: number): RetainedSessionView[]
  get(id: string): RetainedSessionView
  parseTurn(value: unknown): RetainedTurnInput
  beginTurn(
    id: string,
    input: RetainedTurnInput,
    options?: { queue?: boolean; signal?: AbortSignal },
  ): Promise<RetainedTurnResult>
  assertReplayCursor(id: string, afterCursor: number): void
  eventsForSession(id: string, afterCursor: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord>
  assertRunReplayCursor(runId: string, afterSequence: number): void
  runEvents(runId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord>
  transcript(id: string): Record<string, unknown>
  parseSteer(value: unknown): { operationId: string; message: string; run: AgentRunControlRef }
  steer(
    id: string,
    input: { operationId: string; message: string; run: AgentRunControlRef },
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }>
  parseCancel(value: unknown): AgentRunCancellationRequest
  cancel(
    id: string,
    waitMs: number,
    request: AgentRunCancellationRequest,
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }>
  detach(id: string): RetainedSessionView
  close(id: string): Promise<RetainedSessionView>
  respond(
    value: unknown,
    callerId: string,
    routeBinding?: { runId: string; interactionId: string },
  ): Promise<{ acknowledgement: unknown; status: number }>
}

export function mountRetainedSessions(app: Hono, service: RetainedSessionHttpService): void {
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
      const body = await c.req.json()
      return c.json(await service.create(service.parseCreate(body), c.req.raw.signal), 201)
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.get('/v1/sessions', (c) => {
    const limit = parseLimit(c.req.query('limit'))
    return c.json({ object: 'list', data: service.list(limit) })
  })

  app.get('/v1/sessions/:id', (c) => {
    try {
      return c.json(service.get(c.req.param('id')))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions/:id/turns', async (c) => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await c.req.json()), {
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

  app.post('/v1/sessions/:id/input', async (c) => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await c.req.json()), {
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

  app.get('/v1/runs/:runId/events', async (c) => {
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
      const body = service.parseSteer(await c.req.json())
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
      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        raw = undefined
      }
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
      body = await c.req.json()
    } catch {
      return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400)
    }
    const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
    const result = await service.respond(body, caller, {
      runId: c.req.param('runId'),
      interactionId: c.req.param('interactionId'),
    })
    return c.json(result.acknowledgement, result.status as 200 | 400 | 404 | 409 | 502)
  })
}

function parseLimit(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '50', 10)
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 500) : 50
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
  return c.json({ error: body }, status as 400 | 408 | 409 | 429 | 500 | 501 | 502 | 503)
}

function errorBody(error: unknown): { message: string; type: string } {
  if (error instanceof RetainedSessionError) return { message: error.message, type: error.code }
  if (error instanceof BackendError) return { message: error.message, type: error.code }
  if (error instanceof Error) return { message: error.message, type: 'server_error' }
  return { message: String(error), type: 'server_error' }
}
