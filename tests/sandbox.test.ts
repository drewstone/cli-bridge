/**
 * SandboxBackend tests — covers profile resolution (catalog + inline),
 * SSE-stream → ChatDelta translation, error pass-through, and the
 * routes/profiles + routes/models surface that exposes them.
 *
 * Uses a fake fetch impl that emits canned SSE bodies — no real
 * sandbox-api required.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AgentProfile } from '@tangle-network/sandbox'
import { SandboxBackend } from '../src/backends/sandbox.js'
import { createProfileCatalog } from '../src/profiles/loader.js'
import { mountProfiles } from '../src/routes/profiles.js'

const DUMMY_PROFILE: AgentProfile = {
  name: 'echo-agent',
  description: 'replies with the input verbatim',
  tags: ['test', 'echo'],
  prompt: { systemPrompt: 'You are a literal echo.' },
}

function sseBody(events: Array<{ type: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const lines: string[] = []
  for (const ev of events) {
    lines.push(`event: ${ev.type}`)
    lines.push(`data: ${JSON.stringify(ev.data)}`)
    lines.push('')
  }
  const body = lines.join('\n') + '\n'
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body))
      controller.close()
    },
  })
}

function fakeFetch(events: Array<{ type: string; data: unknown }>, status = 200): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(sseBody(events), {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch
}

function fakeFetchError(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('SandboxBackend matches()', () => {
  const b = new SandboxBackend({
    apiUrl: 'http://x',
    apiKey: 'k',
    timeoutMs: 1000,
    resolveProfile: () => null,
  })
  it('claims sandbox bare + sandbox/<id> + case-insensitive', () => {
    expect(b.matches('sandbox')).toBe(true)
    expect(b.matches('sandbox/echo')).toBe(true)
    expect(b.matches('SANDBOX/anything')).toBe(true)
    expect(b.matches('sandbox-fake')).toBe(false)
    expect(b.matches('claude-code/sonnet')).toBe(false)
  })
})

describe('SandboxBackend.chat — cataloged profile', () => {
  it('resolves catalog id, posts to /batch/run, yields content + finish', async () => {
    let captured: { url: string; body: string } | null = null
    const fetchSpy: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body ?? '') }
      return new Response(
        sseBody([
          { type: 'task.completed', data: {
            taskId: 'session-1', resultSummary: 'hello world',
            usage: { inputTokens: 5, outputTokens: 2 },
          } },
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as typeof fetch

    const b = new SandboxBackend({
      apiUrl: 'https://sandbox.test',
      apiKey: 'sk-test',
      timeoutMs: 60_000,
      fetchImpl: fetchSpy,
      resolveProfile: (id) => id === 'echo' ? DUMMY_PROFILE : null,
    })

    const deltas = await collect(b.chat(
      { model: 'sandbox/echo', messages: [{ role: 'user', content: 'say hello' }] },
      null,
      new AbortController().signal,
    ))

    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('https://sandbox.test/batch/run')
    const sent = JSON.parse(captured!.body)
    expect(sent.tasks[0].message).toBe('say hello')
    expect(sent.backend.profile).toEqual(DUMMY_PROFILE)
    expect(sent.backend.type).toBe('opencode')

    // expect: internal_session_id, content, finish_reason+usage
    expect(deltas).toHaveLength(3)
    expect(deltas[0]).toMatchObject({ internal_session_id: expect.any(String) })
    expect(deltas[1]).toMatchObject({ content: 'hello world' })
    expect(deltas[2]).toMatchObject({
      finish_reason: 'stop',
      usage: { input_tokens: 5, output_tokens: 2 },
    })
  })

  it('throws BackendError("parse_error") when profile id not in catalog', async () => {
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'k', timeoutMs: 1000,
      fetchImpl: fakeFetch([]),
      resolveProfile: () => null,
    })
    await expect(collect(b.chat(
      { model: 'sandbox/missing', messages: [{ role: 'user', content: 'x' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrow(/profile not found/)
  })
})

describe('SandboxBackend.chat — inline profile', () => {
  it('uses agent_profile body field when model id is bare `sandbox`', async () => {
    let captured = ''
    const fetchSpy: typeof fetch = (async (_url, init) => {
      captured = String(init?.body ?? '')
      return new Response(
        sseBody([{ type: 'task.completed', data: { resultSummary: 'ok' } }]),
        { status: 200 },
      )
    }) as typeof fetch
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'k', timeoutMs: 1000,
      fetchImpl: fetchSpy,
      resolveProfile: () => { throw new Error('catalog should NOT be consulted for inline') },
    })
    const inline: AgentProfile = { name: 'inline-test', description: 'inline', tools: { read: true } }
    await collect(b.chat(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { model: 'sandbox', messages: [{ role: 'user', content: 'go' }], agent_profile: inline } as any,
      null,
      new AbortController().signal,
    ))
    const sent = JSON.parse(captured)
    expect(sent.backend.profile).toEqual(inline)
  })

  it('errors when model is bare `sandbox` and no inline profile provided', async () => {
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'k', timeoutMs: 1000,
      fetchImpl: fakeFetch([]),
      resolveProfile: () => null,
    })
    await expect(collect(b.chat(
      { model: 'sandbox', messages: [{ role: 'user', content: 'x' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrow(/inline.*agent_profile/i)
  })
})

describe('SandboxBackend.chat — user-key forwarding (one-meter billing)', () => {
  it('uses metadata.forwardedAuthorization as the sandbox-api auth when present', async () => {
    let captured: { auth: string } | null = null
    const fetchSpy: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      captured = { auth: headers.get('authorization') ?? '' }
      return new Response(
        sseBody([{ type: 'task.completed', data: { resultSummary: 'ok' } }]),
        { status: 200 },
      )
    }) as typeof fetch
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'svc-fallback', timeoutMs: 1000,
      fetchImpl: fetchSpy,
      resolveProfile: () => DUMMY_PROFILE,
    })
    await collect(b.chat(
      {
        model: 'sandbox/echo',
        messages: [{ role: 'user', content: 'go' }],
        metadata: { forwardedAuthorization: 'Bearer sk-tan-USER123' },
      },
      null,
      new AbortController().signal,
    ))
    // The forwarded user key MUST reach sandbox-api so it bills the
    // end user via /v1/billing/deduct, not the bridge service account.
    expect(captured!.auth).toBe('Bearer sk-tan-USER123')
  })

  it('falls back to SANDBOX_API_KEY when no user key is forwarded', async () => {
    let captured: { auth: string } | null = null
    const fetchSpy: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      captured = { auth: headers.get('authorization') ?? '' }
      return new Response(
        sseBody([{ type: 'task.completed', data: { resultSummary: 'ok' } }]),
        { status: 200 },
      )
    }) as typeof fetch
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'svc-only', timeoutMs: 1000,
      fetchImpl: fetchSpy,
      resolveProfile: () => DUMMY_PROFILE,
    })
    await collect(b.chat(
      { model: 'sandbox/echo', messages: [{ role: 'user', content: 'go' }] },
      null,
      new AbortController().signal,
    ))
    expect(captured!.auth).toBe('Bearer svc-only')
  })
})

describe('SandboxBackend.chat — error pass-through', () => {
  it('throws BackendError("upstream") when sandbox-api returns non-2xx', async () => {
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'k', timeoutMs: 1000,
      fetchImpl: fakeFetchError(503, '{"error":"sandbox down"}'),
      resolveProfile: () => DUMMY_PROFILE,
    })
    await expect(collect(b.chat(
      { model: 'sandbox/echo', messages: [{ role: 'user', content: 'x' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrow(/sandbox-api 503/)
  })

  it('translates task.failed to finish_reason:error + throws', async () => {
    const b = new SandboxBackend({
      apiUrl: 'http://x', apiKey: 'k', timeoutMs: 1000,
      fetchImpl: fakeFetch([{ type: 'task.failed', data: { error: 'budget exhausted' } }]),
      resolveProfile: () => DUMMY_PROFILE,
    })
    await expect(collect(b.chat(
      { model: 'sandbox/echo', messages: [{ role: 'user', content: 'x' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrow(/budget exhausted/)
  })
})

describe('createProfileCatalog', () => {
  it('loads JSON files from dir, exposes list/get, ignores malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-profiles-'))
    try {
      writeFileSync(join(dir, 'echo.json'), JSON.stringify(DUMMY_PROFILE))
      writeFileSync(join(dir, 'broken.json'), '{ not json }')
      writeFileSync(join(dir, 'README.txt'), 'ignored — not .json')
      const catalog = createProfileCatalog(dir)
      expect(catalog.list().map((e) => e.id)).toEqual(['echo'])
      expect(catalog.get('echo')).toEqual(DUMMY_PROFILE)
      expect(catalog.get('missing')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty list when dir does not exist (no crash)', () => {
    const dir = join(tmpdir(), 'cli-bridge-profiles-nonexistent-' + Math.random())
    const catalog = createProfileCatalog(dir)
    expect(catalog.list()).toEqual([])
  })
})

describe('GET /v1/profiles', () => {
  it('lists cataloged profiles + returns profile body by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-profiles-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'echo.json'), JSON.stringify(DUMMY_PROFILE))
      const catalog = createProfileCatalog(dir)
      const app = new Hono()
      mountProfiles(app, { catalog })

      const list = await app.request('/v1/profiles')
      expect(list.status).toBe(200)
      const listJson = await list.json() as { data: Array<{ id: string; name?: string; tags?: string[] }> }
      expect(listJson.data).toEqual([{
        id: 'echo',
        name: 'echo-agent',
        description: DUMMY_PROFILE.description,
        tags: DUMMY_PROFILE.tags,
        loadedAt: expect.any(String),
      }])

      const detail = await app.request('/v1/profiles/echo')
      expect(detail.status).toBe(200)
      const detailJson = await detail.json() as { id: string; profile: AgentProfile }
      expect(detailJson.profile).toEqual(DUMMY_PROFILE)

      const missing = await app.request('/v1/profiles/missing')
      expect(missing.status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
