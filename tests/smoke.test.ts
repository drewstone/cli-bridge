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
import { KimiBackend, thinkingFlagForEffort } from '../src/backends/kimi.js'
import { CodexBackend, codexReasoningEffort } from '../src/backends/codex.js'
import { OpencodeBackend, opencodeVariantForEffort } from '../src/backends/opencode.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountSessions } from '../src/routes/sessions.js'
import { mountHealth } from '../src/routes/health.js'
import { mountModels } from '../src/routes/models.js'
import { contentToText } from '../src/backends/content.js'

class FakeBackend implements Backend {
  constructor(readonly name: string) {}
  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
    yield { internal_session_id: `${this.name}-int-xyz` }
    yield { content: `[${this.name}] ` }
    yield { content: contentToText(req.messages[0]?.content ?? '') }
    yield { content: ` mode=${req.mode ?? 'byob'}` }
    if (req.effort) yield { content: ` effort=${req.effort}` }
    yield { content: session ? ` turn=${session.turns + 1}` : '' }
    if (req.cwd) yield { content: ` cwd=${req.cwd}` }
    const prompt = (req.agent_profile as Record<string, unknown> | undefined)?.prompt as Record<string, unknown> | undefined
    if (typeof prompt?.systemPrompt === 'string') yield { content: ` profile=${prompt.systemPrompt}` }
    yield { finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 5 } }
  }
}

class DelayedBackend extends FakeBackend {
  constructor(name: string, private readonly delayMs: number) {
    super(name)
  }

  override async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    yield* super.chat(req, session)
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
    expect(b.matches('claude/sonnet')).toBe(false) // old prefix no longer claimed
    expect(b.matches('claude')).toBe(false) // bare old name no longer claimed
    expect(b.matches('gpt-4')).toBe(false)
  })
})

describe('KimiBackend model parsing', () => {
  const b = new KimiBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'kimi-code' })
  it('matches bare name and prefix', () => {
    expect(b.matches('kimi-code')).toBe(true)
    expect(b.matches('kimi-code/kimi-for-coding')).toBe(true)
    expect(b.matches('kimi-code/kimi-k2.6')).toBe(true)
    expect(b.matches('KIMI-CODE/kimi-for-coding')).toBe(true) // case-insensitive
    expect(b.matches('kimi/kimi-for-coding')).toBe(false) // old prefix no longer claimed
    expect(b.matches('kimi')).toBe(false) // bare old name no longer claimed
    expect(b.matches('claude-code/sonnet')).toBe(false)
  })

  it('omits --model for the K2.6 alias so the local default stays authoritative', () => {
    expect(b.resolveCliModel('kimi-code/kimi-k2.6')).toBeNull()
    expect(b.resolveCliModel('kimi-code')).toBeNull()
    expect(b.resolveCliModel('kimi-code/kimi-for-coding')).toBe('kimi-code/kimi-for-coding')
  })
})

describe('CodexBackend model parsing', () => {
  const b = new CodexBackend({ bin: '/nonexistent', timeoutMs: 1000 })
  it('matches bare name and prefix', () => {
    expect(b.matches('codex')).toBe(true)
    expect(b.matches('codex/gpt-5-codex')).toBe(true)
    expect(b.matches('CODEX/GPT-5')).toBe(true) // case-insensitive
    expect(b.matches('codex-fake')).toBe(false)
    expect(b.matches('claude-code/sonnet')).toBe(false)
  })
})

describe('OpencodeBackend model parsing', () => {
  const b = new OpencodeBackend({ bin: '/nonexistent', timeoutMs: 1000 })
  it('matches bare name and prefix', () => {
    expect(b.matches('opencode')).toBe(true)
    expect(b.matches('opencode/kimi-for-coding')).toBe(true)
    expect(b.matches('OPENCODE/anthropic/claude-sonnet')).toBe(true) // case-insensitive
    expect(b.matches('opencode-fake')).toBe(false)
    expect(b.matches('claude-code/sonnet')).toBe(false)
  })
})

