import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import type {
  Backend,
  BackendHealth,
  ChatDelta,
  ChatRequest,
} from '../src/backends/types.js'
import { loadConfig } from '../src/config.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../src/sessions/store.js'

class CapturingBackend implements Backend {
  readonly name = 'capture'
  readonly defaultExecutionTimeoutMs = 300_000
  request: ChatRequest | undefined

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  async *chat(
    request: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    this.request = request
    yield { content: 'done' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

class ProfileReceiptBackend extends CapturingBackend {
  override async *chat(
    request: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    this.request = request
    request.profile_materialization_receipt = testProfileReceipt(request.model, this.name)
    yield { content: 'done' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

class SilentProfileReceiptBackend extends CapturingBackend {
  override async *chat(
    request: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    this.request = request
    request.profile_materialization_receipt = testProfileReceipt(request.model, this.name)
  }
}

class DelegatedProfileReceiptBackend implements Backend {
  readonly name = 'sandbox'
  readonly defaultExecutionTimeoutMs = 0
  request: ChatRequest | undefined

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  async *chat(
    request: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    this.request = request
    request.profile_materialization_receipt = testProfileReceipt(request.model, this.name)
  }
}

function testProfileReceipt(
  model: string,
  harness: string,
): NonNullable<ChatRequest['profile_materialization_receipt']> {
  return {
    schema: 'cli-bridge.profile-materialization.v2',
    effectiveProfileDigest: `sha256:${'1'.repeat(64)}`,
    harness,
    provider: 'test-provider',
    model,
    reasoningEffort: { requested: null, applied: null },
    workspacePlanDigest: `sha256:${'2'.repeat(64)}`,
    files: [],
    unsupported: [],
  }
}

class BlockingBackend implements Backend {
  readonly name = 'blocking'
  signal: AbortSignal | undefined
  readonly started: Promise<void>
  private markStarted: (() => void) | undefined

  constructor() {
    this.started = new Promise(resolve => { this.markStarted = resolve })
  }

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  async *chat(
    _request: ChatRequest,
    _session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    this.signal = signal
    this.markStarted?.()
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}

function fixture(...backends: Backend[]): { app: Hono; runs: RunRegistry } {
  const runs = new RunRegistry()
  const app = new Hono()
  const registry = new BackendRegistry()
  for (const backend of backends) registry.register(backend)
  mountChatCompletions(app, {
    registry,
    sessions: {
      acquireExecution: async () => ({ release: () => {} }),
      get: () => null,
      upsert: (record: SessionRecord) => record,
    } as unknown as SessionStore,
    runs,
  })
  return { app, runs }
}

describe('caller-owned execution timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves a caller timeout larger than the backend default', async () => {
    const backend = new CapturingBackend()
    const response = await fixture(backend).app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture/test',
        messages: [{ role: 'user', content: 'complete the task' }],
        execution: { kind: 'host', timeoutMs: 14_400_000 },
      }),
    })

    expect(response.status).toBe(200)
    expect(backend.request?.execution).toEqual({ kind: 'host', timeoutMs: 14_400_000 })
  })

  it('uses an operator fallback only when the request omits a timeout', async () => {
    const backend = new CapturingBackend()
    const response = await fixture(backend).app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture/test',
        messages: [{ role: 'user', content: 'complete the task' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(backend.request?.execution).toEqual({ kind: 'host', timeoutMs: 300_000 })
  })

  it('preserves a profile acknowledgment across the operator-timeout request copy', async () => {
    const backend = new ProfileReceiptBackend()
    const response = await fixture(backend).app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture/test',
        messages: [{ role: 'user', content: 'complete the task' }],
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      profile_materialization: {
        schema: 'cli-bridge.profile-materialization.v2',
        model: 'capture/test',
      },
    })
  })

  it('preserves a profile acknowledgment when a materialized backend yields no deltas', async () => {
    const backend = new SilentProfileReceiptBackend()
    const response = await fixture(backend).app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture/test',
        messages: [{ role: 'user', content: 'complete the task' }],
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      profile_materialization: {
        schema: 'cli-bridge.profile-materialization.v2',
        model: 'capture/test',
      },
    })
  })

  it('preserves a profile acknowledgment across sandbox delegation and a silent backend', async () => {
    const requested = new CapturingBackend()
    const sandbox = new DelegatedProfileReceiptBackend()
    const response = await fixture(requested, sandbox).app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture/test',
        messages: [{ role: 'user', content: 'complete the task' }],
        agent_profile: { prompt: { systemPrompt: 'Use the exact profile.' } },
        execution: { kind: 'sandbox' },
      }),
    })

    expect(response.status).toBe(200)
    expect(requested.request).toBeUndefined()
    expect(sandbox.request?.metadata).toMatchObject({ sandboxBackendType: 'capture' })
    await expect(response.json()).resolves.toMatchObject({
      profile_materialization: {
        schema: 'cli-bridge.profile-materialization.v2',
        harness: 'sandbox',
        model: 'capture/test',
      },
    })
  })

  it('aborts at the requested deadline and reports a typed timeout without wall time', async () => {
    vi.useFakeTimers()
    const backend = new BlockingBackend()
    const { app } = fixture(backend)
    const pendingResponse = app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'blocking/test',
        messages: [{ role: 'user', content: 'wait' }],
        execution: { kind: 'host', timeoutMs: 25 },
      }),
    })

    await backend.started
    expect(backend.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(24)
    expect(backend.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const response = await pendingResponse
    expect(backend.signal?.aborted).toBe(true)
    expect(response.status).toBe(504)
    await expect(response.json()).resolves.toEqual({
      error: {
        message: 'blocking execution timed out after 25ms',
        type: 'timeout',
      },
    })
  })

  it.each([0, -1, 1.5, 2_147_483_648])(
    'rejects unsupported timeout %s before backend execution',
    async (timeoutMs) => {
      const backend = new CapturingBackend()
      const response = await fixture(backend).app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'capture/test',
          messages: [{ role: 'user', content: 'complete the task' }],
          execution: { kind: 'host', timeoutMs },
        }),
      })

      expect(response.status).toBe(400)
      expect(backend.request).toBeUndefined()
    },
  )

  it('has no silent process deadline when neither caller nor operator configures one', () => {
    const config = loadConfig({ HOME: '/home/test' })

    expect(config.cliTimeoutMsDefault).toBe(0)
    expect(config.claudeTimeoutMs).toBe(0)
    expect(config.codexTimeoutMs).toBe(0)
    expect(config.kimiTimeoutMs).toBe(0)
    expect(config.geminiTimeoutMs).toBe(0)
    expect(config.piTimeoutMs).toBe(0)
    expect(config.opencodeTimeoutMs).toBe(0)
    expect(config.sandboxTimeoutMs).toBe(0)
  })

  it.each([
    ['CLI_TIMEOUT_MS', '300000junk'],
    ['PI_TIMEOUT_MS', '-1'],
    ['OPENCODE_TIMEOUT_MS', '2147483648'],
  ])('rejects invalid operator fallback %s=%s at startup', (key, value) => {
    expect(() => loadConfig({ HOME: '/home/test', [key]: value })).toThrow(`invalid ${key}`)
  })
})
