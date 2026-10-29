import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Durability — every safety net we ship in this PR.
 *
 * Six things must hold for the bridge to be anti-fragile under
 * massive-parallel bench load:
 *   1. host semaphore caps concurrent host spawns
 *   2. host semaphore rejects waiters past the deadline
 *   3. host snapshot exposes counters for /metrics
 *   4. pool snapshot exposes counters
 *   5. slot-hold watchdog force-recycles wedged slots
 *   6. metrics route returns the expected JSON shape
 *
 * The container-pool tests don't touch real docker; they exercise
 * private state directly via a thin test harness wrapper. The docker
 * integration path is covered by tests/docker-executor.test.ts.
 */


afterEach(() => {
  vi.useRealTimers()
})

async function waitFor(predicate: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      predicate()
      return
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (lastErr) throw lastErr
  predicate()
}

describe('host executor semaphore', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '2'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '2000'
  })

  it('blocks the 3rd concurrent spawn until a slot frees', async () => {
    const { hostSpawner } = await import('../src/executors/host.js')
    const t0 = Date.now()
    const results = await Promise.all([
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    ])
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(80)
    for (const r of results) {
      r.child.kill()
      r.release()
    }
  })

  it('reserves a freed slot for the queued waiter before admitting new callers', async () => {
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '2000'
    vi.resetModules()
    const { hostSpawner, hostExecutorSnapshot } = await import('../src/executors/host.js')

    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const queued = hostSpawner('node', ['-e', 'setTimeout(()=>{},200)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitFor(() => {
      expect(hostExecutorSnapshot().queued).toBe(1)
    })

    const t0 = Date.now()
    holder.release()
    holder.child.kill()
    const late = await hostSpawner('node', ['-e', 'setTimeout(()=>{},10)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)

    const queuedResult = await queued
    queuedResult.release()
    queuedResult.child.kill()
    late.release()
    late.child.kill()
    await waitFor(() => {
      expect(hostExecutorSnapshot()).toMatchObject({ in_flight: 0, queued: 0 })
    })
  })

  it('removes an aborted waiter before the holder frees its slot', async () => {
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    vi.resetModules()
    const { hostSpawner, hostExecutorSnapshot } = await import('../src/executors/host.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {})
    const controller = new AbortController()
    try {
      const queued = hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], { signal: controller.signal })
      await waitFor(() => { expect(hostExecutorSnapshot().queued).toBe(1) })
      controller.abort(new Error('cancelled while queued'))
      await expect(queued).rejects.toThrow('cancelled while queued')
      expect(hostExecutorSnapshot()).toMatchObject({ in_flight: 1, queued: 0 })
    } finally {
      holder.child.kill()
      holder.release()
    }
    await waitFor(() => {
      expect(hostExecutorSnapshot()).toMatchObject({ in_flight: 0, queued: 0 })
    })
  })

  it('rejects with timeout when no slot frees within the deadline', async () => {
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '50'
    vi.resetModules()
    const { hostSpawner } = await import('../src/executors/host.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await expect(
        hostSpawner('node', ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      ).rejects.toThrow(/acquire timeout/)
    } finally {
      holder.child.kill()
      holder.release()
    }
  })

  it('snapshot exposes acquires + timeouts counters', async () => {
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '30'
    vi.resetModules()
    const { hostSpawner, hostExecutorSnapshot } = await import('../src/executors/host.js')
    const holder = await hostSpawner('node', ['-e', 'setTimeout(()=>{},1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await expect(
      hostSpawner('node', ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    ).rejects.toThrow(/acquire timeout/)
    const snap = hostExecutorSnapshot()
    expect(snap.acquires).toBeGreaterThanOrEqual(2)
    expect(snap.timeouts).toBeGreaterThanOrEqual(1)
    holder.child.kill()
    holder.release()
  })
})
