/**
 * images-generate route tests.
 *
 * Schema + missing-key fast fail run unconditionally. The real OpenAI
 * round-trip ("happy path") only runs when OPENAI_API_KEY is set in
 * the test env — mirrors the chat-completions pattern of gating
 * subprocess/network heavy tests on env presence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mountImagesGenerate } from '../src/routes/images-generate.js'

function makeApp(): Hono {
  const app = new Hono()
  mountImagesGenerate(app)
  return app
}

const HAS_KEY = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0

describe('POST /images/generate — schema + key fast-fail', () => {
  let savedKey: string | undefined
  beforeEach(() => {
    savedKey = process.env.OPENAI_API_KEY
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  })

  it('returns 422 on missing prompt', async () => {
    const res = await makeApp().request('/images/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(422)
  })

  it('returns 422 on invalid size enum', async () => {
    const res = await makeApp().request('/images/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', size: '999x999' }),
    })
    expect(res.status).toBe(422)
  })

  it('returns 422 on n > 4', async () => {
    const res = await makeApp().request('/images/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', n: 5 }),
    })
    expect(res.status).toBe(422)
  })

  it('returns 400 on malformed JSON', async () => {
    const res = await makeApp().request('/images/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })

  it('returns ok:false with OPENAI_API_KEY unset error when key missing', async () => {
    delete process.env.OPENAI_API_KEY
    const res = await makeApp().request('/images/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error?: string; durationMs: number }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('OPENAI_API_KEY')
    expect(typeof body.durationMs).toBe('number')
  })
})

describe.skipIf(!HAS_KEY)('POST /images/generate — real OpenAI happy path', () => {
  it(
    'returns a base64 PNG for a trivial prompt',
    async () => {
      const res = await makeApp().request('/images/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a small red square on a white background', size: '1024x1024', n: 1, quality: 'low' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        images?: Array<{ base64: string; mediaType: string }>
        model: string
      }
      expect(body.ok).toBe(true)
      expect(body.images?.length).toBeGreaterThan(0)
      expect(body.images?.[0]?.mediaType).toBe('image/png')
      expect(body.images?.[0]?.base64.length).toBeGreaterThan(100)
      expect(body.model).toContain('gpt-image-1')
    },
    120_000,
  )
})
