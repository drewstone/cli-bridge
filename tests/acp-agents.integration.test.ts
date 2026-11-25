/**
 * Copilot CLI, Qwen Code and Grok CLI through a real Bridge listener and the host spawner, against a
 * synthetic agent per CLI that keeps each one's measured rules (acp-agents.ts): Copilot loads MCP
 * servers only from `--additional-mcp-config @<file>` and reports usage totals for its process; Qwen
 * reports each model call's usage on a message chunk; Grok reports usage in the result's `_meta` and
 * queues a second prompt behind a running one until `session/cancel`. No model is called.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const agent = (flavor: string) => String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
const flavor = ${JSON.stringify(flavor)}
if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0) }
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const log = (entry) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ flavor, cwd: process.cwd(), ...entry }) + '\n')
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const at = process.argv.indexOf('--additional-mcp-config')
const mcpFile = at > 0 ? process.argv[at + 1].replace(/^@/, '') : null
log({ method: 'launch', args: process.argv.slice(2), blocking: process.env.QWEN_CODE_LEGACY_MCP_BLOCKING ?? null,
  route: process.env.COPILOT_PROVIDER_BASE_URL ?? process.env.GROK_MODELS_BASE_URL ?? null, mcpFile,
  mcpConfig: mcpFile ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : null })
const say = (sessionId, text, extra = {}) => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'm-' + Math.random().toString(16).slice(2), ...extra } } })
let total = { inputTokens: 0, outputTokens: 0 }, held = null
const queued = []
const answer = (id, sessionId, text) => {
  say(sessionId, 'echo ' + text)
  if (flavor === 'copilot') {
    total = { inputTokens: total.inputTokens + 10, outputTokens: total.outputTokens + 2 }
    return send({ id, result: { stopReason: 'end_turn', usage: { ...total, totalTokens: total.inputTokens + total.outputTokens } } })
  }
  if (flavor === 'qwen') {
    say(sessionId, '', { _meta: { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  return send({ id, result: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 5, outputTokens: 1 } } } })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line), params = message.params || {}
  log({ method: message.method, params })
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  if (message.method === 'session/new') return send({ id: message.id, result: { sessionId: flavor + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) } })
  if (message.method === 'session/load') return send({ id: message.id, result: {} })
  if (message.method === 'session/cancel') {
    if (held) send({ id: held, result: { stopReason: 'cancelled' } })
    held = null
    const next = queued.shift()
    if (next) answer(next.id, next.sessionId, next.text)
    return
  }
  if (message.method === 'session/prompt') {
    const text = params.prompt[0].text
    if (held !== null) {
      // Grok queues a second prompt behind the running one; Copilot and Qwen end the running one and answer it.
      if (flavor === 'grok') return void queued.push({ id: message.id, sessionId: params.sessionId, text })
      send({ id: held, result: { stopReason: 'cancelled' } })
      held = null
      return answer(message.id, params.sessionId, text)
    }
    if (text === 'hold') { held = message.id; return }
    return answer(message.id, params.sessionId, text)
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'method not found' } })
})
`

type Call = { flavor: string; cwd: string; method: string; params?: Record<string, any>; args?: string[]; blocking?: string | null
  route?: string | null; mcpFile?: string | null; mcpConfig?: Record<string, any> | null }
type Event = Record<string, any>

const COPILOT_ROUTE = 'http://127.0.0.1:9/copilot/v1'
const GROK_ROUTE = 'http://127.0.0.1:9/grok/v1'

describe('Copilot CLI, Qwen Code and Grok CLI over ACP through the Bridge', () => {
  let root: string, bridge: BridgeServer
  const saved = { copilot: process.env.COPILOT_PROVIDER_BASE_URL, grok: process.env.GROK_MODELS_BASE_URL }
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'acp-agents-')))
    await mkdir(join(root, 'bin'))
    const bins: Record<string, string> = {}
    for (const flavor of ['copilot', 'qwen', 'grok']) {
      bins[flavor] = join(root, 'bin', `${flavor}.cjs`)
      await writeFile(bins[flavor]!, `#!${process.execPath}\n${agent(flavor)}`, { mode: 0o700 })
    }
    // The route variables the host allowlist drops unless the agent's launch names them.
    process.env.COPILOT_PROVIDER_BASE_URL = COPILOT_ROUTE
    process.env.GROK_MODELS_BASE_URL = GROK_ROUTE
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'github-copilot,qwen-code,grok',
      COPILOT_BIN: bins.copilot, QWEN_BIN: bins.qwen, GROK_BIN: bins.grok, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
    for (const [name, value] of [['COPILOT_PROVIDER_BASE_URL', saved.copilot], ['GROK_MODELS_BASE_URL', saved.grok]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const workspace = async (name: string) => {
    const cwd = join(root, `${name}-${randomBytes(3).toString('hex')}`)
    await mkdir(cwd)
    return cwd
  }
  const calls = async (cwd: string) => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Call).filter((call) => call.cwd === cwd)
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const runEvents = async (runId: string) => {
    const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, { signal: AbortSignal.timeout(15_000) })
    return (await response.text()).split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Event).map((event) => (event.event ?? event) as Event)
  }
  const textOf = (events: Event[]) => events
    .filter((event) => event.type === 'message.part.updated' && event.part?.type === 'text' && typeof event.delta === 'string')
    .map((event) => event.delta).join('')
  const profile = { name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: '/nonexistent/mcp.cjs' }] } } }
  const retained = async (model: string, name: string) => {
    const cwd = await workspace(name), id = `${name}-${randomBytes(3).toString('hex')}`
    const created = await post('/v1/sessions', { id, model, cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    let n = 0
    const turn = async (message: string) => {
      n += 1
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    return { id, cwd, turn }
  }

  it('runs a one-shot turn of each by its harness id, in its unattended mode, with its MCP servers where it reads them, and reports its usage', async () => {
    const rows = [
      { model: 'github-copilot', flavor: 'copilot', args: ['--acp', '--allow-all', '--additional-mcp-config'], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      { model: 'qwen-code', flavor: 'qwen', args: ['--acp', '--approval-mode', 'yolo'], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      { model: 'grok', flavor: 'grok', args: ['agent', '--always-approve', 'stdio'], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ]
    for (const row of rows) {
      const cwd = await workspace(row.flavor)
      const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: row.model, cwd, stream: false, messages: [{ role: 'user', content: 'hi' }], agent_profile: profile }),
        signal: AbortSignal.timeout(15_000) })
      const body = await response.json() as { choices?: Array<{ message: { content: string } }>; usage?: Record<string, unknown>; error?: unknown }
      expect(response.status, JSON.stringify(body.error)).toBe(200)
      expect(body.choices?.[0]?.message.content).toBe('echo hi')
      expect(body.usage, row.model).toMatchObject(row.usage)

      const mine = await calls(cwd)
      const launch = mine.find((call) => call.method === 'launch')!
      expect(launch.args?.slice(0, row.args.length)).toEqual(row.args)
      const inline = mine.find((call) => call.method === 'session/new')!.params?.mcpServers as Array<Record<string, unknown>>
      if (row.flavor === 'copilot') {
        expect(launch.route).toBe(COPILOT_ROUTE)
        expect(inline).toEqual([])
        expect(launch.mcpConfig).toMatchObject({ mcpServers: { conformance: { type: 'stdio', command: process.execPath, args: ['/nonexistent/mcp.cjs'] } } })
        expect(existsSync(launch.mcpFile!), 'the private MCP file outlived the turn').toBe(false)
      } else {
        expect(launch.mcpFile).toBeNull()
        expect(inline.map((server) => server.name)).toEqual(['conformance'])
      }
      if (row.flavor === 'qwen') expect(launch.blocking).toBe('1')
      if (row.flavor === 'grok') expect(launch.route).toBe(GROK_ROUTE)
    }
  }, 60_000)

  it('reports what each Copilot prompt added to the usage totals its process reports', async () => {
    const session = await retained('github-copilot', 'copilot-usage')
    const usage = async (message: string) => (await runEvents(await session.turn(message)))
      .filter((event) => event.type === 'usage').map((event) => [event.usage?.inputTokens, event.usage?.outputTokens])
    expect(await usage('one')).toEqual([[10, 2]])
    expect(await usage('two')).toEqual([[10, 2]])
    // A retained session runs without the unattended flag: the turn's interaction policy answers permissions.
    expect((await calls(session.cwd)).find((call) => call.method === 'launch')?.args).toEqual(['--acp'])
    await post(`/v1/sessions/${session.id}/close`, {})
  }, 40_000)

  it('steers a running Grok turn by cancelling it first, since Grok queues a second prompt', async () => {
    const session = await retained('grok', 'grok-steer')
    const running = await session.turn('hold')
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const steered = await post(`/v1/sessions/${session.id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'turn left',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    expect(textOf(await runEvents(running))).toBe('echo turn left')
    const mine = await calls(session.cwd)
    expect(mine.find((call) => call.method === 'launch')?.args).toEqual(['agent', 'stdio'])
    const order = mine.filter((call) => call.method === 'session/cancel' || (call.method === 'session/prompt' && call.params?.prompt?.[0]?.text === 'turn left'))
      .map((call) => call.method)
    expect(order).toEqual(['session/cancel', 'session/prompt'])
    await post(`/v1/sessions/${session.id}/close`, {})
  }, 40_000)
})
