/**
 * Memory bounds on the durable run registry.
 *
 * Every retention bound the registry had was armed by `finish()`, so a backend
 * that never terminated kept its replay buffer, its registry entry and its
 * admission slot for the life of the process. Measured before the fix: 150
 * unsettled runs held 474.8 MB and released none of it. These tests fail if
 * either bound goes back to depending on the backend behaving.
 */

import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta } from '../src/backends/types.js'
import { mountHealth } from '../src/routes/health.js'
import { RunLifetimeExceededError, RunRegistry } from '../src/runs/registry.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.useRealTimers()
})

/** A backend that produces output and then never terminates. */
async function* hangsAfter(deltas: readonly ChatDelta[]): AsyncIterable<ChatDelta> {
  for (const delta of deltas) yield delta
  await new Promise(() => {})
}

function payload(bytes: number, seed: number): string {
  return `${seed}`.padStart(8, '0').repeat(Math.max(1, Math.ceil(bytes / 8))).slice(0, bytes)
}

describe('durable run memory bounds', () => {
  it('does not end an unsettled run only because time passed', async () => {
    vi.useFakeTimers()
    const registry = new RunRegistry()
    const { run } = registry.claim('persistent', 'digest')
    void run.pump(hangsAfter([{ content: 'still working' }]))

    await vi.advanceTimersByTimeAsync(21_600_001)

    expect(run.isTerminal()).toBe(false)
    expect(run.snapshot().lifetimeExpiresAt).toBeNull()
    registry.clear()
  })

  it('releases a run whose backend never reaches a terminal state', async () => {
    const registry = new RunRegistry({
      replayRetentionMs: 10,
      identityRetentionMs: 20,
      maxLifetimeMs: 40,
    })
    const { run } = registry.claim('hung', 'digest')
    void run.pump(hangsAfter([{ content: 'partial output' }]))
    await delay(5)

    expect(run.isTerminal()).toBe(false)
    expect(registry.get('hung')).toBe(run)

    await delay(200)

    // Forced terminal, and then forgotten by the normal retention path.
    expect(run.isTerminal()).toBe(true)
    expect(run.failure()).toBeInstanceOf(RunLifetimeExceededError)
    expect(registry.get('hung')).toBeUndefined()
    expect(registry.size()).toBe(0)
    registry.clear()
  })

  it('does not accumulate unsettled runs across many dispatches', async () => {
    const registry = new RunRegistry({
      replayRetentionMs: 5,
      identityRetentionMs: 10,
      maxLifetimeMs: 25,
    })
    for (let i = 0; i < 40; i += 1) {
      const { run } = registry.claim(`hung-${i}`, `digest-${i}`)
      void run.pump(hangsAfter([{ content: payload(1024, i) }]))
    }
    expect(registry.size()).toBe(40)

    await delay(300)

    expect(registry.size()).toBe(0)
    expect(registry.retainedBytes()).toBe(0)
    registry.clear()
  })

  it('keeps the run alive while it is still producing within its lifetime', async () => {
    const registry = new RunRegistry({
      replayRetentionMs: 50,
      identityRetentionMs: 100,
      maxLifetimeMs: 0,
    })
    const { run } = registry.claim('live', 'digest')
    void run.pump(hangsAfter([{ content: 'still going' }]))
    await delay(60)

    // A zero ceiling restores unbounded lifetime, so nothing forces terminal.
    expect(run.isTerminal()).toBe(false)
    expect(registry.get('live')).toBe(run)
    registry.clear()
  })

  it('bounds the replay buffer by bytes, not only by delta count', async () => {
    const maxReplayBytes = 64 * 1024
    const registry = new RunRegistry({
      replayRetentionMs: 60_000,
      identityRetentionMs: 120_000,
      maxReplayDeltas: 10_000,
      maxReplayBytes,
      maxLifetimeMs: 0,
    })
    const { run } = registry.claim('fat', 'digest')
    const deltas: ChatDelta[] = []
    for (let i = 0; i < 200; i += 1) deltas.push({ content: payload(8 * 1024, i) })
    await run.pump((async function* () {
      for (const delta of deltas) yield delta
      yield { finish_reason: 'stop' }
    })())

    const snapshot = run.snapshot()
    // 200 deltas of 8 KiB is 1.6 MiB and stays far under the 10,000 count cap,
    // so only the byte budget can hold this down.
    expect(snapshot.replay.retainedDeltas).toBeLessThan(200)
    expect(snapshot.replay.retainedBytes).toBeLessThanOrEqual(maxReplayBytes)
    expect(snapshot.replay.maxRetainedBytes).toBe(maxReplayBytes)
    registry.clear()
  })

  it('retains the newest delta even when it alone exceeds the byte budget', async () => {
    const registry = new RunRegistry({
      replayRetentionMs: 60_000,
      identityRetentionMs: 120_000,
      maxReplayBytes: 512,
      maxLifetimeMs: 0,
    })
    const { run } = registry.claim('huge', 'digest')
    await run.pump((async function* () {
      yield { content: payload(64 * 1024, 1) }
      yield { finish_reason: 'stop' }
    })())

    // Emptying the buffer would leave a caught-up reader unable to resume.
    expect(run.snapshot().replay.retainedDeltas).toBeGreaterThanOrEqual(1)
    registry.clear()
  })

  it('reports heap pressure and registry retention on /health', async () => {
    const backend: Backend = {
      name: 'stub',
      matches: (model: string) => model === 'stub',
      health: async (): Promise<BackendHealth> => ({ name: 'stub', state: 'ready' }),
      chat: async function* () { yield { finish_reason: 'stop' } as ChatDelta },
    }
    const runs = new RunRegistry({ maxLifetimeMs: 0 })
    const app = new Hono()
    mountHealth(app, { registry: new BackendRegistry().register(backend), runs })

    const body = await (await app.request('/health')).json() as {
      memory: {
        heap_used_bytes: number
        heap_limit_bytes: number
        heap_used_pct: number
        runs_retained: number
      }
    }
    expect(body.memory.heap_used_bytes).toBeGreaterThan(0)
    expect(body.memory.heap_limit_bytes).toBeGreaterThan(0)
    expect(body.memory.heap_used_pct).toBeGreaterThan(0)
    expect(body.memory.runs_retained).toBe(0)
    runs.clear()
  })
})
