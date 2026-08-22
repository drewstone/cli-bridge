/**
 * Executor saturation — a full box answers "capacity", not "failure".
 *
 * Measured 2026-08-22 on one bridge running two graph runs: 2 of 6 worker
 * spawns died on `host-executor: acquire timeout after 60000ms (in_flight=4/4)`
 * and the slots freed seconds later. The refusal reached the caller as a plain
 * error with no status, no capacity flag, and no proof that provider dispatch
 * had never started, so a retry loop had to sniff the message text.
 *
 * Coverage:
 *   1. The refusal is typed, carries the counts, and keeps the prose signature
 *      existing retry loops key on.
 *   2. The chat route answers 429 + `Retry-After` with the counts in the body.
 *   3. The body fits the 300-byte window a client reads it through, so its
 *      `provider_dispatch` survives the slice.
 *   4. A per-request acquire deadline is honoured and capped by the server max.
 *   5. `/health` reports the same counts a launcher gates admission on.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountHealth } from '../src/routes/health.js'
import { ExecutorSaturatedError } from '../src/executors/types.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A backend whose only behaviour is the refusal the host semaphore raises. */
class SaturatedBackend implements Backend {
  readonly name = 'saturated'
  lastRequest: ChatRequest | null = null
  matches(model: string): boolean {
    return model === 'saturated' || model.startsWith('saturated/')
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.lastRequest = req
    throw new ExecutorSaturatedError(
      'host',
      { in_flight: 4, max: 4, queued: 1, deadline_ms: req.acquireDeadlineMs ?? 60_000 },
      `host-executor: acquire timeout after ${req.acquireDeadlineMs ?? 60_000}ms (in_flight=4/4, queued=1)`,
    )
    yield { finish_reason: 'stop' }
  }
}

describe('host executor — typed saturation refusal', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '50'
    process.env.BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS = '400'
  })
  afterEach(() => {
    delete process.env.BRIDGE_HOST_MAX_CONCURRENCY
    delete process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS
    delete process.env.BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS
  })

  it('rejects a starved acquire with the counts and the retry-safe facts', async () => {
    const { hostSpawner } = await import('../src/executors/host.js')
    const { ExecutorSaturatedError: Saturated } = await import('../src/executors/types.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const refused = await hostSpawner('node', ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
        .then(() => null, (error: unknown) => error)
      expect(refused).toBeInstanceOf(Saturated)
      const error = refused as ExecutorSaturatedError
      expect(error.code).toBe('executor_saturated')
      expect(error.providerDispatch).toBe('not_started')
      expect(error.capacity).toBe(true)
      expect(error.httpStatus).toBe(429)
      expect(error.executor).toBe('host')
      expect(error.snapshot).toEqual({ in_flight: 1, max: 1, queued: 0, deadline_ms: 50 })
      // Retry loops already in production key on this prose. It stays.
      expect(error.message).toMatch(/host-executor: acquire timeout after 50ms \(in_flight=1\/1, queued=0\)/)
    } finally {
      holder.child.kill()
      holder.release()
    }
  })

  it('honours a longer per-request deadline and caps it at the server maximum', async () => {
    const { hostSpawner, resolveHostAcquireDeadlineMs } = await import('../src/executors/host.js')
    const { ExecutorSaturatedError: Saturated } = await import('../src/executors/types.js')
    expect(resolveHostAcquireDeadlineMs(undefined)).toBe(50)
    expect(resolveHostAcquireDeadlineMs(200)).toBe(200)
    // 10 minutes requested, 400 ms allowed by BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS.
    expect(resolveHostAcquireDeadlineMs(600_000)).toBe(400)

    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const started = Date.now()
      const refused = await hostSpawner('node', ['-e', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        acquireDeadlineMs: 250,
      }).then(() => null, (error: unknown) => error as ExecutorSaturatedError)
      const waited = Date.now() - started
      expect(refused).toBeInstanceOf(Saturated)
      expect((refused as ExecutorSaturatedError).snapshot.deadline_ms).toBe(250)
      // The env default is 50 ms; the request bought itself the longer wait.
      expect(waited).toBeGreaterThanOrEqual(200)
    } finally {
      holder.child.kill()
      holder.release()
    }
  })

  it('caps a request deadline that exceeds the server maximum', async () => {
    const { hostSpawner } = await import('../src/executors/host.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const refused = await hostSpawner('node', ['-e', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        acquireDeadlineMs: 900_000,
      }).then(() => null, (error: unknown) => error as ExecutorSaturatedError)
      expect((refused as ExecutorSaturatedError).snapshot.deadline_ms).toBe(400)
    } finally {
      holder.child.kill()
      holder.release()
    }
  })
})

