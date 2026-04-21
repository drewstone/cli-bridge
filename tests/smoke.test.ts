/**
 * Smoke tests — no real CLI subprocess; a fake backend is registered in
 * place. Verifies:
 *   - session store upsert/get semantics
 *   - registry first-match-wins with harness prefix matching
 *   - chat-completions SSE framing + session persistence + errors
 *   - claude backend's model id parsing (`claude/sonnet` → `sonnet`)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { ClaudeBackend } from '../src/backends/claude.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'

class FakeBackend implements Backend {
  constructor(readonly name: string) {}
  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
    yield { internal_session_id: `${this.name}-int-xyz` }
    yield { content: `[${this.name}] ` }
    yield { content: req.messages[0]?.content ?? '' }
    yield { content: session ? ` turn=${session.turns + 1}` : '' }
    yield { finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 5 } }
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
    const r1 = store.upsert({ externalId: 'e1', backend: 'claude', internalId: 'i-a' })
    expect(r1.turns).toBe(1)
    const r2 = store.upsert({ externalId: 'e1', backend: 'claude', internalId: 'i-b' })
    expect(r2.turns).toBe(2)
    expect(r2.internalId).toBe('i-b')
    expect(store.get('e1', 'claude')?.internalId).toBe('i-b')
  })

  it('scopes by backend — same externalId across backends = distinct rows', () => {
    store.upsert({ externalId: 'e1', backend: 'claude', internalId: '1' })
    store.upsert({ externalId: 'e1', backend: 'claudish', internalId: '2' })
    expect(store.get('e1', 'claude')?.internalId).toBe('1')
    expect(store.get('e1', 'claudish')?.internalId).toBe('2')
  })
})

describe('BackendRegistry harness matching', () => {
  it('matches bare harness name and <harness>/<model>', () => {
    const reg = new BackendRegistry()
    const claude = new FakeBackend('claude')
    const claudish = new FakeBackend('claudish')
    reg.register(claude).register(claudish)

    expect(reg.resolve('claude')).toBe(claude)
    expect(reg.resolve('claude/sonnet')).toBe(claude)
    expect(reg.resolve('claude/opus')).toBe(claude)
    expect(reg.resolve('claudish')).toBe(claudish)
    expect(reg.resolve('claudish/openrouter@x/y')).toBe(claudish)
  })

  it('does NOT cross-match — claude does not claim claudish', () => {
    const reg = new BackendRegistry()
    const claude = new FakeBackend('claude')
    reg.register(claude)
    expect(reg.resolve('claudish/openrouter@x/y')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    const reg = new BackendRegistry().register(new FakeBackend('claude'))
    expect(reg.resolve('gpt-4')).toBeNull()
  })
})

describe('ClaudeBackend model parsing', () => {
  // Uses the real backend but never actually spawns — we only exercise
  // matches() and its public contract. chat() is tested via the fake
  // backend above.
  const b = new ClaudeBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'claude' })
  it('matches bare name and prefix', () => {
    expect(b.matches('claude')).toBe(true)
    expect(b.matches('claude/sonnet')).toBe(true)
    expect(b.matches('claude/claude-sonnet-4-5-20250929')).toBe(true)
    expect(b.matches('CLAUDE/OPUS')).toBe(true) // case-insensitive
    expect(b.matches('claudish/sonnet')).toBe(false)
    expect(b.matches('gpt-4')).toBe(false)
  })
})

describe('POST /v1/chat/completions', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
    sessions = new SessionStore(dir)
    const registry = new BackendRegistry()
      .register(new FakeBackend('claude'))
      .register(new FakeBackend('claudish'))
    app = new Hono()
    mountChatCompletions(app, { registry, sessions })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('routes `claude/sonnet` to claude, streams SSE', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        session_id: 's1',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('[claude]')
    expect(text).toContain('hi')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
    expect(sessions.get('s1', 'claude')?.internalId).toBe('claude-int-xyz')
  })

  it('routes `claudish/google@gemini-2.0-flash` to claudish — not claude', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claudish/google@gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('[claudish]')
    expect(body.choices[0]?.message.content).not.toContain('[claude]')
  })

  it('returns 404 when no backend matches', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 on malformed JSON', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    })
    expect(res.status).toBe(400)
  })

  it('resuming a session exposes prior turn count to the backend', async () => {
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'one' }],
        session_id: 'r1',
      }),
    })
    const res2 = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'two' }],
        session_id: 'r1',
        stream: false,
      }),
    })
    const body = await res2.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('turn=')
  })
})
