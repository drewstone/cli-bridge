import type { Hono } from 'hono'
import { z } from 'zod'
import { UrlTranslateBackend, type UrlTranslateBackendOptions } from '../backends/url-translate.js'

const translateRequestSchema = z.object({
  url: z.string().url(),
  targetLanguage: z.string().min(2),
})

export function mountTranslate(
  app: Hono,
  deps: { backendOpts: UrlTranslateBackendOptions },
): void {
  const backend = new UrlTranslateBackend(deps.backendOpts)

  app.post('/translate', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400)
    }

    const parsed = translateRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({
        error: {
          message: 'invalid translate request — need { url, targetLanguage }',
          type: 'invalid_request_error',
          details: parsed.error.flatten(),
        },
      }, 400)
    }

    const ac = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })

    const req = {
      model: 'url-translate',
      messages: [{ role: 'user' as const, content: JSON.stringify(parsed.data) }],
    }

    try {
      let fullHtml = ''
      for await (const delta of backend.chat(req, null, ac.signal)) {
        if (delta.content) fullHtml += delta.content
      }
      c.header('Content-Type', 'text/html; charset=utf-8')
      return c.body(fullHtml)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('fetch failed') ? 502
        : message.includes('unsupported') ? 415
        : 500
      return c.json({ error: { message, type: 'translate_error' } }, status as 500)
    }
  })
}