describe('saturation refusal — the prose signature deployed clients key on', () => {
  // discovery-lab `tools/worker-spawn-retry.mjs` keys its retry loop on this
  // exact shape, and copies of it are already running. Nothing may come between
  // the executor name and the phrase, in any lane.
  const SIGNATURE = /(?:host-executor|scoped-host-executor|container-pool): acquire timeout after \d+ms/

  it('holds for every executor lane', () => {
    for (const [executor, message] of [
      ['host', 'host-executor: acquire timeout after 60000ms (in_flight=4/4, queued=1)'],
      ['scoped-host', 'scoped-host-executor: acquire timeout after 60000ms (lane=bulk, bulk=2/2, in_flight=4/4, queued=1)'],
      ['container-pool', 'container-pool: acquire timeout after 60000ms (in_flight=4/4, queued=1)'],
    ] as const) {
      const error = new ExecutorSaturatedError(
        executor,
        { in_flight: 4, max: 4, queued: 1, deadline_ms: 60_000 },
        message,
      )
      expect(error.message).toMatch(SIGNATURE)
    }
  })

  it('is the shape the host semaphore actually produces', async () => {
    vi.resetModules()
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '30'
    const { hostSpawner } = await import('../src/executors/host.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const refused = await hostSpawner('node', ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
        .then(() => null, (error: unknown) => error as Error)
      expect(refused?.message).toMatch(SIGNATURE)
    } finally {
      holder.child.kill()
      holder.release()
      delete process.env.BRIDGE_HOST_MAX_CONCURRENCY
      delete process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS
    }
  })
})

describe('chat completions — saturation answers 429', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono
  let backend: SaturatedBackend

  const post = async (body: Record<string, unknown>): Promise<Response> => await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'saturated',
      messages: [{ role: 'user', content: 'work' }],
      ...body,
    }),
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-saturation-'))
    sessions = new SessionStore(dir)
    backend = new SaturatedBackend()
    app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
    })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers 429 with Retry-After and the executor counts', async () => {
    const response = await post({})
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.json()).toEqual({
      error: {
        type: 'executor_saturated',
        capacity: true,
        provider_dispatch: 'not_started',
        status: 429,
        executor: 'host',
        in_flight: 4,
        max: 4,
        queued: 1,
        deadline_ms: 60_000,
        retry_after_ms: 5_000,
        message: 'host-executor: acquire timeout after 60000ms (in_flight=4/4, queued=1)',
      },
    })
  })

  it('keeps the body inside the 300-byte window a client parses it through', async () => {
    // agent-runtime slices a bridge error body to 300 characters before it
    // JSON.parses it for `provider_dispatch`. A longer body is unparsable, and
    // the one-sided "nothing ran" fact is lost exactly when it matters.
    const response = await post({})
    const body = await response.text()
    expect(body.length).toBeLessThanOrEqual(300)
    expect(JSON.parse(body.slice(0, 300)).error.provider_dispatch).toBe('not_started')
  })

  it('carries the same facts on the streamed error frame', async () => {
    // A streaming request has already committed to 200 + SSE when the spawn
    // seam refuses, so the frame itself has to carry the status and the
    // capacity flag or the client falls back to sniffing prose.
    const response = await post({ stream: true })
    expect(response.status).toBe(200)
    const text = await response.text()
    const frame = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.includes('"error"'))
      .map((line) => JSON.parse(line.slice('data: '.length)))[0]
    expect(frame.error).toMatchObject({
      type: 'executor_saturated',
      status: 429,
      capacity: true,
      provider_dispatch: 'not_started',
      executor: { name: 'host', in_flight: 4, max: 4, queued: 1, deadline_ms: 60_000 },
    })
  })

  it('passes a capped per-request acquire deadline to the executor seam', async () => {
    const response = await post({ execution: { kind: 'host', acquireTimeoutMs: 5_000 } })
    expect(response.status).toBe(429)
    expect(backend.lastRequest?.acquireDeadlineMs).toBe(5_000)
  })

  it('refuses a malformed acquire deadline instead of silently defaulting', async () => {
    const response = await post({ execution: { kind: 'host', acquireTimeoutMs: 0 } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
  })
})

describe('health — executor occupancy', () => {
  it('reports the counts a launcher gates admission on', async () => {
    const app = new Hono()
    mountHealth(app, { registry: new BackendRegistry().register(new SaturatedBackend()) })
    const body = await (await app.request('/health')).json() as {
      executor: { in_flight: number; max: number; queued: number; scoped_host: { max: number } }
    }
    expect(body.executor).toMatchObject({
      in_flight: expect.any(Number),
      max: expect.any(Number),
      queued: expect.any(Number),
    })
    expect(body.executor.scoped_host.max).toEqual(expect.any(Number))
  })
})
