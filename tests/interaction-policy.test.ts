import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'

class PolicyBackend implements Backend {
  readonly name = 'policy-test'
  seen: ChatRequest | null = null

  matches(model: string): boolean { return model === 'policy-test' }
  health(): Promise<BackendHealth> { return Promise.resolve({ name: this.name, state: 'ready' }) }

  async *chat(req: ChatRequest, _session: SessionRecord | null, _signal: AbortSignal): AsyncIterable<ChatDelta> {
    this.seen = req
    yield { content: 'one-shot', finish_reason: 'stop' }
  }
}

describe('one-shot interaction policy', () => {
  let dir: string | null = null
  let store: SessionStore | null = null

  afterEach(() => {
    store?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    store = null
    dir = null
  })

  function setup(): { app: Hono; backend: PolicyBackend } {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-policy-'))
    store = new SessionStore(dir)
    const backend = new PolicyBackend()
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions: store,
      runs: new RunRegistry(),
    })
    return { app, backend }
  }

  it('keeps the default OpenAI one-shot request compatible', async () => {
    const { app, backend } = setup()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'policy-test', messages: [{ role: 'user', content: 'hello' }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe('one-shot')
    expect(backend.seen?.interaction_policy).toBeUndefined()
  })

  it('rejects unattended allow without the exact named profile policy', async () => {
    const { app } = setup()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'policy-test',
        messages: [{ role: 'user', content: 'hello' }],
        interaction_policy: 'unattended-allow',
      }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toMatch(/profile.*unattended-allow-v1/u)
  })

  it('denies an explicit interactive request on the one-shot route', async () => {
    const { app } = setup()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'policy-test',
        messages: [{ role: 'user', content: 'hello' }],
        interaction_policy: 'interactive',
      }),
    })
    expect(response.status).toBe(501)
    expect((await response.json() as { error: { type: string } }).error.type).toBe('capability_denied')
  })

  it('returns a profile digest receipt only for the named unattended policy', async () => {
    const { app, backend } = setup()
    const profile = { metadata: { cliBridge: { interactionPolicy: 'unattended-allow-v1' } }, prompt: { systemPrompt: 'exact' } }
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'policy-test',
        messages: [{ role: 'user', content: 'hello' }],
        agent_profile: profile,
        interaction_policy: 'unattended-allow',
      }),
    })
    expect(response.status).toBe(200)
    expect(backend.seen?.interaction_policy).toBe('unattended-allow')
    expect(backend.seen?.interaction_policy_receipt).toMatchObject({
      schema: 'cli-bridge.interaction-policy.v1',
      name: 'unattended-allow',
    })
    const body = await response.json() as { interaction_policy_receipt: Record<string, unknown> }
    expect(body.interaction_policy_receipt).toMatchObject({
      schema: 'cli-bridge.interaction-policy.v1',
      name: 'unattended-allow',
    })
  })
})
