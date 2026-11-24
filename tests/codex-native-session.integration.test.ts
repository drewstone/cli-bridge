/**
 * A retained Codex session through the real Bridge listener. The Bridge starts `codex app-server` through its real
 * spawner, unjailed and inside the bwrap fs-jail, on the Router route (CODEX_TANGLE_ROUTER_URL and the Router key),
 * with an empty Codex home: no Codex login exists, so no subscription seat can be used. The server is
 * tests/fixtures/codex-app-server.cjs, which speaks the JSON-RPC subset and turn semantics measured on Codex 0.169.0;
 * no model is called. Covers continuation across turns on one server, the launch (Router route, profile MCP servers,
 * approval policy), a steer into the running turn, command and MCP tool approvals answered by interaction policy,
 * per-call usage, and cancel.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const BEARER = 'codex-native-session'
const MODEL = 'codex/tangle/canary-echo'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'codex-app-server.cjs')
const BWRAP = await new LinuxBwrapJail().isAvailable()

type Event = Record<string, any>

for (const variant of [
  { name: 'unjailed', env: {}, skip: false },
  { name: 'inside the fs-jail', env: { BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none', BRIDGE_JAIL_FALLBACK: 'deny' }, skip: !BWRAP },
]) describe.skipIf(variant.skip)(`retained Codex session, ${variant.name}`, () => {
  let root: string, bridge: BridgeServer
  let counter = 0
  const open: string[] = []

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-native-')))
    // Beside the workspaces, never their ancestor: the jail refuses to expose a workspace's parent.
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'work'))
    await mkdir(join(root, 'codex-home'))
    const bin = join(root, 'bin', 'codex')
    await writeFile(bin, `#!${process.execPath}\n${await readFile(FIXTURE, 'utf8')}`, { mode: 0o700 })
    // The Router route the scripted axis uses; the operator's Codex home holds no login.
    vi.stubEnv('CODEX_TANGLE_ROUTER_URL', 'https://router.invalid/v1')
    vi.stubEnv('TANGLE_API_KEY', 'router-key-for-the-fixture')
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
    bridge = await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin, ...variant.env }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
  }, 60_000)
  afterEach(async () => {
    for (const id of open.splice(0)) await call(`/v1/sessions/${id}/close`, {})
  })
  afterAll(async () => {
    await bridge?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const call = async (path: string, body?: unknown) => await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const session = async (policy = 'unattended-allow', extra: Record<string, unknown> = {}) => {
    const id = `codex-native-${++counter}`
    open.push(id)
    const cwd = await mkdtemp(join(root, 'work', 'session-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, interaction_policy: policy, ...extra })
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
  const fixtureLog = async (cwd: string) => (await readFile(join(cwd, 'codex-fixture.log'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Event)

  it('advertises native Codex sessions with permission interactions', async () => {
    const document = await (await call(`/v1/capabilities?model=${encodeURIComponent(MODEL)}`)).json() as Event
    expect(document.sessions).toMatchObject({ continue: true, list: true, messages: true })
    expect(document.interactions?.kinds).toEqual(['permission'])
  })

  it('continues one thread across turns on one app-server, launched on the Router route with the profile MCP servers', async () => {
    const profile = { name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: '/nonexistent/mcp.cjs' }] } } }
    const { id, cwd } = await session('unattended-allow', { agent_profile: profile })
    const first = await settle(await turn(id, 'remember kiwi-417'))
    expect(first.status, JSON.stringify(first.events.slice(-3))).toBe('done')
    expect(first.text).toBe('OK')
    const second = await settle(await turn(id, 'recall'))
    expect(second.status, JSON.stringify(second.events.slice(-3))).toBe('done')
    expect(second.text).toBe('you said kiwi-417')
    expect(second.events.some((event) => event.type === 'status' && event.status === 'processing')).toBe(true)
    // One model call's usage, with Codex's cached input split out.
    const usage = second.events.map((event) => event.event).filter((event) => event?.type === 'usage')
    expect(usage.map((event) => event.usage)).toEqual([{ inputTokens: 13, outputTokens: 3, reasoningTokens: 0, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 }])

    const entries = await fixtureLog(cwd)
    const launches = entries.filter((entry) => entry.launched)
    expect(launches).toHaveLength(1)
    const launch = launches[0]!
    // The Router route with its key by env name, the profile's MCP server, and no Codex login in the home.
    expect(launch.argv[0]).toBe('app-server')
    expect(launch.argv.join(' ')).toContain('--listen stdio://')
    // A jailed server gets the jail's access-only auth seed, stored in its file, as a jailed one-shot does.
    if (variant.name !== 'unjailed') expect(launch.argv).toContain('cli_auth_credentials_store="file"')
    expect(launch.argv).toContain('model_provider = "tangle-router"')
    expect(launch.argv).toContain('model = "tangle/canary-echo"')
    expect(launch.argv.find((arg: string) => arg.startsWith('model_providers.tangle-router'))).toContain('env_key = "TANGLE_API_KEY"')
    expect(launch.routerKey).toBe(true)
    expect(launch.authFile).toBe(false)
    expect(launch.mcpServers).toEqual(['conformance'])
    const started = entries.filter((entry) => entry.method === 'thread/start')
    expect(started).toHaveLength(1)
    expect(started[0]!.params).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'danger-full-access', cwd })
    // Both turns ran in the one thread the server started.
    const threads = entries.filter((entry) => entry.method === 'turn/start').map((entry) => entry.params.threadId)
    expect(threads).toHaveLength(2)
    expect(new Set(threads).size).toBe(1)
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
    // The tool ran to its end before Codex took the steer.
    const tool = settled.events.filter((event) => event.type === 'message.part.updated' && event.part?.type === 'tool')
    expect(tool.map((event) => [event.part.tool, event.part.state.status])).toEqual([['conformance_wait_seconds', 'running'], ['conformance_wait_seconds', 'completed']])
  }, 60_000)

  it('answers command and MCP tool approvals by the session policy', async () => {
    const allowed = await session('unattended-allow')
    const ran = await settle(await turn(allowed.id, 'run allowed.txt'))
    expect(ran.text).toBe('RAN')
    expect(await readFile(join(allowed.cwd, 'allowed.txt'), 'utf8')).toBe('written')
    expect(ran.events.some((event) => event.type === 'warning' && event.code === 'interaction_answered_by_policy')).toBe(true)
    const tool = await settle(await turn(allowed.id, 'mcp n-1'))
    expect(tool.text).toBe('Tool write_nonce returned: nonce n-1 written')

    const denied = await session('unattended-deny')
    const refused = await settle(await turn(denied.id, 'run denied.txt'))
    expect(refused.text).toBe('REFUSED')
    await expect(readFile(join(denied.cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fixtureLog(denied.cwd)).find((entry) => entry.approval === 'command')?.answer).toEqual({ decision: 'decline' })
    const refusedTool = await settle(await turn(denied.id, 'mcp n-2'))
    expect(refusedTool.text).toBe('REFUSED')
    expect((await fixtureLog(denied.cwd)).find((entry) => entry.approval === 'mcp')?.answer).toMatchObject({ action: 'decline' })
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
      const pid = (await fixtureLog(cwd)).find((entry) => entry.launched)!.pid as number
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      for (let attempt = 0; attempt < 50 && alive(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(alive()).toBe(false)
    }
  }, 60_000)
})
