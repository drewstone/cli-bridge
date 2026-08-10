/**
 * An admission slot must not outlive the job it was charged to.
 *
 * The measured failure: `/health` reported active 20/20 while the process owned
 * no harness at all and the executor reported zero work in flight, so the gate
 * admitted nobody and every caller expired in its queue wait. The slot was
 * released from the delta stream's `finally`, which only runs when something
 * consumes the stream — a job whose stream is never consumed never released.
 *
 * These tests hold the gate to the invariant on every exit: normal completion,
 * a throw after admission, a client that disconnects, an aborted request, and a
 * run committed terminal before its source is ever pumped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AdmissionGate } from '../src/admission.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountHealth } from '../src/routes/health.js'
import { BackendError, type Backend, type ChatDelta, type ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

/** Stands in for a multi-minute host CLI call the test can end on demand. */
class HeldBackend implements Backend {
  started = 0
  private releases: Array<() => void> = []
  constructor(readonly name: string, private readonly failWith?: BackendError) {}
  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }
  async health() {
    return { name: this.name, state: 'ready' as const }
  }
  async *chat(_req: ChatRequest, _session: SessionRecord | null, signal?: AbortSignal): AsyncIterable<ChatDelta> {
    this.started += 1
    if (this.failWith) throw this.failWith
    await new Promise<void>((resolve) => {
      this.releases.push(resolve)
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    if (signal?.aborted) throw new BackendError(`${this.name}: aborted`, 'aborted')
    yield { content: 'ok' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  endAll(): void {
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

/** Settle the microtask queue so a job promise's release handler has run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

let dir: string
let sessions: SessionStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-bridge-slot-'))
  sessions = new SessionStore(dir)
})
afterEach(() => {
  sessions.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface Harness {
  app: Hono
  backend: HeldBackend
  admission: AdmissionGate
  runs: RunRegistry
}

function harness(opts: { failWith?: BackendError; runs?: RunRegistry } = {}): Harness {
  const backend = new HeldBackend('claude', opts.failWith)
  const admission = new AdmissionGate({
    maxActive: 4,
    maxQueue: 8,
    queueTimeoutMs: 200,
    reservedActive: 1,
    bulkQueueTimeoutMs: 200,
    // Every assertion below is about the structural release, so the background
    // reconciler is off: a slot that returns to zero here did so because its
    // job ended, not because a timer swept up after it.
    reconcileIntervalMs: 0,
  })
  const runs = opts.runs ?? new RunRegistry()
  const app = new Hono()
  mountChatCompletions(app, {
    registry: new BackendRegistry().register(backend),
    sessions,
    runs,
    admission,
  })
  return { app, backend, admission, runs }
}

function post(app: Hono, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return Promise.resolve(app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x' }], ...body }),
    ...(signal ? { signal } : {}),
  }))
}

describe('admission slot lifetime', () => {
  it('returns the slot when a completed job ends', async () => {
    const h = harness()
    const pending = post(h.app, { stream: false, run_id: 'done' })
    await waitFor(() => h.backend.started === 1)
    expect(h.admission.snapshot()).toMatchObject({ active: 1, live: 1, stale: 0 })

    h.backend.endAll()
    expect((await pending).status).toBe(200)
    await settle()
    expect(h.admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('returns the slot when the handler throws after admission', async () => {
    const h = harness({ failWith: new BackendError('claude: exploded', 'upstream') })
    const response = await post(h.app, { stream: false, run_id: 'throws' })
    expect(response.status).not.toBe(200)
    await settle()
    expect(h.admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('keeps the slot for the job when the client disconnects, then returns it when the job ends', async () => {
    const h = harness()
    const client = new AbortController()
    const pending = post(h.app, { stream: true, run_id: 'gone' }, client.signal).catch(() => null)
    await waitFor(() => h.backend.started === 1)

    client.abort()
    await pending
    await settle()
    // The reader left; the subprocess did not. Freeing the slot here would admit
    // a second job onto capacity the first one is still using.
    expect(h.admission.snapshot()).toMatchObject({ active: 1, live: 1, stale: 0 })

    h.backend.endAll()
    await settle()
    expect(h.admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('returns the slot when the request is aborted', async () => {
    const h = harness()
    const pending = post(h.app, { stream: false, run_id: 'cancelled' })
    await waitFor(() => h.backend.started === 1)

    expect(h.runs.cancel('cancelled')).toBe(true)
    await pending
    await settle()
    expect(h.admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('returns the slot for a run committed terminal before its source is pumped', async () => {
    // `Run.pump` returns without consuming its source once the run is settled,
    // so the delta stream — and anything released from its `finally` — never
    // runs. The slot must still come back, because no job ever started.
    const runs = new RunRegistry()
    const claim = runs.claim.bind(runs)
    let preempted = false
    runs.claim = (id: string, digest: string) => {
      const claimed = claim(id, digest)
      if (!preempted && claimed.created) {
        preempted = true
        queueMicrotask(() => claimed.run.failSetup(new Error('committed terminal before pump')))
      }
      return claimed
    }
    const h = harness({ runs })

    await post(h.app, { stream: false, run_id: 'preempted' }).catch(() => null)
    await settle()
    expect(h.backend.started).toBe(0)
    // reclaimed 0: the slot came back because the job's lifetime settled, not
    // because the reconciler swept up after a skipped release.
    expect(h.admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('returns the slot when setup throws between admission and the job', async () => {
    // A ceiling violation is raised while the source is being built — after the
    // slot is charged and before any job exists to bind it to.
    const backend = new HeldBackend('claude') as HeldBackend & { defaultExecutionTimeoutMs: number }
    backend.defaultExecutionTimeoutMs = 2_147_483_648
    const admission = new AdmissionGate({
      maxActive: 4,
      maxQueue: 8,
      queueTimeoutMs: 200,
      reservedActive: 1,
      bulkQueueTimeoutMs: 200,
      reconcileIntervalMs: 0,
    })
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
      admission,
    })

    const response = await post(app, { stream: false, run_id: 'bad-timeout' })
    expect(response.status).not.toBe(200)
    await settle()
    // reclaimed 0: the slot came back through the normal contract, not through
    // the reconciler sweeping up after a skipped release.
    expect(admission.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 0 })
  })

  it('keeps admitting after a job that never consumed its stream', async () => {
    // The operator-visible consequence of the leak: capacity that never comes
    // back. Four preempted jobs must not cost the fifth caller its slot.
    const runs = new RunRegistry()
    const claim = runs.claim.bind(runs)
    runs.claim = (id: string, digest: string) => {
      const claimed = claim(id, digest)
      if (claimed.created && id.startsWith('preempt-')) {
        queueMicrotask(() => claimed.run.failSetup(new Error('committed terminal before pump')))
      }
      return claimed
    }
    const h = harness({ runs })

    for (let i = 0; i < 4; i++) {
      await post(h.app, { stream: false, run_id: `preempt-${i}` }).catch(() => null)
    }
    await settle()
    expect(h.admission.snapshot()).toMatchObject({ active: 0, reclaimed: 0 })

    const pending = post(h.app, { stream: false, run_id: 'survivor' })
    await waitFor(() => h.backend.started === 1)
    h.backend.endAll()
    expect((await pending).status).toBe(200)
  })
})

describe('admission reconciliation', () => {
  function driftGate(now: () => number): AdmissionGate {
    return new AdmissionGate({
      maxActive: 2,
      maxQueue: 4,
      queueTimeoutMs: 50,
      reservedActive: 0,
      bulkQueueTimeoutMs: 50,
      reconcileIntervalMs: 0,
      now,
    })
  }

  it('takes back a slot whose job finished without a release, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 1_000
    const gate = driftGate(() => clock)
    let finished = false
    // Acquire without binding a lifetime: the shape of every exit that used to
    // skip the release.
    await gate.acquire({ work: { id: 'job-7', isFinished: () => finished }, admissionClass: 'bulk' })
    expect(gate.snapshot()).toMatchObject({ active: 1, live: 1, stale: 0 })

    finished = true
    clock += 500
    expect(gate.snapshot()).toMatchObject({ active: 1, live: 0, stale: 1 })

    expect(gate.reconcile()).toBe(1)
    expect(gate.snapshot()).toMatchObject({ active: 0, live: 0, stale: 0, reclaimed: 1 })
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('job-7')
  })

  it('takes back a slot no caller ever bound to a lifetime', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 1_000
    const gate = driftGate(() => clock)
    // A job that never reports finishing: only the missing binding proves the
    // slot is ownerless.
    await gate.acquire({ work: { id: 'orphan', isFinished: () => false } })

    clock += 500
    expect(gate.reconcile()).toBe(0)
    clock += 1_000
    expect(gate.reconcile()).toBe(1)
    expect(gate.snapshot()).toMatchObject({ active: 0, unbound: 0, reclaimed: 1 })
  })

  it('hands a reclaimed slot to a queued caller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 1_000
    const gate = driftGate(() => clock)
    let finished = false
    const work = { id: 'stuck', isFinished: () => finished }
    await gate.acquire({ work })
    await gate.acquire({ work })
    expect(gate.snapshot().active).toBe(2)

    finished = true
    // A new admission reconciles first, so a caller arriving after the drift is
    // admitted instead of queued behind slots charged to nothing.
    const slot = await gate.acquire({ work: { id: 'next', isFinished: () => false } })
    expect(slot).toBeDefined()
    expect(gate.snapshot()).toMatchObject({ active: 1, reclaimed: 2 })
  })

  it('refuses to bind one slot to two lifetimes', async () => {
    const gate = driftGate(() => 1_000)
    const slot = await gate.acquire({ work: { id: 'twice', isFinished: () => false } })
    slot.holdUntil(new Promise(() => {}))
    expect(() => slot.holdUntil(new Promise(() => {}))).toThrow(/already bound/)
  })
})

describe('admission on /health', () => {
  it('reports accounted and live side by side so drift is readable', async () => {
    let clock = 1_000
    const gate = new AdmissionGate({
      maxActive: 4,
      maxQueue: 4,
      queueTimeoutMs: 50,
      reservedActive: 1,
      bulkQueueTimeoutMs: 50,
      reconcileIntervalMs: 0,
      now: () => clock,
    })
    let finished = false
    await gate.acquire({ work: { id: 'ghost', isFinished: () => finished } })
    finished = true
    clock += 60_000

    const app = new Hono()
    const backend = new HeldBackend('claude')
    mountHealth(app, { registry: new BackendRegistry().register(backend), admission: gate }, {
      probe: async (b) => ({ name: b.name, state: 'ready' as const }),
    })

    const body = await (await app.request('/health')).json() as {
      admission: { active: number; live: number; stale: number; oldestHeldMs: number; maxActive: number }
    }
    // "accounted 1, actually 0" instead of an unexplained queue timeout.
    expect(body.admission).toMatchObject({ active: 1, live: 0, stale: 1, maxActive: 4 })
    expect(body.admission.oldestHeldMs).toBe(60_000)
  })
})
