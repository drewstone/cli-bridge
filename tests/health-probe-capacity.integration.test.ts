/**
 * `/health` must not report its own `--version` probes as executor load.
 *
 * Measured 2026-11-14 on agent-container #18828 (beelink2 gates b152d8c4 and
 * the instrumented replay): every embedded Bridge spawn balanced its slot, yet
 * Runtime's spawn preflight read `executor in_flight 4 of max 4` from `/health`
 * with no workload running. On that host four backends always fail their
 * probe, so each `/health` returned their cached faults and restarted four
 * background `--version` probes — which held all four host slots at the moment
 * the same response read the executor snapshot.
 */
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { AcpBackend } from '../src/backends/acp.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostExecutorSnapshot, hostSpawner } from '../src/executors/host.js'
import { mountHealth } from '../src/routes/health.js'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw new Error('health probe observation deadline exceeded'); await delay(10) }
}

test('background fault refreshes leave every executor slot to workload and report themselves as probes', async () => {
  const keys = ['BRIDGE_HEALTH_CACHE_MS', 'BRIDGE_HEALTH_NEGATIVE_CACHE_MS', 'BRIDGE_HEALTH_PROBE_TIMEOUT_MS', 'BRIDGE_HEALTH_READY_CACHE_TTL_MS'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { BRIDGE_HEALTH_CACHE_MS: '1000', BRIDGE_HEALTH_NEGATIVE_CACHE_MS: '100',
    BRIDGE_HEALTH_PROBE_TIMEOUT_MS: '5000', BRIDGE_HEALTH_READY_CACHE_TTL_MS: '0' })
  const directory = await mkdtemp(join(tmpdir(), 'bridge-probe-capacity-'))
  const hold = join(directory, 'hold')
  const max = hostExecutorSnapshot().max
  expect(max).toBeGreaterThan(0)
  expect(max).toBeLessThanOrEqual(8)
  // A real CLI that fails its probe, held open while `hold` exists.
  const bins = Array.from({ length: max }, (_, i) => join(directory, `failing-agent-${i}`))
  for (const bin of bins) {
    await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(__filename + '.started', '')
const wait = setInterval(() => { if (!fs.existsSync(${JSON.stringify(hold)})) { clearInterval(wait); process.exit(1) } }, 10)
`, { mode: 0o755 })
  }
  const registry = new BackendRegistry()
  bins.forEach((bin, i) => registry.register(new AcpBackend({ name: `failing-${i}`, bin, timeoutMs: 2000, spawner: hostSpawner })))
  const app = new Hono()
  mountHealth(app, { registry })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`
    const health = async () => (await (await fetch(url)).json()) as {
      backends: Array<{ state: string; cached: boolean }>
      executor: { in_flight: number; max: number; queued: number; probes_in_flight?: number }
    }

    const cold = await health()
    expect(cold.backends.map((b) => [b.state, b.cached])).toEqual(bins.map(() => ['error', false]))
    for (const bin of bins) await unlink(`${bin}.started`)

    // The next /health answers from the fault cache and refreshes every
    // backend in the background; the refreshes stay open on `hold`.
    await writeFile(hold, '')
    await delay(150)
    expect((await health()).backends.every((b) => b.cached)).toBe(true)
    await until(() => bins.every((bin) => existsSync(`${bin}.started`)))

    const during = await health()
    expect(during.backends.every((b) => b.cached)).toBe(true)
    expect(during.executor).toMatchObject({ in_flight: 0, max, queued: 0, probes_in_flight: max })

    // A workload spawn gets a slot at once, while every probe is still open.
    const work = await hostSpawner(process.execPath, ['--eval', '0'], { acquireDeadlineMs: 100 })
    await once(work.child, 'exit')
  } finally {
    await rm(hold, { force: true })
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await until(() => hostExecutorSnapshot().in_flight === 0 && hostExecutorSnapshot().queued === 0 && !hostExecutorSnapshot().probes_in_flight)
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

/**
 * A `--version` that never exits must not outlive `/health`'s timeout.
 *
 * Before the fix the timeout aborted the spawn through Node's `signal`, which
 * sends SIGTERM to the leader only; a binary that ignores it kept running and
 * held `probes_in_flight` forever, and the next uncached `/health` started a
 * second one beside it, one process per call.
 */
test('a wedged --version is killed after the probe timeout and never runs twice at once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-probe-wedge-'))
  const bin = join(directory, 'wedged-agent')
  const pids = join(directory, 'pids')
  await writeFile(bin, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const started = async () => existsSync(pids)
    ? (await readFile(pids, 'utf8')).split('\n').filter(Boolean).map(Number)
    : []
  const registry = new BackendRegistry()
  registry.register(new AcpBackend({ name: 'wedged', bin, timeoutMs: 2000, spawner: hostSpawner }))
  const app = new Hono()
  // cacheMs 0: every request is past the TTL and probes.
  mountHealth(app, { registry }, { cacheMs: 0, probeTimeoutMs: 200 })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`
    let maxProbes = 0
    for (let i = 0; i < 5; i += 1) {
      const body = (await (await fetch(url)).json()) as {
        backends: Array<{ state: string; detail?: string }>
        executor: { probes_in_flight: number }
      }
      expect(body.backends[0]).toMatchObject({ state: 'error', detail: 'health probe timed out after 200ms' })
      maxProbes = Math.max(maxProbes, body.executor.probes_in_flight)
      await delay(100)
    }
    expect(maxProbes).toBeLessThanOrEqual(1)
    expect((await started()).length).toBeGreaterThanOrEqual(1)
    // Timeout plus the 2 s SIGTERM grace and the 500 ms SIGKILL wait.
    await delay(200 + 2000 + 500 + 500)
    expect((await started()).filter(alive)).toEqual([])
    expect(hostExecutorSnapshot().probes_in_flight).toBe(0)
  } finally {
    for (const pid of (await started()).filter(alive)) process.kill(pid, 'SIGKILL')
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