describe('reasoning effort mapping', () => {
  it('maps opencode effort to provider variant', () => {
    expect(opencodeVariantForEffort('high')).toBe('high')
    expect(opencodeVariantForEffort('max')).toBe('max')
    expect(opencodeVariantForEffort(undefined)).toBeNull()
  })

  it('maps kimi effort to thinking flags', () => {
    expect(thinkingFlagForEffort('high')).toBe('--thinking')
    expect(thinkingFlagForEffort('max')).toBe('--thinking')
    expect(thinkingFlagForEffort('low')).toBe('--no-thinking')
    expect(thinkingFlagForEffort('minimal')).toBe('--no-thinking')
    expect(thinkingFlagForEffort('medium')).toBeNull()
    expect(thinkingFlagForEffort(undefined)).toBeNull()
  })

  it('maps Codex unsupported max-style effort to the strongest supported config', () => {
    expect(codexReasoningEffort('high')).toBe('high')
    expect(codexReasoningEffort('xhigh')).toBe('high')
    expect(codexReasoningEffort('max')).toBe('high')
    expect(codexReasoningEffort(undefined)).toBeNull()
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
        stream: true,
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

  it('keeps SSE alive while a backend is silent', async () => {
    const oldHeartbeat = process.env.BRIDGE_SSE_HEARTBEAT_MS
    process.env.BRIDGE_SSE_HEARTBEAT_MS = '10'
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
    sessions = new SessionStore(dir)
    app = new Hono()
    mountChatCompletions(
      app,
      { registry: new BackendRegistry().register(new DelayedBackend('slow', 40)), sessions },
    )
    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'slow/test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          session_id: 'slow-1',
        }),
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain(': connected')
      expect(text).toContain(': keepalive')
      expect(text).toContain('[slow]')
      expect(text).toContain('data: [DONE]')
    } finally {
      if (oldHeartbeat === undefined) delete process.env.BRIDGE_SSE_HEARTBEAT_MS
      else process.env.BRIDGE_SSE_HEARTBEAT_MS = oldHeartbeat
    }
  })

  it('defaults to non-streaming JSON like OpenAI chat completions', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('[claude]')
    expect(body.choices[0]?.message.content).toContain('hi')
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

  it('validates and forwards effort to the selected backend', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        effort: 'high',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('effort=high')
  })

  it('rejects invalid effort values before routing', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        effort: 'turbo',
      }),
    })
    expect(res.status).toBe(400)
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
    // Real KimiBackend currently rejects hosted-safe. Spawn will never
    // happen — the mode guard fires inside chat() before subprocess start.
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
        mode: 'hosted-safe',
      }),
    })
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mode_not_supported')
    expect(body.error.message).toContain('kimi-code')
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

  it('accepts OpenAI-shaped response_format: { type: json_object } on the wire', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        response_format: { type: 'json_object' },
      }),
    })
    expect(res.status).toBe(200)
  })

  it('accepts OpenAI-shaped response_format: { type: json_schema } on the wire', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      }),
    })
    expect(res.status).toBe(200)
  })

  it('persists cwd and agent_profile into resumed sessions', async () => {
    const profile = {
      name: 'local-coder',
      prompt: { systemPrompt: 'Be surgical.' },
      skills: ['critical-audit'],
    }
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'one' }],
        session_id: 'profile-1',
        cwd: '/tmp/demo',
        agent_profile: profile,
        stream: false,
      }),
    })
    const stored = sessions.get('profile-1', 'claude')
    expect(stored?.cwd).toBe('/tmp/demo')
    expect(stored?.metadata.agent_profile).toEqual(profile)

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'two' }],
        session_id: 'profile-1',
        stream: false,
      }),
    })
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toContain('cwd=/tmp/demo')
    expect(body.choices[0]?.message.content).toContain('profile=Be surgical.')
  })

  it('rejects response_format with an invalid type', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'bogus' },
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('ClaudeBackend JSON mode (buildArgs)', () => {
  const b = new ClaudeBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'claude-code' })
  const baseReq = {
    model: 'claude-code/sonnet',
    messages: [{ role: 'user' as const, content: 'summarize' }],
  }

  it('injects --append-system-prompt with the JSON directive when responseFormat is json_object', () => {
    const args = b.buildArgs(
      { ...baseReq, responseFormat: { type: 'json_object' } },
      null,
      'byob',
      'summarize',
    )
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toContain('single JSON object')
    expect(args[i + 1]).toContain('No markdown fences')
  })

  it('does NOT add --append-system-prompt when responseFormat is absent (regression guard)', () => {
    const args = b.buildArgs(baseReq, null, 'byob', 'summarize')
    expect(args).not.toContain('--append-system-prompt')
  })

  it('does NOT add --append-system-prompt when responseFormat is text', () => {
    const args = b.buildArgs(
      { ...baseReq, responseFormat: { type: 'text' } },
      null,
      'byob',
      'summarize',
    )
    expect(args).not.toContain('--append-system-prompt')
  })

  it('includes profile-derived system prompt in --append-system-prompt', () => {
    const args = b.buildArgs(
      { ...baseReq, agent_profile: { name: 'x', prompt: { systemPrompt: 'Be precise.' } } as any },
      null,
      'byob',
      'summarize',
    )
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toContain('Be precise.')
  })

  it('byob mode sets --permission-mode bypassPermissions (regression: without this every Write/Edit blocks)', () => {
    // 2026-04-24: gen44 claude smoke showed `The file write requests
    // need user approval` on every leaf. Root cause: claude CLI defaults
    // to interactive approval, which has no approver in the non-TTY
    // bridge pipeline. byob explicitly means "caller trusts the tools"
    // (see src/modes.ts), so bypass is correct.
    const args = b.buildArgs(baseReq, null, 'byob', 'summarize')
    const i = args.indexOf('--permission-mode')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('bypassPermissions')
    // And must NOT carry hosted-safe's plan/disallowed-tools baggage
    expect(args).not.toContain('plan')
    expect(args).not.toContain('--disallowed-tools')
  })

  it('hosted-safe mode still uses plan + disallowed-tools, not bypass', () => {
    const args = b.buildArgs(baseReq, null, 'hosted-safe', 'summarize')
    const i = args.indexOf('--permission-mode')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('plan')
    const d = args.indexOf('--disallowed-tools')
    expect(d).toBeGreaterThan(-1)
    expect(args[d + 1]).toContain('Bash')
    expect(args[d + 1]).toContain('Edit')
    expect(args[d + 1]).toContain('Write')
    expect(args).not.toContain('bypassPermissions')
  })
})

