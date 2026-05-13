/**
 * cad-render route tests.
 *
 * Schema + handler behavior is exercised against the route mounted in
 * isolation (no full server boot). The "real openscad happy path" test
 * only runs when the openscad binary is on $PATH — opt-in via env or
 * presence-detect at module load. Mirrors the chat-completions smoke
 * test pattern.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { Hono } from 'hono'
import { mountCadRender } from '../src/routes/cad-render.js'

function hasOpenscad(): boolean {
  if (process.env.OPENSCAD_BIN_AVAILABLE === '1') return true
  try {
    execSync('command -v openscad', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const OPENSCAD_PRESENT = hasOpenscad()

function makeApp(): Hono {
  const app = new Hono()
  mountCadRender(app)
  return app
}

describe('POST /cad/render — schema + error path', () => {
  it('returns 422 on missing code', async () => {
    const res = await makeApp().request('/cad/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outputs: ['stl'] }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 422 on invalid outputs enum', async () => {
    const res = await makeApp().request('/cad/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'cube(1);', outputs: ['xyz'] }),
    })
    expect(res.status).toBe(422)
  })

  it('returns 400 on malformed JSON', async () => {
    const res = await makeApp().request('/cad/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })

  it('returns ok:false when openscad fails (missing binary path)', async () => {
    if (OPENSCAD_PRESENT) {
      // When openscad really is present, this assertion would not hold —
      // skip the negative-path branch in that environment.
      return
    }
    const res = await makeApp().request('/cad/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'cube(10);', outputs: ['stl'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error?: string; durationMs: number }
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(typeof body.durationMs).toBe('number')
  })
})

describe.skipIf(!OPENSCAD_PRESENT)('POST /cad/render — real openscad happy path', () => {
  // Modest timeout in case the underlying binary is slow (cold cache,
  // first-run shader compile). Real runs are typically <2s for a cube.
  const TIMEOUT = 30_000

  it(
    'renders a trivial cube to STL bytes',
    async () => {
      const res = await makeApp().request('/cad/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'cube(10);', outputs: ['stl'] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        artifacts?: { stl?: { bytes: number; base64: string } }
      }
      expect(body.ok).toBe(true)
      expect(body.artifacts?.stl?.bytes).toBeGreaterThan(0)
      expect(typeof body.artifacts?.stl?.base64).toBe('string')
    },
    TIMEOUT,
  )

  it(
    'renders a trivial cube to PNG bytes',
    async () => {
      const res = await makeApp().request('/cad/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 'cube(10);',
          outputs: ['png'],
          imageSize: [320, 240],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        artifacts?: { png?: { bytes: number; base64: string } }
        warnings?: string[]
      }
      // Headless hosts without GLX/EGL can't render PNG. The route now
      // soft-fails: STL is always returned (this request asked for png-
      // only so artifacts may be empty), and a warning naming the GL
      // issue is surfaced. Either way the response is ok=true.
      expect(body.ok).toBe(true)
      if (body.artifacts?.png) {
        expect(body.artifacts.png.bytes).toBeGreaterThan(0)
      } else {
        expect((body.warnings ?? []).some((w) => /png|GL|EGL|GLX/i.test(w))).toBe(true)
      }
    },
    TIMEOUT,
  )

  it(
    'soft-fails png while preserving the stl when host has no GL',
    async () => {
      // Combined request — STL must always succeed even when PNG can't
      // render on this host. This is the regression test for the
      // earlier behaviour that threw away a valid STL whenever PNG
      // failed.
      const res = await makeApp().request('/cad/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 'cube(10);',
          outputs: ['stl', 'png'],
          imageSize: [320, 240],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        artifacts?: { stl?: { bytes: number }; png?: { bytes: number } }
        warnings?: string[]
      }
      expect(body.ok).toBe(true)
      expect(body.artifacts?.stl?.bytes).toBeGreaterThan(0)
      // If PNG didn't render, the warning must explain why.
      if (!body.artifacts?.png) {
        expect((body.warnings ?? []).some((w) => /png/i.test(w))).toBe(true)
      }
    },
    TIMEOUT,
  )
})

afterAll(() => {
  // No global state to clean up — the route uses mkdtemp + finally
  // for per-request cleanup. Hook left here as a marker if we add
  // shared fixtures later.
})
