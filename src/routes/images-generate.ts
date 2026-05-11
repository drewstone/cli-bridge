/**
 * POST /v1/images/generations — OpenAI-compatible image generation.
 *
 * Mounts on the OpenAI standard path so any client that already speaks
 * the OpenAI shape (`@tangle-network/tcloud`'s `imageGenerate`, the
 * OpenAI Node SDK with `baseURL` pointed here, raw curl from CI) Just
 * Works without a custom transport — same pattern as `/v1/chat/completions`.
 *
 * Dispatch:
 *   - If TANGLE_API_KEY is set → forward to the tangle-router
 *     (`router.tangle.tools/v1/images/generations`). Router accounts for
 *     credits, applies the operator's routing policy, and may rotate
 *     across upstream image providers (OpenAI, fal, replicate). This is
 *     the canonical path for production.
 *   - Else if OPENAI_API_KEY is set → forward directly to OpenAI.
 *     Local-dev fallback. Same wire shape, just no router in the middle.
 *   - Else → 503 with a clear message. We refuse to silently fake it.
 *
 * Default model: `gpt-image-2` (OpenAI's current image model — supersedes
 * the original `gpt-image-1` released Apr 2025). The constant is the
 * single point of override; bump it here when OpenAI renames again.
 *
 * Response shape is OpenAI's: `{ created, data: [{ b64_json, ... }] }`.
 * We deliberately do NOT wrap in our own `{ok, images}` envelope — that
 * would break tcloud client + every off-the-shelf OpenAI client.
 *
 * Image *editing* (multipart `/v1/images/edits` with a reference image)
 * is intentionally NOT proxied here yet — tcloud client doesn't surface
 * it as of v0.4.6, and exposing a custom shape just to support an edit
 * route would re-introduce the "intermediate shit" we just removed.
 * When the editing path lands in tcloud, add a sibling
 * `/v1/images/edits` route that mirrors the same router/OpenAI fork.
 *
 * Operational notes:
 *   - 60s wall-clock timeout via AbortController + client-disconnect
 *     propagation (same pattern as the chat-completions handler).
 *   - We never log the prompt body — it can carry pasted secrets/PII.
 *     Log only model / size / n / duration / upstream status code.
 *   - When the upstream returns a non-2xx, surface its status verbatim
 *     so OpenAI-style error handling on the caller side still works.
 */

import type { Context, Hono } from 'hono'
import { z } from 'zod'

const DEFAULT_MODEL = 'gpt-image-2'
const TIMEOUT_MS = 60_000

const TANGLE_ROUTER_BASE_URL = process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools/v1'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

// Permissive: forward whatever the OpenAI shape accepts. We validate the
// minimum (`prompt` non-empty, `n` capped) and pass everything else
// through verbatim so future params don't require code changes.
const imagesRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    prompt: z.string().min(1, 'prompt must be a non-empty string'),
    n: z.number().int().positive().max(10).optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    response_format: z.enum(['b64_json', 'url']).optional(),
    style: z.string().optional(),
    user: z.string().optional(),
    background: z.string().optional(),
    output_format: z.string().optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.string().optional(),
  })
  .passthrough()

export function mountImagesGenerate(app: Hono): void {
  app.post('/v1/images/generations', async (c) => {
    const startedAt = Date.now()

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
        400,
      )
    }

    const parsed = imagesRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: 'invalid /v1/images/generations request',
            type: 'invalid_request_error',
            details: parsed.error.flatten(),
          },
        },
        422,
      )
    }

    // The forwarded body keeps every passthrough field. Only the model
    // default is filled in here so that downstream sees a stable string.
    const body: Record<string, unknown> = { ...parsed.data }
    if (!body.model || typeof body.model !== 'string' || body.model.length === 0) {
      body.model = DEFAULT_MODEL
    }

    const dispatch = resolveDispatch()
    if (dispatch.kind === 'unavailable') {
      // Use 503 so callers can distinguish "no credential" from "upstream
      // error" — the OpenAI Node SDK surfaces this cleanly.
      return c.json(
        {
          error: {
            message: dispatch.message,
            type: 'service_unavailable',
            param: null,
            code: 'no_image_backend',
          },
        },
        503,
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const upstream = await fetch(`${dispatch.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dispatch.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // Read upstream body once. On 2xx we forward the JSON verbatim;
      // on non-2xx we surface the upstream message + status so OpenAI
      // SDK error handling keeps working.
      const text = await upstream.text()
      const elapsed = Date.now() - startedAt
      console.error('[cli-bridge] /v1/images/generations', {
        via: dispatch.kind,
        model: body.model,
        size: parsed.data.size,
        n: parsed.data.n,
        status: upstream.status,
        durationMs: elapsed,
      })

      if (!upstream.ok) {
        // Forward upstream's status + body verbatim if it's JSON-shaped,
        // else wrap in an OpenAI-shaped error envelope. Use a raw
        // Response here because Hono's typed `c.body(..., status)` shape
        // doesn't accept dynamic non-2xx codes cleanly.
        const wrapped = tryWrapError(text, upstream.status, dispatch.kind)
        return new Response(wrapped.body, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      const elapsed = Date.now() - startedAt
      const message = aborted
        ? `images request aborted after ${elapsed}ms (timeout ${TIMEOUT_MS}ms)`
        : err instanceof Error
          ? err.message
          : String(err)
      console.error('[cli-bridge] /v1/images/generations transport error', {
        via: dispatch.kind,
        durationMs: elapsed,
        aborted,
      })
      return errorResponse(c, message, aborted ? 504 : 502)
    } finally {
      clearTimeout(timer)
    }
  })
}

interface DispatchRouter { kind: 'router'; baseUrl: string; apiKey: string }
interface DispatchOpenAI { kind: 'openai'; baseUrl: string; apiKey: string }
interface DispatchUnavailable { kind: 'unavailable'; message: string }

function resolveDispatch(): DispatchRouter | DispatchOpenAI | DispatchUnavailable {
  // Router takes precedence — this is the canonical path. Bridge
  // operators add OPENAI_API_KEY only when they want local-dev
  // bypass of the router.
  const tangleKey = process.env.TANGLE_API_KEY?.trim()
  if (tangleKey) {
    return { kind: 'router', baseUrl: TANGLE_ROUTER_BASE_URL, apiKey: tangleKey }
  }
  const openAiKey = process.env.OPENAI_API_KEY?.trim()
  if (openAiKey) {
    return { kind: 'openai', baseUrl: OPENAI_BASE_URL, apiKey: openAiKey }
  }
  return {
    kind: 'unavailable',
    message:
      'no image-generation backend configured: set TANGLE_API_KEY (routes via router.tangle.tools) or OPENAI_API_KEY (direct OpenAI for local dev)',
  }
}

function tryWrapError(text: string, status: number, via: 'router' | 'openai'): { body: string } {
  // If upstream returned a JSON body, forward verbatim — the OpenAI SDK
  // expects `{error: {message, type, param, code}}` shape and tangle-router
  // mirrors that.
  try {
    JSON.parse(text)
    return { body: text }
  } catch {
    // Not JSON — wrap in an OpenAI-shaped envelope so consumers still
    // get a structured error.
    return {
      body: JSON.stringify({
        error: {
          message: `${via} upstream returned ${status} with non-JSON body: ${truncate(text, 400)}`,
          type: 'upstream_error',
          code: `${via}_${status}`,
        },
      }),
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

function errorResponse(c: Context, message: string, status: number): Response {
  return c.json(
    { error: { message, type: 'transport_error', code: 'bridge_image_transport' } },
    status as Parameters<typeof c.json>[1],
  )
}
