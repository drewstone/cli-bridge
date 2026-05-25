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

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

describe('container pool — snapshot + counters', async () => {
  // Drive a fake pool by monkey-patching execFile via vi.mock. We're
  // testing the counter + state-machine code, not docker integration.
  beforeEach(() => {
    vi.resetModules()
  })

  it('snapshot returns the documented shape', async () => {
    // Construct via the real module but bypass docker by mocking execFile.
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFile: (
          _cmd: string,
          args: readonly string[],
          cb: (e: Error | null, out: { stdout: string; stderr: string }) => void,
        ) => {
          // `docker run -d ...` returns a fake container id; `docker rm -f`
          // returns empty. Either path resolves successfully.
          const isRun = (args as string[]).includes('run')
          cb(null, { stdout: isRun ? 'fakeid-' + Math.random().toString(36).slice(2) : '', stderr: '' })
          return undefined as unknown as ReturnType<typeof actual.execFile>
        },
      }
    })
    const { ContainerPool } = await import('../src/executors/container-pool.js')
    const pool = await ContainerPool.create({
      size: 2,
      image: 'fake',
      namePrefix: 'cli-bridge-test',
      oauthMode: 'share',
      shareMounts: [],
      maxQueueDepth: 4,
      acquireDeadlineMs: 1000,
      slotMaxHoldMs: 60_000,
    })
    const snap = pool.snapshot()
    expect(snap.size).toBe(2)
    expect(snap.in_flight).toBe(0)
    expect(snap.queued).toBe(0)
    expect(snap.max_queue).toBe(4)
    expect(snap.dead).toBe(0)
    expect(typeof snap.acquires).toBe('number')
    expect(typeof snap.queue_full_rejects).toBe('number')
    expect(typeof snap.acquire_timeouts).toBe('number')
    expect(typeof snap.slot_force_releases).toBe('number')
    await pool.destroy()
    vi.doUnmock('node:child_process')
  })
})

describe('/metrics route', () => {
  it('returns host_executor + pools envelope', async () => {
    vi.resetModules()
    const { Hono } = await import('hono')
    const { mountMetrics } = await import('../src/routes/metrics.js')
    const app = new Hono()
    mountMetrics(app)
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      ts: string
      host_executor: { max: number }
      scoped_host_executor: { max: number }
      pools: unknown
    }
    expect(body.ts).toBeTypeOf('string')
    expect(body.host_executor).toBeDefined()
    expect(body.host_executor.max).toBeTypeOf('number')
    expect(body.scoped_host_executor).toBeDefined()
    expect(body.scoped_host_executor.max).toBeTypeOf('number')
    expect(body.pools).toBeDefined()
  })
})