describe('KimiBackend JSON mode (buildPrompt)', () => {
  const b = new KimiBackend({ bin: '/nonexistent', timeoutMs: 1000, harness: 'kimi-code' })
  const baseReq = {
    model: 'kimi-code/kimi-for-coding',
    messages: [{ role: 'user' as const, content: 'summarize this repo' }],
  }

  it('prepends the JSON directive when responseFormat is json_object', () => {
    const prompt = b.buildPrompt({ ...baseReq, responseFormat: { type: 'json_object' } }, null)
    expect(prompt).toMatch(/^Respond with ONLY a single JSON object/)
    expect(prompt).toContain('No markdown fences')
    expect(prompt).toContain('summarize this repo')
  })

  it('does NOT prepend the directive when responseFormat is absent (regression guard)', () => {
    const prompt = b.buildPrompt(baseReq, null)
    expect(prompt).not.toContain('single JSON object')
    expect(prompt).toBe('summarize this repo')
  })

  it('does NOT prepend the directive when responseFormat is text', () => {
    const prompt = b.buildPrompt({ ...baseReq, responseFormat: { type: 'text' } }, null)
    expect(prompt).not.toContain('single JSON object')
  })

  it('prepends profile-derived context for local harnesses', () => {
    const prompt = b.buildPrompt(
      { ...baseReq, agent_profile: { name: 'x', prompt: { systemPrompt: 'Be precise.' } } as any },
      null,
    )
    expect(prompt).toContain('Be precise.')
    expect(prompt).toContain('summarize this repo')
  })
})

