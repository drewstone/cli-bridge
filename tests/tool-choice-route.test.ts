/**
 * Route contract for the explicit text-inference request `tool_choice`:
 *
 *  - `'none'` reaches a backend that declares `textOnlyToolChoice` as
 *    `toolChoice: 'none'` on the ChatRequest;
 *  - a backend without that declaration is REFUSED with a message naming
 *    the gap — the route never accepts a control a harness ignores;
 *  - `'auto'` and an absent field are the native default: no `toolChoice`
 *    on the request, ordinary turns untouched. An absent `tools` list is
 *    never read as a request.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'

class CapturingBackend implements Backend {
  readonly name: string
  readonly textOnlyToolChoice?: boolean
  public last: ChatRequest | null = null
  public calls = 0
  constructor(name: string, textOnlyToolChoice?: boolean) {
    this.name = name
    this.textOnlyToolChoice = textOnlyToolChoice
  }
  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, _session: SessionRecord | null): AsyncIterable<ChatDelta> {
    this.calls += 1
    this.last = req
    yield { content: 'ok' }
    yield { finish_reason: 'stop' }
  }
}

describe('chat-completions route — tool_choice field', () => {
  let dir: string
  let sessions: SessionStore
  let runs: RunRegistry
  let plain: CapturingBackend
  let capable: CapturingBackend
  let app: Hono

  const post = async (body: unknown): Promise<Response> => await app.request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const base = (model: string): { model: string; messages: Array<{ role: string; content: string }> } => ({
    model,
    messages: [{ role: 'user', content: 'Write a textual plan.' }],
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-toolchoice-route-'))
    sessions = new SessionStore(dir)
    runs = new RunRegistry()
    plain = new CapturingBackend('plain')
    capable = new CapturingBackend('capable', true)
    const registry = new BackendRegistry().register(plain).register(capable)
    app = new Hono()
    mountChatCompletions(app, { registry, sessions, runs })
  })

  afterEach(async () => {
    await runs.shutdown()
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('delivers an explicit none to a backend that declares the control', async () => {
    const response = await post({ ...base('capable/m'), tool_choice: 'none' })
    expect(response.status).toBe(200)
    expect(capable.last?.toolChoice).toBe('none')
    expect(capable.calls).toBe(1)
  })

  it('refuses none on a backend without the control, naming the gap, before dispatch', async () => {
    const response = await post({ ...base('plain/m'), tool_choice: 'none' })
    expect(response.status).toBe(400)
    const error = ((await response.json()) as { error: { type: string; message: string } }).error
    expect(error.type).toBe('invalid_request_error')
    expect(error.message).toContain('cannot enforce tool_choice "none"')
    expect(error.message).toContain('refuses the field rather than ignoring it')
    expect(plain.calls).toBe(0)
  })

  it.each(['request', 'saved session'])('refuses none when the %s selects sandbox execution', async source => {
    const session = 'saved-sandbox'
    const execution = { kind: 'sandbox' }
    if (source === 'saved session') {
      sessions.upsert({ externalId: session, backend: 'capable', internalId: 'native',
        metadata: { model: 'capable/m', execution } })
    }
    const response = await post({
      ...base('capable/m'),
      tool_choice: 'none',
      ...(source === 'saved session' ? { session_id: session } : { execution }),
    })
    expect(response.status).toBe(400)
    const error = ((await response.json()) as { error: { message: string } }).error
    expect(error.message).toContain('through sandbox execution')
    expect(error.message).toContain('would run with ambient action tools')
    expect(capable.calls).toBe(0)
  })

  it('treats auto as the native default: no toolChoice reaches the backend', async () => {
    const response = await post({ ...base('capable/m'), tool_choice: 'auto' })
    expect(response.status).toBe(200)
    expect(capable.last?.toolChoice).toBeUndefined()
    expect(capable.last && 'tool_choice' in capable.last).toBe(false)
  })

  it('keeps an ordinary request without the field byte-equivalent: no toolChoice', async () => {
    const response = await post(base('capable/m'))
    expect(response.status).toBe(200)
    expect(capable.last?.toolChoice).toBeUndefined()
  })

  it('never reads an absent tools list as a request', async () => {
    const response = await post({ ...base('capable/m'), tools: [] })
    expect(response.status).toBe(200)
    expect(capable.last?.toolChoice).toBeUndefined()
  })

  it('refuses every other spelling at parse instead of accepting and ignoring it', async () => {
    for (const value of ['required', 'no_filters', { type: 'function', function: { name: 'bash' } }]) {
      const response = await post({ ...base('capable/m'), tool_choice: value })
      expect(response.status, `tool_choice ${JSON.stringify(value)}`).toBe(400)
      expect(capable.calls).toBe(0)
    }
  })
})
