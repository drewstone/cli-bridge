/**
 * /v1/images/generations route tests.
 *
 * Schema + dispatch fast-fail run unconditionally. The real happy-path
 * round-trip only runs when either OPENAI_API_KEY or TANGLE_API_KEY is
 * set in the test env — same gating pattern as chat-completions.
 *
 * We assert the OpenAI response shape (`data: [{b64_json}]`) so that
 * downstream tcloud / OpenAI-SDK clients can hit this route by just
 * changing `baseURL` and Just Work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mountImagesGenerate } from '../src/routes/images-generate.js'

function makeApp(): Hono {
  const app = new Hono()
  mountImagesGenerate(app)
  return app
}

const HAS_OPENAI = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0
const HAS_TANGLE = typeof process.env.TANGLE_API_KEY === 'string' && process.env.TANGLE_API_KEY.length > 0
const HAS_BACKEND = HAS_OPENAI || HAS_TANGLE

describe('POST /v1/images/generations — schema + dispatch fast-fail', () => {
  let savedOpenAi: string | undefined
  let savedTangle: string | undefined
  beforeEach(() => {
    savedOpenAi = process.env.OPENAI_API_KEY
    savedTangle = process.env.TANGLE_API_KEY
  })
  afterEach(() => {
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedOpenAi
    if (savedTangle === undefined) delete process.env.TANGLE_API_KEY
    else process.env.TANGLE_API_KEY = savedTangle
  })

  it('returns 422 on missing prompt', async () => {
    const res = await makeApp().request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(422)
  })

  it('returns 422 on n > 10', async () => {
    const res = await makeApp().request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', n: 11 }),
    })
    expect(res.status).toBe(422)
  })

  it('returns 400 on malformed JSON', async () => {
    const res = await makeApp().request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 503 with OpenAI-shaped error when no backend configured', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.TANGLE_API_KEY
    const res = await makeApp().request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { message: string; type: string; code: string } }
    expect(body.error.type).toBe('service_unavailable')
    expect(body.error.code).toBe('no_image_backend')
    expect(body.error.message).toContain('TANGLE_API_KEY')
    expect(body.error.message).toContain('OPENAI_API_KEY')
  })

  it('accepts unknown OpenAI params via passthrough (schema does not reject)', async () => {
    // The schema is intentionally permissive: future OpenAI params should
    // forward without code change. We can't hit upstream without a key —
    // but we can assert it gets past Zod validation and *would* dispatch.
    delete process.env.OPENAI_API_KEY
    delete process.env.TANGLE_API_KEY
    const res = await makeApp().request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', some_future_param: 'foo' }),
    })
    expect(res.status).toBe(503) // got past Zod, fell at dispatch
  })
})

describe.skipIf(!HAS_BACKEND)('POST /v1/images/generations — real upstream happy path', () => {
  it(
    'returns OpenAI-shaped { data: [{ b64_json }] } for a trivial prompt',
    async () => {
      const res = await makeApp().request('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a small red square on a white background', size: '1024x1024', n: 1, quality: 'low' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        created?: number
        data?: Array<{ b64_json?: string }>
      }
      expect(Array.isArray(body.data)).toBe(true)
      expect((body.data ?? []).length).toBeGreaterThan(0)
      expect(typeof body.data?.[0]?.b64_json).toBe('string')
      expect((body.data?.[0]?.b64_json ?? '').length).toBeGreaterThan(100)
    },
    120_000,
  )
})
