/**
 * POST /images/generate — proxy to OpenAI's images API.
 *
 * Generic image-gen endpoint for every cli-bridge consumer. physim's
 * use case is the canonical one — render a CAD output overlaid on the
 * user's site photo, or visualize a proposed solution before fabrication —
 * but the route makes no project-specific assumptions.
 *
 * Model choice: `gpt-image-1` (released by OpenAI Apr 2025). The model
 * supports editing mode (reference image + prompt) which is what the
 * "imagine the proposed coop in your yard" workflow needs. We proxy
 * instead of self-hosting because (a) no GPU on the bridge host,
 * (b) gpt-image-1 quality is currently best-in-class for "edit this
 * real photo with a structured prompt", (c) the proxy contract is the
 * same regardless of which backend we eventually swap in (Flux,
 * Stable Diffusion 3.5, …). Swap is a single-file change in this route.
 *
 * Implementation notes:
 *   - API key from OPENAI_API_KEY env. Fail-fast with a structured
 *     {ok:false} body when missing — no upstream call attempted.
 *   - When `referenceImage` is present, switch to `/v1/images/edits`
 *     with multipart form-data. Otherwise hit `/v1/images/generations`
 *     with JSON.
 *   - 60s wall-clock timeout (AbortController). Distinct from the
 *     bridge's own request timeout — covers slow upstream.
 *   - Never log the prompt: it can contain user-pasted secrets/PII. We
 *     log only metadata (model, size, n, durationMs, error type) on
 *     failure.
 *   - n is capped at 4 (matches OpenAI's per-request limit on
 *     gpt-image-1 as of 2026-05).
 */

import type { Context, Hono } from 'hono'
import { z } from 'zod'

const DEFAULT_MODEL = 'gpt-image-1'
const DEFAULT_SIZE = '1024x1024' as const
const DEFAULT_QUALITY = 'high' as const
const DEFAULT_N = 1
const MAX_N = 4
const TIMEOUT_MS = 60_000
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

const imagesRequestSchema = z.object({
  model: z.string().min(1).optional(),
  prompt: z.string().min(1, 'prompt must be a non-empty string'),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']).optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
  n: z.number().int().positive().max(MAX_N).optional(),
  referenceImage: z
    .object({
      mediaType: z.string().min(1),
      base64: z.string().min(1),
    })
    .optional(),
})

interface SuccessBody {
  ok: true
  images: Array<{ base64: string; mediaType: 'image/png' }>
  model: string
  durationMs: number
}

interface FailureBody {
  ok: false
  error: string
  durationMs: number
}

export function mountImagesGenerate(app: Hono): void {
  app.post('/images/generate', async (c) => {
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
            message: 'invalid images request',
            type: 'invalid_request_error',
            details: parsed.error.flatten(),
          },
        },
        422,
      )
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      return c.json<FailureBody>(
        { ok: false, error: 'OPENAI_API_KEY unset', durationMs: Date.now() - startedAt },
        200,
      )
    }

    const model = parsed.data.model ?? DEFAULT_MODEL
    const size = parsed.data.size ?? DEFAULT_SIZE
    const quality = parsed.data.quality ?? DEFAULT_QUALITY
    const n = parsed.data.n ?? DEFAULT_N

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    // Propagate client disconnect to the upstream call.
    c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const upstream = parsed.data.referenceImage
        ? await callImagesEdits({
            apiKey,
            model,
            prompt: parsed.data.prompt,
            size,
            quality,
            n,
            reference: parsed.data.referenceImage,
            signal: controller.signal,
          })
        : await callImagesGenerations({
            apiKey,
            model,
            prompt: parsed.data.prompt,
            size,
            quality,
            n,
            signal: controller.signal,
          })

      if (upstream.kind === 'error') {
        // Log type, not prompt.
        console.error('[cli-bridge] images upstream failed', {
          model,
          size,
          n,
          status: upstream.status,
          durationMs: Date.now() - startedAt,
        })
        return c.json<FailureBody>(
          { ok: false, error: upstream.message, durationMs: Date.now() - startedAt },
          200,
        )
      }

      const body: SuccessBody = {
        ok: true,
        images: upstream.images,
        model,
        durationMs: Date.now() - startedAt,
      }
      return c.json(body)
    } catch (err) {
      const aborted = controller.signal.aborted
      const message = aborted
        ? `images request aborted after ${Date.now() - startedAt}ms`
        : err instanceof Error
          ? err.message
          : String(err)
      console.error('[cli-bridge] images handler error', {
        model,
        durationMs: Date.now() - startedAt,
        aborted,
      })
      return errorResponse(c, message, Date.now() - startedAt)
    } finally {
      clearTimeout(timer)
    }
  })
}

interface CallArgs {
  apiKey: string
  model: string
  prompt: string
  size: string
  quality: string
  n: number
  signal: AbortSignal
}

interface CallEditArgs extends CallArgs {
  reference: { mediaType: string; base64: string }
}

type UpstreamResult =
  | { kind: 'ok'; images: Array<{ base64: string; mediaType: 'image/png' }> }
  | { kind: 'error'; status: number; message: string }

async function callImagesGenerations(args: CallArgs): Promise<UpstreamResult> {
  const res = await fetch(`${OPENAI_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      prompt: args.prompt,
      size: args.size,
      quality: args.quality,
      n: args.n,
    }),
    signal: args.signal,
  })
  return parseImagesResponse(res)
}

async function callImagesEdits(args: CallEditArgs): Promise<UpstreamResult> {
  const form = new FormData()
  form.append('model', args.model)
  form.append('prompt', args.prompt)
  form.append('size', args.size)
  form.append('quality', args.quality)
  form.append('n', String(args.n))

  const refBytes = Buffer.from(args.reference.base64, 'base64')
  const ext = mediaTypeToExt(args.reference.mediaType)
  const blob = new Blob([refBytes], { type: args.reference.mediaType })
  form.append('image', blob, `reference.${ext}`)

  const res = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form,
    signal: args.signal,
  })
  return parseImagesResponse(res)
}

async function parseImagesResponse(res: Response): Promise<UpstreamResult> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      kind: 'error',
      status: res.status,
      message: `openai images ${res.status}: ${truncate(text, 500)}`,
    }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return {
      kind: 'error',
      status: res.status,
      message: `openai images returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const data = (body as { data?: Array<{ b64_json?: string }> } | undefined)?.data
  if (!Array.isArray(data) || data.length === 0) {
    return {
      kind: 'error',
      status: res.status,
      message: 'openai images returned no data[]',
    }
  }
  const images: Array<{ base64: string; mediaType: 'image/png' }> = []
  for (const item of data) {
    if (typeof item.b64_json !== 'string' || item.b64_json.length === 0) {
      return {
        kind: 'error',
        status: res.status,
        message: 'openai images returned an item without b64_json',
      }
    }
    images.push({ base64: item.b64_json, mediaType: 'image/png' })
  }
  return { kind: 'ok', images }
}

function mediaTypeToExt(mediaType: string): string {
  const lower = mediaType.toLowerCase()
  if (lower.includes('png')) return 'png'
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg'
  if (lower.includes('webp')) return 'webp'
  // OpenAI's edits endpoint accepts png/jpg/webp; fall back to png and
  // let upstream complain if the bytes don't match.
  return 'png'
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

function errorResponse(c: Context, message: string, durationMs: number): Response {
  const body: FailureBody = { ok: false, error: message, durationMs }
  return c.json(body, 500)
}
