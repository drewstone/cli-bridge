/**
 * POST /v1/chat/completions — OpenAI-compatible.
 *
 * Accepts the standard OpenAI chat request, plus an optional
 * `X-Session-Id` header (or `session_id` field in the body) for
 * session-resume across turns. If absent, starts a fresh session.
 */

import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { BackendRegistry } from '../backends/registry.js'
import type { SessionStore } from '../sessions/store.js'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { BackendError } from '../backends/types.js'
import { collectNonStreaming, deltaToOpenAIChunk, makeChunkMeta } from '../streaming/sse.js'

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  session_id: z.string().optional(),
  resume_id: z.string().optional(), // alias for session_id
  metadata: z.record(z.unknown()).optional(),
})

export function mountChatCompletions(
  app: Hono,
  deps: { registry: BackendRegistry; sessions: SessionStore },
): void {
  app.post('/v1/chat/completions', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400)
    }

    const parsed = chatRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({
        error: {
          message: 'invalid chat request',
          type: 'invalid_request_error',
          details: parsed.error.flatten(),
        },
      }, 400)
    }

    // Session id resolution — accept several aliases so clients with
    // different conventions all work:
    //   body.session_id                (canonical)
    //   body.resume_id                 (alias)
    //   header X-Session-Id            (canonical)
    //   header X-Resume                (alias — ergonomic single-word form)
    //   header X-Conversation-Id       (alias — matches OpenAI Assistants vocab)
    const headerSession =
      c.req.header('x-session-id')
      ?? c.req.header('x-resume')
      ?? c.req.header('x-conversation-id')
      ?? undefined
    const bodySession = parsed.data.session_id
      ?? (parsed.data as Record<string, unknown>).resume_id as string | undefined

    const req: ChatRequest = {
      ...parsed.data,
      session_id: bodySession ?? headerSession,
    }

    const backend = deps.registry.resolve(req.model)
    if (!backend) {
      return c.json({
        error: {
          message: `no backend matches model "${req.model}". Check /health for registered backends.`,
          type: 'not_found_error',
        },
      }, 404)
    }

    const session = req.session_id
      ? deps.sessions.get(req.session_id, backend.name)
      : null

    const ac = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })

    const source = backend.chat(req, session, ac.signal)

    // Persist internal session id as it flows in. Returns a new
    // AsyncIterable<ChatDelta> so the typed boundary stays clean.
    const wrapped: AsyncIterable<ChatDelta> = {
      [Symbol.asyncIterator]: async function* () {
        try {
          for await (const delta of source) {
            if (delta.internal_session_id && req.session_id) {
              deps.sessions.upsert({
                externalId: req.session_id,
                backend: backend.name,
                internalId: delta.internal_session_id,
                metadata: { model: req.model },
              })
            }
            yield delta
          }
        } catch (err) {
          // Surface backend errors as a terminal finish_reason='error'
          // rather than throwing — keeps the SSE stream well-formed.
          yield { finish_reason: 'error' } satisfies ChatDelta
          // Preserve the cause for observability: annotate once then end.
          console.error(`[cli-bridge] backend ${backend.name} failed:`, err)
        }
      },
    }

    if (req.stream === false) {
      try {
        const body = await collectNonStreaming(wrapped, req.model)
        return c.json(body)
      } catch (err) {
        return errorResponse(c, err)
      }
    }

    return streamSSE(c, async (stream) => {
      const meta = makeChunkMeta(req.model)
      try {
        for await (const delta of wrapped) {
          const chunk = deltaToOpenAIChunk(delta, meta)
          // deltaToOpenAIChunk returns a complete "data: …\n\n" line.
          // Strip the framing so streamSSE can re-add it.
          const payload = chunk.slice('data: '.length).replace(/\n\n$/, '')
          await stream.writeSSE({ data: payload })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({
          data: JSON.stringify({ error: { message, type: 'server_error' } }),
        })
      }
      await stream.writeSSE({ data: '[DONE]' })
    })
  })
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof BackendError) {
    // Hono's typed status gate treats 499 as an unofficial code; collapse
    // that one to 504 and keep the rest as documented codes.
    const status: 500 | 501 | 502 | 503 | 504 =
      err.code === 'not_configured' ? 501
      : err.code === 'cli_missing' ? 503
      : err.code === 'timeout' ? 504
      : err.code === 'aborted' ? 504
      : 502
    return c.json({ error: { message: err.message, type: err.code } }, status)
  }
  const message = err instanceof Error ? err.message : String(err)
  return c.json({ error: { message, type: 'server_error' } }, 500)
}
