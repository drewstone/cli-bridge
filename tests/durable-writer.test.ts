import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import { mountHealth } from '../src/routes/health.js'
import { RunRegistry } from '../src/runs/registry.js'
import { DurableRunWriter } from '../src/sessions/durable-writer.js'
import { SessionStore } from '../src/sessions/store.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-durable-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = new SessionStore(dir)
  cleanup.push(() => store.close())
  const runs = new RunRegistry()
  cleanup.push(() => runs.shutdown())
  return { dir, store, runs }
}

it('keeps HTTP responsive while FULL WAL writes wait, bounds pending work, and reopens acknowledged evidence', async () => {
  const { dir, store, runs } = fixture()
  const writer = new DurableRunWriter(dir, { maxBytes: 1_048_576, maxRequests: 1 })
  await writer.open()
  cleanup.push(() => writer.close())
  const lock = new Database(join(dir, 'sessions.sqlite'))
  cleanup.push(() => { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() })
  const { run } = runs.claim('pressure', 'digest', {
    commitDelta: (input) => writer.commit({ method: 'appendRetainedDelta', args: ['session', input] }),
    commitSnapshot: (snapshot) => writer.commit({ method: 'updateRetainedRun', args: ['pressure', 'digest', snapshot] }),
  })
  store.claimRetainedRun({
    owner: 'one-shot', runId: run.id, sessionId: 'session', executionId: 'execution',
    requestDigest: 'digest', provider: 'fixture', environmentId: 'isolated', snapshot: run.snapshot(),
  })
  const app = new Hono()
  const registry = new BackendRegistry()
  registry.register({
    name: 'fixture', matches: () => true,
    health: async () => ({ name: 'fixture', state: 'ready' as const }),
    async *chat() { yield { content: 'fixture' } },
  })
  mountHealth(app, { registry, runs })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  lock.exec('BEGIN IMMEDIATE')
  const pump = run.pump((async function* () {
    for (let n = 0; n < 16; n++) yield { content: String(n).padEnd(8192, '.') }
    yield { finish_reason: 'stop' as const }
  })())
  await tick()
  expect(writer.snapshot().pendingRequests).toBe(1)
  expect(run.snapshot().lastSeq).toBe(0)
  await expect(writer.commit({ method: 'appendRetainedDelta', args: ['overflow', { runId: 'overflow', sequence: 1, delta: {} }] }))
    .rejects.toThrow('capacity exhausted')
  const latencies: number[] = []
  for (let n = 0; n < 8; n++) {
    const start = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    latencies.push(performance.now() - start)
  }
  expect(Math.max(...latencies)).toBeLessThan(500)
  expect(run.snapshot().lastSeq).toBe(0)
  expect(run.isTerminal()).toBe(false)
  expect(writer.snapshot().pendingRequests).toBe(1)
  lock.exec('ROLLBACK')
  await pump
  expect(run.snapshot()).toMatchObject({ status: 'done', lastSeq: 17, terminal: true })
  await writer.close()
  const reopened = new SessionStore(dir)
  try {
    expect(reopened.retainedEventsAfterRun('session', 'pressure')).toHaveLength(17)
    expect(reopened.getRetainedRun('pressure')?.snapshot).toMatchObject({ terminal: true, status: 'done', lastSeq: 17 })
  } finally { reopened.close() }
  console.info(JSON.stringify({ kind: 'blocked-wal-health', samples: latencies.length, maxLatencyMs: Math.max(...latencies), pendingBound: 1, retainedEvents: 17 }))
}, 15_000)

it('does not expose a delta or terminal state before both durable acknowledgements', async () => {
  const { runs } = fixture()
  const event = deferred()
  const checkpoint = deferred()
  const terminal = deferred()
  const { run } = runs.claim('ack-order', 'digest', {
    commitDelta: () => event.promise,
    commitSnapshot: (snapshot) => snapshot.terminal ? terminal.promise : checkpoint.promise,
  })
  const pump = run.pump((async function* () { yield { content: 'verified only after commit' } })())
  const reader = run.attach()
  let published = false
  const next = reader.next().then((result) => { published = true; return result })
  await tick()
  expect(run.snapshot().lastSeq).toBe(0)
  event.resolve()
  await tick()
  expect(run.snapshot().lastSeq).toBe(0)
  expect(published).toBe(false)
  checkpoint.resolve()
  expect((await next).value?.delta.content).toBe('verified only after commit')
  await tick()
  expect(run.isTerminal()).toBe(false)
  let settled = false
  const done = run.whenTerminal().then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  expect(run.cancel()).toBe(false)
  terminal.resolve()
  await pump
  await done
  expect(run.snapshot().status).toBe('done')
  await reader.return(undefined)
})

