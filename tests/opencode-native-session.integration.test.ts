/**
 * A retained opencode session through the real Bridge listener. The Bridge starts `opencode serve`
 * through its real spawner, unjailed and inside the bwrap fs-jail (its own network namespace), and
 * reaches it over the unix-socket shim. The server is tests/fixtures/opencode-serve.cjs, which
 * speaks the v1 HTTP API and loop semantics measured on opencode 1.19.6; no model is called.
 * Covers continuation across turns, a steer into the running turn, a permission prompt answered
 * by interaction policy, per-step usage, and cancel.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const BEARER = 'opencode-native-session'
const MODEL = 'opencode/fixture/m'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'opencode-serve.cjs')
const BWRAP = await new LinuxBwrapJail().isAvailable()

type Event = Record<string, any>

for (const variant of [
  { name: 'unjailed', env: {}, skip: false },
  { name: 'inside the fs-jail', env: { BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none', BRIDGE_JAIL_FALLBACK: 'deny' }, skip: !BWRAP },
]) describe.skipIf(variant.skip)(`retained opencode session, ${variant.name}`, () => {
  let root: string, bridge: BridgeServer
  let counter = 0
  const open: string[] = []

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-native-')))
    // Beside the workspaces, never their ancestor: the jail refuses to expose a workspace's parent.
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'opencode')
    await writeFile(bin, `#!${process.execPath}\n${await readFile(FIXTURE, 'utf8')}`, { mode: 0o700 })
    await mkdir(join(root, 'work'))
    bridge = await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'opencode', OPENCODE_BIN: bin, ...variant.env }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
  }, 60_000)
  afterEach(async () => {
    for (const id of open.splice(0)) await call(`/v1/sessions/${id}/close`, {})
  })
  afterAll(async () => {
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
  })

  const call = async (path: string, body?: unknown) => await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const session = async (policy = 'unattended-allow') => {
    const id = `opencode-native-${++counter}`
    open.push(id)
    const cwd = await mkdtemp(join(root, 'work', 'session-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, interaction_policy: policy })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    return { id, cwd }
  }

  const turn = async (id: string, message: string) => {
    const turnId = `${id}-turn-${++counter}`
    const response = await call(`/v1/sessions/${id}/turns`, { message, turn_id: turnId, run_id: `${turnId}-run`, execution_id: `${turnId}-execution` })
    const body = await response.json() as Event
    expect(response.status, JSON.stringify(body)).toBeLessThan(300)
    return String(body.run.id)
  }

  /** A run's canonical events until its terminal status, then its terminal snapshot. */
  const settle = async (runId: string) => {
    const events: Event[] = []
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 45_000)
    try {
      const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: { authorization: `Bearer ${BEARER}` }, signal: controller.signal,
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      reading: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          let event: Event
          try { event = JSON.parse(line.slice(5)) } catch { continue }
          const inner = event.event ?? event
          events.push(inner)
          if (inner.type === 'status' && ['completed', 'failed', 'cancelled'].includes(inner.status)) break reading
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await (await call(`/v1/runs/${encodeURIComponent(runId)}`)).json() as { terminal?: boolean; status?: string }
      if (snapshot.terminal) return { events, status: snapshot.status, text: textOf(events) }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`run ${runId} reported no terminal snapshot; events: ${JSON.stringify(events.map((event) => event.type))}`)
  }

  const textOf = (events: Event[]) => events
    .filter((event) => event.type === 'message.part.updated' && event.part?.type === 'text' && typeof event.delta === 'string')
    .map((event) => event.delta).join('')
  const fixtureLog = async (cwd: string) => (await readFile(join(cwd, 'opencode-fixture.log'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Event)

  it('continues the native session across turns, with the model, usage and the server password', async () => {
    const { id, cwd } = await session()
    const first = await settle(await turn(id, 'remember kiwi-417'))
    expect(first.status).toBe('done')
    expect(first.text).toBe('OK')
    const second = await settle(await turn(id, 'recall'))
    expect(second.status, JSON.stringify(second.events.slice(-3))).toBe('done')
    expect(second.text).toBe('you said kiwi-417')
    // The prompt and the recall are user messages: neither reaches the output.
    expect(second.events.some((event) => event.type === 'status' && event.status === 'processing')).toBe(true)
    const usage = second.events.map((event) => event.event).find((event) => event?.type === 'usage')
    expect(usage?.usage).toMatchObject({ inputTokens: 13, outputTokens: 3, cacheReadInputTokens: 2 })

    const requests = await fixtureLog(cwd)
    expect(requests.filter((entry) => entry.method).every((entry) => entry.authorized)).toBe(true)
    // One server, one opencode session, created unattended (question and plan tools denied), two prompts.
    expect(requests.filter((entry) => entry.listening)).toHaveLength(1)
    const created = requests.filter((entry) => entry.method === 'POST' && entry.path === '/session')
    expect(created).toHaveLength(1)
    expect(created[0]!.body.permission).toEqual(expect.arrayContaining([{ permission: 'question', pattern: '*', action: 'deny' }]))
    const prompts = requests.filter((entry) => entry.path?.endsWith('/prompt_async'))
    expect(prompts.map((entry) => entry.body.model)).toEqual([{ providerID: 'fixture', modelID: 'm' }, { providerID: 'fixture', modelID: 'm' }])
  }, 60_000)

  it('delivers a steer to the running turn, whose answer then follows', async () => {
    const { id } = await session()
    const runId = await turn(id, 'wait 4')
    // A steer names the exact run, whose coordinates the run status carries as X-Run-* headers.
    const status = await call(`/v1/runs/${encodeURIComponent(runId)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const run = { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'),
      environmentId: header('environment-id'), sessionId: header('session-id'), executionId: header('execution-id') }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const steer = await call(`/v1/sessions/${id}/steer`, { operationId: `${id}-steer`, run, message: 'steered-plum-88' })
    expect(steer.status, await steer.clone().text()).toBe(200)
    const settled = await settle(runId)
    expect(settled.status).toBe('done')
    expect(settled.text).toBe('ECHO(steered-plum-88)')
    const receipt = settled.events.map((event) => event.event).find((event) => event?.type === 'steer')
    expect(receipt).toMatchObject({ operationId: `${id}-steer`, state: 'applied' })
    // The tool ran to its end before the loop took the steer, as opencode's does.
    const tool = settled.events.filter((event) => event.type === 'message.part.updated' && event.part?.type === 'tool')
    expect(tool.map((event) => event.part.state.status)).toEqual(['running', 'completed'])
  }, 60_000)

  it('answers a permission prompt by the session policy', async () => {
    const allowed = await session('unattended-allow')
    const wrote = await settle(await turn(allowed.id, 'write allowed.txt'))
    expect(wrote.text).toBe('WROTE')
    expect(await readFile(join(allowed.cwd, 'allowed.txt'), 'utf8')).toBe('written')
    expect(wrote.events.some((event) => event.type === 'warning' && event.code === 'interaction_answered_by_policy')).toBe(true)

    const denied = await session('unattended-deny')
    const refused = await settle(await turn(denied.id, 'write denied.txt'))
    expect(refused.text).toBe('REFUSED')
    expect((await fixtureLog(denied.cwd)).find((entry) => entry.path?.startsWith('/permission/'))?.body).toEqual({ reply: 'reject' })
  }, 60_000)

  it('cancels a running turn and stops the server', async () => {
    const { id, cwd } = await session()
    const runId = await turn(id, 'wait 60')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const cancelled = await call(`/v1/runs/${encodeURIComponent(runId)}/cancel?wait_ms=20000`, {})
    expect(cancelled.status, await cancelled.clone().text()).toBeLessThan(300)
    let snapshot: { terminal?: boolean; status?: string } = {}
    for (let attempt = 0; attempt < 100 && !snapshot.terminal; attempt++) {
      snapshot = await (await call(`/v1/runs/${encodeURIComponent(runId)}`)).json() as typeof snapshot
      if (!snapshot.terminal) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(snapshot.status).toBe('cancelled')
    if (variant.name === 'unjailed') {
      // Inside the jail the logged pid is in the jail's own pid namespace.
      const pid = (await fixtureLog(cwd)).find((entry) => entry.listening)!.pid as number
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      for (let attempt = 0; attempt < 50 && alive(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(alive()).toBe(false)
    }
  }, 60_000)
})
