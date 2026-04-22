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
import { KimiBackend } from '../src/backends/kimi.js'
import { CodexBackend } from '../src/backends/codex.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { ModeNotSupportedError } from '../src/modes.js'
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
    yield { content: ` mode=${req.mode ?? 'byob'}` }
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
  const b = new ClaudeBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'claude-code' })
  it('matches bare name and prefix', () => {
    expect(b.matches('claude-code')).toBe(true)
    expect(b.matches('claude-code/sonnet')).toBe(true)
    expect(b.matches('claude-code/claude-sonnet-4-5-20250929')).toBe(true)
    expect(b.matches('CLAUDE-CODE/OPUS')).toBe(true) // case-insensitive
    expect(b.matches('claudish/sonnet')).toBe(false)
    expect(b.matches('claude/sonnet')).toBe(false) // old name no longer claimed
    expect(b.matches('gpt-4')).toBe(false)
  })
})

describe('KimiBackend model parsing', () => {
  const b = new KimiBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'kimi-code' })
  it('matches bare name and prefix', () => {
    expect(b.matches('kimi-code')).toBe(true)
    expect(b.matches('kimi-code/kimi-for-coding')).toBe(true)
    expect(b.matches('kimi-code/kimi-k2-0905-preview')).toBe(true)
    expect(b.matches('KIMI-CODE/kimi-for-coding')).toBe(true) // case-insensitive
    expect(b.matches('kimi/kimi-for-coding')).toBe(false) // old name no longer claimed
    expect(b.matches('claude-code/sonnet')).toBe(false)
  })
})

describe('mode gating per backend (spawn-gated by /nonexistent bin)', () => {
  // These tests only verify the synchronous mode-gate inside chat() —
  // whether ModeNotSupportedError is thrown. The bin points at a
  // nonexistent path so spawn inevitably fails, but the mode gate fires
  // BEFORE spawn, so we can distinguish "rejected at the gate" (error
  // name === 'ModeNotSupportedError') from "rejected later at spawn"
  // (anything else).

  async function firstDeltaError(
    gen: AsyncIterable<unknown>,
  ): Promise<{ name: string; message: string } | null> {
    try {
      for await (const _ of gen) return null
      return null
    } catch (err) {
      if (err instanceof Error) return { name: err.name, message: err.message }
      throw err
    }
  }

  it('kimi-code: hosted-safe passes the mode gate (uses --plan)', async () => {
    const b = new KimiBackend({ bin: '/nonexistent', timeoutMs: 500, harness: 'kimi-code' })
    const err = await firstDeltaError(
      b.chat(
        { model: 'kimi-code', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-safe' },
        null,
        new AbortController().signal,
      ),
    )
    // mode gate passed → spawn fails later with BackendError (ENOENT)
    expect(err?.name).toBe('BackendError')
    expect(err?.message).toContain('spawn failed')
  })

  it('kimi-code: hosted-sandboxed is rejected at the gate with sandbox-launcher message', async () => {
    const b = new KimiBackend({ bin: '/nonexistent', timeoutMs: 500, harness: 'kimi-code' })
    await expect(async () => {
      for await (const _ of b.chat(
        { model: 'kimi-code', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-sandboxed' },
        null,
        new AbortController().signal,
      )) { /* drain */ }
    }).rejects.toThrowError(ModeNotSupportedError)
  })

  it('codex: hosted-safe passes the mode gate (uses --disable shell_tool + sandbox=read-only)', async () => {
    const b = new CodexBackend({ bin: '/nonexistent', timeoutMs: 500 })
    const err = await firstDeltaError(
      b.chat(
        { model: 'codex', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-safe' },
        null,
        new AbortController().signal,
      ),
    )
    expect(err?.name).toBe('BackendError')
    expect(err?.message).toContain('spawn failed')
  })

  it('codex: hosted-sandboxed is rejected at the gate with sandbox-launcher message', async () => {
    const b = new CodexBackend({ bin: '/nonexistent', timeoutMs: 500 })
    await expect(async () => {
      for await (const _ of b.chat(
        { model: 'codex', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-sandboxed' },
        null,
        new AbortController().signal,
      )) { /* drain */ }
    }).rejects.toThrowError(ModeNotSupportedError)
  })

  it('opencode: hosted-safe passes the mode gate (writes OPENCODE_CONFIG with deny-all)', async () => {
    const b = new OpencodeBackend({ bin: '/nonexistent', timeoutMs: 500 })
    const err = await firstDeltaError(
      b.chat(
        { model: 'opencode', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-safe' },
        null,
        new AbortController().signal,
      ),
    )
    expect(err?.name).toBe('BackendError')
    expect(err?.message).toContain('spawn failed')
  })

  it('opencode: hosted-sandboxed is rejected at the gate with sandbox-launcher message', async () => {
    const b = new OpencodeBackend({ bin: '/nonexistent', timeoutMs: 500 })
    await expect(async () => {
      for await (const _ of b.chat(
        { model: 'opencode', messages: [{ role: 'user', content: 'x' }], mode: 'hosted-sandboxed' },
        null,
        new AbortController().signal,
      )) { /* drain */ }
    }).rejects.toThrowError(ModeNotSupportedError)
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

  it('defaults mode to byob when no header or body field is set', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      }),
    })
    expect(res.headers.get('x-bridge-mode')).toBe('byob')
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('mode=byob')
  })

  it('reads mode from X-Bridge-Mode header', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-mode': 'hosted-safe' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      }),
    })
    expect(res.headers.get('x-bridge-mode')).toBe('hosted-safe')
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('mode=hosted-safe')
  })

  it('X-Sandbox: 1 maps to hosted-sandboxed mode', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sandbox': '1' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      }),
    })
    expect(res.headers.get('x-bridge-mode')).toBe('hosted-sandboxed')
  })

  it('body `mode` field takes precedence over headers', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-mode': 'hosted-safe' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        mode: 'byob',
      }),
    })
    expect(res.headers.get('x-bridge-mode')).toBe('byob')
  })

  it('returns 400 on invalid mode value', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        mode: 'yolo-mode',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 501 when backend rejects requested mode (ModeNotSupportedError)', async () => {
    // Kimi supports hosted-safe now but still rejects hosted-sandboxed
    // (sandbox launcher not yet wired). Spawn will never happen — the
    // mode guard fires inside chat() before subprocess start.
    const kimi = new KimiBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'kimi-code' })
    const registry = new BackendRegistry().register(kimi)
    const appLocal = new Hono()
    mountChatCompletions(appLocal, { registry, sessions })

    const res = await appLocal.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-code/kimi-for-coding',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        mode: 'hosted-sandboxed',
      }),
    })
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mode_not_supported')
    expect(body.error.message).toContain('kimi-code')
    expect(body.error.message).toContain('sandbox launcher')
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
