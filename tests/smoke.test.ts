/**
 * Smoke tests — no real CLI subprocess; mock ClaudeBackend-shaped
 * behavior via a fake backend registered in place. Verifies the core
 * contracts: routing by model prefix, SSE framing, session persistence.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { Hono } from 'hono'
import { mountChatCompletions } from '../src/routes/chat-completions.js'

class FakeBackend implements Backend {
  readonly name = 'fake'
  constructor(private readonly prefix: string) {}
  matches(model: string): boolean { return model.startsWith(this.prefix) }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
    yield { internal_session_id: 'fake-internal-123' }
    yield { content: 'hello ' }
    yield { content: req.messages[0]?.content ?? '' }
    yield { content: session ? ` (resumed turn ${session.turns + 1})` : '' }
    yield { finish_reason: 'stop', usage: { input_tokens: 5, output_tokens: 7 } }
  }
}

describe('SessionStore', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
    store = new SessionStore(dir)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts and retrieves by (externalId, backend)', () => {
    const r = store.upsert({ externalId: 'ext-1', backend: 'fake', internalId: 'int-a' })
    expect(r.turns).toBe(1)
    const again = store.upsert({ externalId: 'ext-1', backend: 'fake', internalId: 'int-b' })
    expect(again.turns).toBe(2)
    expect(again.internalId).toBe('int-b')
    const got = store.get('ext-1', 'fake')
    expect(got?.internalId).toBe('int-b')
  })

  it('scopes by backend — same externalId across backends = distinct rows', () => {
    store.upsert({ externalId: 'ext-1', backend: 'a', internalId: '1' })
    store.upsert({ externalId: 'ext-1', backend: 'b', internalId: '2' })
    expect(store.get('ext-1', 'a')?.internalId).toBe('1')
    expect(store.get('ext-1', 'b')?.internalId).toBe('2')
  })
})

describe('BackendRegistry', () => {
  it('first-match wins in registration order', () => {
    const reg = new BackendRegistry()
    const a = new FakeBackend('claude')
    const b = new FakeBackend('claude-')
    reg.register(a).register(b)
    expect(reg.resolve('claude-3-5-sonnet')).toBe(a)
  })

  it('returns null when no backend matches', () => {
    const reg = new BackendRegistry()
    reg.register(new FakeBackend('claude'))
    expect(reg.resolve('gpt-4')).toBeNull()
  })
})

describe('POST /v1/chat/completions', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
    sessions = new SessionStore(dir)
    const registry = new BackendRegistry().register(new FakeBackend('claude'))
    app = new Hono()
    mountChatCompletions(app, { registry, sessions })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('streams SSE chunks + [DONE] for a valid request', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'world' }],
        session_id: 'smoke-1',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('data:')
    expect(text).toContain('hello ')
    expect(text).toContain('world')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')

    // session should be persisted with the fake internal id
    const rec = sessions.get('smoke-1', 'fake')
    expect(rec?.internalId).toBe('fake-internal-123')
  })

  it('returns 404 when no backend matches', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 on malformed body', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('non-streaming mode returns a single JSON chat.completion', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus',
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('ping')
  })

  it('resuming a session exposes the prior turn count to the backend', async () => {
    // First call — starts at turn 1 (session.turns = 0 server-side, bumped to 1 on upsert)
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'one' }],
        session_id: 'resume-1',
      }),
    })

    // Second call — fake backend reports `(resumed turn N)` from session.turns
    const res2 = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'two' }],
        session_id: 'resume-1',
        stream: false,
      }),
    })
    const body = await res2.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('resumed turn')
  })
})
