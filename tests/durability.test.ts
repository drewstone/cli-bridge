/**
 * durability tests — pool acquire queue + deadline + host semaphore.
 *
 * These are the safety nets that prevent the bench-fork-bomb failure
 * mode where 16+ parallel clients lock up the host. Without these
 * passing, max-parallelism bench runs can wedge a remote box.
 *
 * The tests stub the container provisioning so they don't need Docker;
 * the queue / deadline / semaphore logic is pure JS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('host executor semaphore', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '2'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '2000'
  })

  it('blocks the 3rd concurrent spawn until a slot frees', async () => {
    const { hostSpawner, hostExecutorSnapshot } = await import('../src/executors/host.js')
    const t0 = Date.now()
    const results = await Promise.all([
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      hostSpawner('node', ['-e', 'setTimeout(()=>{},100)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    ])
    const elapsed = Date.now() - t0
    // First two start immediately, third waits for one to exit (~100ms).
    expect(elapsed).toBeGreaterThanOrEqual(80)
    // Tear down — exit listeners auto-release.
    for (const r of results) {
      r.child.kill()
      r.release()
    }
    const snap = hostExecutorSnapshot()
    await new Promise((r) => setTimeout(r, 50))
    expect(hostExecutorSnapshot().in_flight).toBeLessThanOrEqual(snap.max)
  })

  it('rejects with timeout when no slot frees within the deadline', async () => {
    process.env.BRIDGE_HOST_MAX_CONCURRENCY = '1'
    process.env.BRIDGE_HOST_ACQUIRE_DEADLINE_MS = '50'
    vi.resetModules()
    const { hostSpawner } = await import('../src/executors/host.js')
    // Hold the only slot with a long-running child.
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
})

// Container pool queue/deadline behavior is covered by the existing
// tests/docker-executor.test.ts which exercise it through real docker.
// Adding a stubbed-execFile unit test here would duplicate that surface;
// the host-semaphore tests above are the unique safety net.