it('reports unknown and publishes no unacknowledged output after a commit failure', async () => {
  const { runs } = fixture()
  const { run } = runs.claim('failed', 'digest', {
    commitDelta: async () => { throw new Error('storage unavailable') },
    commitSnapshot: async () => { throw new Error('storage unavailable') },
  })
  await run.pump((async function* () { yield { content: 'must remain hidden' } })())
  expect(run.snapshot()).toMatchObject({ status: 'unknown', lastSeq: 0, terminal: true })
  expect(run.failure()).toMatchObject({ message: 'storage unavailable' })
  const output = []
  for await (const item of run.attach()) output.push(item)
  expect(output).toEqual([])
})

it('fails closed on a worker database error and rejects an oversized pending write', async () => {
  const { dir } = fixture()
  const writer = new DurableRunWriter(dir, { maxBytes: 1024, maxRequests: 2 })
  await writer.open()
  cleanup.push(() => writer.close())
  await expect(writer.commit({ method: 'updateRetainedRun', args: ['absent', 'digest', {}] })).rejects.toThrow('not bound')
  await expect(writer.commit({ method: 'appendRetainedDelta', args: ['session', { runId: 'r', sequence: 1, delta: { content: '.'.repeat(2048) } }] }))
    .rejects.toThrow('capacity exhausted')
  expect(writer.snapshot()).toEqual({ pendingRequests: 0, pendingBytes: 0 })
})

it('uses the worker through the chat endpoint and replays persisted output without another backend call', async () => {
  const { dir, store, runs } = fixture()
  const writer = new DurableRunWriter(dir)
  await writer.open()
  cleanup.push(() => writer.close())
  let calls = 0
  const registry = new BackendRegistry().register({
    name: 'durable-fixture', matches: (model) => model === 'durable-fixture',
    health: async () => ({ name: 'durable-fixture', state: 'ready' as const }),
    async *chat() {
      calls++
      yield { content: 'one' }
      yield { content: 'two' }
      yield { finish_reason: 'stop' as const }
    },
  })
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions: store, retainedRuns: store, runs, durableWriter: writer })
  const request = {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-run-id': 'worker-http' },
    body: JSON.stringify({ model: 'durable-fixture', messages: [{ role: 'user', content: 'fixture' }] }),
  }
  const result = await app.request('/v1/chat/completions', request)
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ choices: [{ message: { content: 'onetwo' } }] })
  expect(store.getRetainedRun('worker-http')?.snapshot).toMatchObject({ terminal: true, status: 'done' })
  const restartedRuns = new RunRegistry()
  cleanup.push(() => restartedRuns.shutdown())
  const restarted = new Hono()
  mountChatCompletions(restarted, { registry, sessions: store, retainedRuns: store, runs: restartedRuns, durableWriter: writer })
  const replay = await restarted.request('/v1/chat/completions', request)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ choices: [{ message: { content: 'onetwo' } }] })
  expect(calls).toBe(1)
})

it('commits valid batched writes even when a neighboring request fails', () => {
  const { store } = fixture()
  const outcomes = store.commitRetainedRunWrites([
    { method: 'appendRetainedDelta', args: ['batch', { runId: 'batch', sequence: 1, delta: { content: 'first' } }] },
    { method: 'updateRetainedRun', args: ['missing', 'digest', {}] },
    { method: 'appendRetainedDelta', args: ['batch', { runId: 'batch', sequence: 2, delta: { content: 'second' } }] },
  ])
  expect(outcomes[0]).toEqual({})
  expect(outcomes[1]?.error).toContain('not bound')
  expect(outcomes[2]).toEqual({})
  expect(store.retainedEventsAfterRun('batch', 'batch').map((row) => row.envelope.sequence)).toEqual([1, 2])
})

it('keeps a lifetime expiry as error when abort races a delayed durable write', async () => {
  const runs = new RunRegistry({ maxLifetimeMs: 30 })
  cleanup.push(() => runs.shutdown())
  const terminalStatuses: string[] = []
  const { run } = runs.claim('deadline-race', 'digest', {
    commitDelta: async () => { await new Promise((resolve) => setTimeout(resolve, 30)) },
    commitSnapshot: async (snapshot) => { if (snapshot.terminal) terminalStatuses.push(snapshot.status) },
  })
  await run.pump((async function* () {
    await new Promise<void>((_resolve, reject) => run.signal.addEventListener(
      'abort', () => reject(new Error('backend aborted')), { once: true },
    ))
  })())
  expect(run.snapshot().status).toBe('error')
  expect(run.failure()).toMatchObject({ name: 'RunLifetimeExceededError' })
  expect(terminalStatuses).toEqual(['error'])
})
