/**
 * POST /v1/chat/completions — OpenAI-compatible.
 *
 * Accepts the standard OpenAI chat request, plus an optional
 * `X-Session-Id` header (or `session_id` field in the body) for
 * session-resume across turns. If absent, starts a fresh session.
 *
 * Non-native JSON mode: callers may pass
 * `response_format: { type: 'json_object' }` on the wire. CLI harnesses
 * (claude-code, kimi-code) have no native json-mode flag, so backends
 * honor the hint prompt-side — they inject a "reply with a single JSON
 * object, no prose, no fences" directive. Content may still need
 * markdown-fence stripping by the client; treat fence-stripping as a
 * belt-and-suspenders fallback.
 */

import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { BackendRegistry } from '../backends/registry.js'
import type { SessionStore } from '../sessions/store.js'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { BackendError } from '../backends/types.js'
import { parseMode, ModeNotSupportedError } from '../modes.js'
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
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  // OpenAI-compatible shape — wire is snake_case, TS is camelCase. We
  // translate to responseFormat when we build the ChatRequest below.
  response_format: z.object({
    type: z.enum(['text', 'json_object']),
  }).optional(),
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

    let mode
    try {
      mode = parseMode({
        body: parsed.data.mode,
        bridgeModeHeader: c.req.header('x-bridge-mode'),
        sandboxHeader: c.req.header('x-sandbox'),
      })
    } catch (err) {
      return c.json({
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'invalid_request_error',
        },
      }, 400)
    }

    // Forward the user's identity (when the upstream router supplied
    // it) into request metadata so backends like sandbox can re-use the
    // user's own auth when calling downstream services. This keeps
    // billing accountable to the actual user, not cli-bridge's service
    // identity. Header is `X-Tangle-Forwarded-Authorization` and is set
    // by tangle-router on bridge dispatch (sandbox path).
    const forwardedAuthz = c.req.header('x-tangle-forwarded-authorization')
    // Pull response_format off so it doesn't bleed through the spread
    // as an unknown extra field — we translate snake_case → camelCase
    // here to match the ChatRequest type.
    const { response_format, ...rest } = parsed.data
    const req: ChatRequest = {
      ...rest,
      session_id: bodySession ?? headerSession,
      mode,
      ...(response_format ? { responseFormat: response_format } : {}),
      metadata: {
        ...(parsed.data.metadata ?? {}),
        ...(forwardedAuthz ? { forwardedAuthorization: forwardedAuthz } : {}),
      },
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
    // Mode errors and BackendError('not_configured') re-throw so the
    // outer handler can return a real HTTP status — everything else
    // terminates the stream with finish_reason='error'.
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
          if (
            err instanceof ModeNotSupportedError
            || (err instanceof BackendError && err.code === 'not_configured')
          ) {
            throw err
          }
          yield { finish_reason: 'error' } satisfies ChatDelta
          console.error(`[cli-bridge] backend ${backend.name} failed:`, err)
        }
      },
    }

    // Surface mode in response headers so clients can confirm what actually ran.
    c.header('X-Bridge-Mode', req.mode ?? 'byob')

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
        const type = err instanceof ModeNotSupportedError
          ? 'mode_not_supported'
          : err instanceof BackendError
            ? err.code
            : 'server_error'
        const message = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({
          data: JSON.stringify({ error: { message, type } }),
        })
      }
      await stream.writeSSE({ data: '[DONE]' })
    })
  })
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ModeNotSupportedError) {
    return c.json({ error: { message: err.message, type: 'mode_not_supported' } }, 501)
  }
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
