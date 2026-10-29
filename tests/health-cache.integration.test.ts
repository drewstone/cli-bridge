import { once } from 'node:events'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { AcpBackend } from '../src/backends/acp.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner, hostExecutorSnapshot } from '../src/executors/host.js'
import { terminateSpawned } from '../src/executors/process-tree.js'
import { mountHealth } from '../src/routes/health.js'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() > deadline) throw new Error('real health observation deadline exceeded'); await delay(5) }
}

test('real HTTP health caches faults, shares pending native probes, recovers and obeys force/cache-disabled controls', async () => {
  const keys = ['BRIDGE_HEALTH_CACHE_MS', 'BRIDGE_HEALTH_NEGATIVE_CACHE_MS', 'BRIDGE_HEALTH_PROBE_TIMEOUT_MS', 'BRIDGE_HEALTH_READY_CACHE_TTL_MS'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { BRIDGE_HEALTH_CACHE_MS: '1000', BRIDGE_HEALTH_NEGATIVE_CACHE_MS: '200',
    BRIDGE_HEALTH_PROBE_TIMEOUT_MS: '2000', BRIDGE_HEALTH_READY_CACHE_TTL_MS: '0' })
  const directory = await mkdtemp(join(tmpdir(), 'bridge-real-health-'))
  const servers: ReturnType<typeof serve>[] = []
  const blockers: Awaited<ReturnType<typeof hostSpawner>>[] = []
  const releaseBlockers = async () => {
    for (const blocker of blockers.splice(0)) { await terminateSpawned(blocker); blocker.release() }
  }
  const open = async (name: string, bin: string) => {
    const app = new Hono()
    let forced = 0
    app.use('/health', async (c, next) => { if (c.req.query('force') === '1') forced++; await next() })
    const registry = new BackendRegistry().register(new AcpBackend({ name, bin, timeoutMs: 2000, spawner: hostSpawner }))
    mountHealth(app, { registry })
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    servers.push(server)
    if (!server.listening) await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`
    return { forces: () => forced, get: async (query = '') => {
      const response = await fetch(url + query)
      const body = await response.json() as { backends: Array<{ state: string; cached: boolean; probed_at: string; version?: string }> }
      return { status: response.status, health: body.backends[0]! }
    } }
  }
  try {
    const missing = join(directory, 'recoverable-agent')
    const health = await open('real-acp', missing)
    const baseline = hostExecutorSnapshot().acquires
    const cold = await health.get()
    expect(cold.status).toBe(503)
    expect(cold.health.cached).toBe(false)
    expect(hostExecutorSnapshot().acquires - baseline).toBe(1)
    for (let i = 0; i < 3; i++) {
      const warm = await health.get()
      expect(warm.health).toMatchObject({ state: cold.health.state, cached: true, probed_at: cold.health.probed_at })
    }
    expect(hostExecutorSnapshot().acquires - baseline).toBe(1)
    const forcedFault = await health.get('?force=1')
    expect(forcedFault.status).toBe(503)
    expect(forcedFault.health.cached).toBe(false)
    expect(hostExecutorSnapshot().acquires - baseline).toBe(2)
    await symlink(process.execPath, missing)
    await delay(220)

    // Occupy the real executor with ordinary Node processes, making the next
    // real --version probe wait. No replacement CLI or injected probe is used.
    const capacity = hostExecutorSnapshot().max
    expect(capacity).toBeGreaterThan(0)
    expect(capacity).toBeLessThanOrEqual(8)
    for (let i = 0; i < capacity; i++) blockers.push(await hostSpawner(process.execPath,
      ['--eval', 'setInterval(() => {}, 60000)'], { stdio: ['ignore', 'pipe', 'pipe'] }))
    const beforeRefresh = hostExecutorSnapshot().acquires
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => health.get()))
    expect(concurrent.every((result) => result.health.cached && result.health.probed_at === forcedFault.health.probed_at)).toBe(true)
    expect(hostExecutorSnapshot().acquires - beforeRefresh).toBe(1)
    expect(hostExecutorSnapshot().queued).toBe(1)
    const started = performance.now()
    expect((await health.get()).health.cached).toBe(true)
    expect(performance.now() - started).toBeLessThanOrEqual(50)
    const beforeForced = health.forces()
    const forceA = health.get('?force=1'), forceB = health.get('?force=1')
    await until(() => health.forces() === beforeForced + 2)
    expect(hostExecutorSnapshot().acquires - beforeRefresh).toBe(1)
    await releaseBlockers()
    const [recovered, shared] = await Promise.all([forceA, forceB])
    expect(recovered.status).toBe(200)
    expect(recovered.health).toMatchObject({ state: 'ready', cached: false, version: process.version })
    expect(shared.health).toEqual(recovered.health)
    expect(hostExecutorSnapshot().acquires - beforeRefresh).toBe(1)
    expect((await health.get()).health).toMatchObject({ cached: true, probed_at: recovered.health.probed_at })
    expect(hostExecutorSnapshot().acquires - beforeRefresh).toBe(1)
    await health.get('?force=1')
    expect(hostExecutorSnapshot().acquires - beforeRefresh).toBe(2)

    process.env.BRIDGE_HEALTH_CACHE_MS = '0'
    process.env.BRIDGE_HEALTH_NEGATIVE_CACHE_MS = '0'
    const disabledBin = join(directory, 'uncached-agent')
    const disabled = await open('uncached-acp', disabledBin)
    const beforeDisabled = hostExecutorSnapshot().acquires
    for (let i = 0; i < 3; i++) expect((await disabled.get()).health.cached).toBe(false)
    expect(hostExecutorSnapshot().acquires - beforeDisabled).toBe(3)
    await symlink(process.execPath, disabledBin)
    for (let i = 0; i < 2; i++) expect((await disabled.get()).health).toMatchObject({ state: 'ready', cached: false })
    expect(hostExecutorSnapshot().acquires - beforeDisabled).toBe(5)
  } finally {
    await releaseBlockers()
    for (const server of servers) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await until(() => hostExecutorSnapshot().in_flight === 0 && hostExecutorSnapshot().queued === 0)
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