describe('GET /health', () => {
  it('reports ok when at least one backend is ready', async () => {
    const app = new Hono()
    const registry = new BackendRegistry().register(new FakeBackend('claude'))
    mountHealth(app, { registry })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; backends: Array<{ state: string }> }
    expect(body.status).toBe('ok')
    expect(body.backends[0]!.state).toBe('ready')
  })

  it('reports degraded (503) when no backends are ready', async () => {
    const app = new Hono()
    const registry = new BackendRegistry()
    mountHealth(app, { registry })
    const res = await app.request('/health')
    expect(res.status).toBe(503)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('degraded')
  })
})

describe('GET /v1/models', () => {
  it('lists models for ready backends only', async () => {
    const app = new Hono()
    const registry = new BackendRegistry().register(new FakeBackend('claude-code'))
    mountModels(app, { registry })
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; backend: string }> }
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.some((m) => m.backend === 'claude-code')).toBe(true)
  })

  it('advertises the benchmark matrix models for ready codex and opencode backends', async () => {
    const app = new Hono()
    const registry = new BackendRegistry()
      .register(new FakeBackend('codex'))
      .register(new FakeBackend('opencode'))
    mountModels(app, { registry })
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; backend: string }> }
    const ids = new Set(body.data.map((m) => m.id))
    expect(ids.has('codex/gpt-5.4')).toBe(true)
    expect(ids.has('codex/gpt-5.5')).toBe(true)
    expect(ids.has('opencode/zai-coding-plan/glm-5.1')).toBe(true)
    expect(ids.has('opencode/zai-coding-plan/glm-5-turbo')).toBe(true)
    expect(ids.has('opencode/deepseek/deepseek-v4-pro')).toBe(true)
    expect(ids.has('opencode/deepseek/deepseek-v4-flash')).toBe(true)
    expect(ids.has('opencode/kimi-for-coding/k2p6')).toBe(true)
    expect(ids.has('opencode/zai/glm-5.1')).toBe(false)
    expect(ids.has('opencode/anthropic/claude-sonnet-4-5')).toBe(false)
  })

  it('excludes models from unavailable backends', async () => {
    const app = new Hono()
    const registry = new BackendRegistry()
    mountModels(app, { registry })
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<unknown> }
    expect(body.data).toHaveLength(0)
  })
})

describe('GET /v1/sessions', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
    sessions = new SessionStore(dir)
    app = new Hono()
    mountSessions(app, { sessions })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists sessions with default limit', async () => {
    sessions.upsert({ externalId: 'a', backend: 'claude', internalId: 'i-a' })
    sessions.upsert({ externalId: 'b', backend: 'kimi', internalId: 'i-b' })
    const res = await app.request('/v1/sessions')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data).toHaveLength(2)
  })

  it('caps limit at 500', async () => {
    const res = await app.request('/v1/sessions?limit=9999')
    expect(res.status).toBe(200)
  })

  it('falls back to default 50 when limit is non-numeric (regression guard)', async () => {
    // Before the fix, ?limit=abc produced NaN which SQLite rejected.
    const res = await app.request('/v1/sessions?limit=abc')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('deletes a session by externalId', async () => {
    sessions.upsert({ externalId: 'del', backend: 'claude', internalId: 'i-del' })
    const res = await app.request('/v1/sessions/del', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { deleted: number }
    expect(body.deleted).toBe(1)
    expect(sessions.get('del', 'claude')).toBeNull()
  })

  it('deletes only the specified backend when backend query is given', async () => {
    sessions.upsert({ externalId: 'shared', backend: 'claude', internalId: 'i-c' })
    sessions.upsert({ externalId: 'shared', backend: 'kimi', internalId: 'i-k' })
    const res = await app.request('/v1/sessions/shared?backend=claude', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { deleted: number }
    expect(body.deleted).toBe(1)
    expect(sessions.get('shared', 'claude')).toBeNull()
    expect(sessions.get('shared', 'kimi')).not.toBeNull()
  })
})
