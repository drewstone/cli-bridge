/**
 * End-to-end proof over HTTP that the automated PR reviewer is admitted while
 * an agent fleet holds every slot it is allowed to hold, and that a rejected
 * caller can tell "the bridge was full" from "the model failed".
 *
 * Shape of the incident this reproduces: the reviewer's bridge answered 503
 * `admission_rejected / queue_timeout` with active 20/20 and queued 7/48 — the
 * queue was 15% full, so depth was never the binding constraint. A low-rate
 * caller was FIFO-queued behind host calls whose median hold time exceeds the
 * admission timeout.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { BackendError, type Backend, type ChatDelta, type ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { AdmissionGate } from '../src/admission.js'

/** Holds a slot until released, standing in for a multi-minute host CLI call. */
class BlockingBackend implements Backend {
  started = 0
  private releases: Array<() => void> = []
  constructor(readonly name: string, private readonly failWith?: BackendError) {}
  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(_req: ChatRequest, _session: SessionRecord | null): AsyncIterable<ChatDelta> {
    this.started += 1
    await new Promise<void>((resolve) => this.releases.push(resolve))
    if (this.failWith) throw this.failWith
    yield { content: 'ok' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  releaseAll(): void {
    const pending = this.releases
    this.releases = []
    for (const release of pending) release()
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timed out')
}

const FLEET_SIZE = 20
const RESERVED = 2

interface Harness {
  app: Hono
  backend: BlockingBackend
  admission: AdmissionGate
}

function harness(opts: { reservedActive: number; failWith?: BackendError }): Harness {
  const backend = new BlockingBackend('claude', opts.failWith)
  const admission = new AdmissionGate({
    maxActive: FLEET_SIZE,
    maxQueue: 48,
    queueTimeoutMs: 200,
    reservedActive: opts.reservedActive,
    bulkQueueTimeoutMs: 200,
  })
  const app = new Hono()
  mountChatCompletions(app, {
    registry: new BackendRegistry().register(backend),
    sessions: sessionStore,
    runs: new RunRegistry(),
    admission,
    admissionReservedClients: ['pr-reviewer'],
  })
  return { app, backend, admission }
}

function call(h: Harness, client?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (client) headers['x-tangle-client'] = client
  return Promise.resolve(h.app.request('/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x' }], stream: false }),
  }))
}

/** Fill the bridge the way a burst of concurrent agent workflows does. */
async function saturate(h: Harness): Promise<Promise<Response>[]> {
  const inflight = Array.from({ length: FLEET_SIZE }, () => call(h, 'agent-fleet/1'))
  await waitFor(() => h.backend.started === FLEET_SIZE - h.admission.snapshot().reservedActive)
  return inflight
}

/**
 * Release blocked calls until every request settles. Releasing once is not
 * enough: a freed slot admits a queued caller, which then blocks in turn.
 */
async function finish(h: Harness, ...groups: Promise<Response>[][]): Promise<void> {
  let settled = false
  const all = Promise.all(groups.flat()).then(() => { settled = true })
  while (!settled) {
    h.backend.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await all
}

let dir: string
let sessionStore: SessionStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-bridge-lane-'))
  sessionStore = new SessionStore(dir)
})
afterEach(() => {
  sessionStore.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reviewer admission under fleet saturation', () => {
  it('BEFORE (reservedActive=0): the fleet fills every slot and the reviewer is rejected', async () => {
    const h = harness({ reservedActive: 0 })
    const inflight = await saturate(h)
    expect(h.admission.snapshot()).toMatchObject({ active: FLEET_SIZE, maxActive: FLEET_SIZE })

    const res = await call(h, 'pr-reviewer/1')
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { type: string; reason: string; admission: { queued: number; maxQueue: number } } }
    expect(body.error.type).toBe('admission_rejected')
    expect(body.error.reason).toBe('queue_timeout')
    // The incident's signature: rejected with the queue almost empty.
    expect(body.error.admission.queued).toBe(0)
    expect(body.error.admission.maxQueue).toBe(48)

    await finish(h, inflight)
  })

  it('AFTER (reservedActive=2): the same fleet load leaves the reviewer admitted', async () => {
    const h = harness({ reservedActive: RESERVED })
    const inflight = await saturate(h)
    // Bulk is pinned at its ceiling; the fleet cannot reach the reserved slots.
    expect(h.admission.snapshot()).toMatchObject({
      active: FLEET_SIZE - RESERVED,
      bulkMaxActive: FLEET_SIZE - RESERVED,
      activeByClass: { reserved: 0, bulk: FLEET_SIZE - RESERVED },
    })

    // The reviewer runs both of its per-PR agents concurrently.
    const reviewer = [call(h, 'pr-reviewer/1'), call(h, 'pr-reviewer/1')]
    await waitFor(() => h.admission.snapshot().activeByClass.reserved === RESERVED)
    expect(h.backend.started).toBe(FLEET_SIZE)

    await finish(h, reviewer, inflight)
    const results = await Promise.all(reviewer)
    expect(results.map((r) => r.status)).toEqual([200, 200])
  })

  it('marks a capacity rejection so a caller never reads it as a model failure', async () => {
    const h = harness({ reservedActive: RESERVED })
    const inflight = await saturate(h)

    // Three reviewer-class calls: two take the lane, the third is rejected.
    const held = [call(h, 'pr-reviewer/1'), call(h, 'pr-reviewer/1')]
    await waitFor(() => h.admission.snapshot().activeByClass.reserved === RESERVED)

    const res = await call(h, 'pr-reviewer/1')
    expect(res.status).toBe(503)
    const body = await res.json() as {
      error: { capacity: boolean; type: string; reason: string; admissionClass: string }
    }
    expect(body.error.capacity).toBe(true)
    expect(body.error.type).toBe('admission_rejected')
    expect(body.error.admissionClass).toBe('reserved')
    expect(res.headers.get('Retry-After')).toBe('5')

    await finish(h, held, inflight)
  })

  it('does not mark a real model failure as capacity', async () => {
    const h = harness({
      reservedActive: RESERVED,
      failWith: new BackendError('claude: model exploded', 'upstream'),
    })
    const pending = call(h, 'pr-reviewer/1')
    await waitFor(() => h.backend.started === 1)
    h.backend.releaseAll()

    const res = await pending
    const body = await res.json() as { error: { capacity?: boolean; type: string } }
    expect(res.status).not.toBe(503)
    expect(body.error.capacity).toBeUndefined()
    expect(body.error.type).not.toBe('admission_rejected')
  })
})
