/**
 * A retained Gemini session through a real Bridge listener and the host spawner, against a synthetic
 * `gemini --acp` that answers as Gemini CLI 0.68 was recorded to: message chunks without a `messageId`,
 * a `session/request_permission` for each tool call, and a prompt that arrives while another runs
 * ending it (its tool call `failed` with "Tool call aborted", its answer `cancelled`). No model is called.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const agent = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('0.68.0-fixture'); process.exit(0) }
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const record = (entry) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ pid: process.pid, ...entry }) + '\n')
record({ launch: process.argv.slice(2), env: Object.fromEntries(
  ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_UNRELATED'].map((key) => [key, process.env[key] ?? null])) })
if (!process.argv.includes('--acp')) process.exit(64)
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } })
const answers = []
let running = null, asked = 0
const endRunning = () => {
  update(running.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: running.toolCallId, status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'Tool call aborted' } }], kind: 'other' })
  send({ id: running.id, result: { stopReason: 'cancelled' } })
  running = null
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) return record({ permission: message.result && message.result.outcome })
  record({ method: message.method, params: message.params })
  const params = message.params || {}
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1,
    authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key' }], agentInfo: { name: 'gemini-cli', version: '0.68.0' },
    agentCapabilities: { loadSession: true } } })
  if (message.method === 'session/new') return send({ id: message.id, result: { sessionId: 'fixture-' + process.pid, modes: { currentModeId: 'default' } } })
  if (message.method === 'session/cancel') { if (running) endRunning(); return }
  if (message.method !== 'session/prompt') return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  const text = params.prompt[0].text
  if (running) endRunning()
  if (text === 'wait') {
    const toolCallId = 'mcp_conformance_wait_seconds__call_' + (++asked), title = 'wait_seconds(seconds: 40)'
    running = { id: message.id, sessionId: params.sessionId, toolCallId }
    update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId, status: 'pending', title, content: [], locations: [], kind: 'other' })
    return send({ id: 1000 + asked, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCall: { toolCallId, title },
      options: [{ optionId: 'proceed_always_server', name: 'Always allow the server', kind: 'allow_always' }, { optionId: 'proceed_always_tool', name: 'Always allow the tool', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }] } })
  }
  const answer = text === 'repeat' ? (answers[answers.length - 1] || 'nothing') : 'echo ' + text
  answers.push(answer)
  update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } })
  update(params.sessionId, { sessionUpdate: 'usage_update', used: 1290, size: 1048576 })
  send({ id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 } } })
})
`

describe('a retained Gemini session through the Bridge', () => {
  const route = { GEMINI_API_KEY: 'fixture-key', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9/router', GEMINI_UNRELATED: 'stays with the Bridge' }
  const saved = [...Object.keys(route), 'GEMINI_CLI_TRUST_WORKSPACE'].map((name) => [name, process.env[name]] as const)
  let root: string, bridge: BridgeServer
  beforeAll(async () => {
    Object.assign(process.env, route)
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE
    root = await realpath(await mkdtemp(join(tmpdir(), 'gemini-native-')))
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'gemini.cjs')
    await writeFile(bin, `#!${process.execPath}\n${agent}`, { mode: 0o700 })
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'gemini', GEMINI_BIN: bin,
      BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  type Call = { pid: number; launch?: string[]; env?: Record<string, string | null>; method?: string; params?: Record<string, any>; permission?: Record<string, unknown> }
  const calls = async () => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Call)
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  /** A run's events, read to its end. */
  const runEvents = async (runId: string) => {
    const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, { signal: AbortSignal.timeout(15_000) })
    return (await response.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => {
      const event = JSON.parse(line.slice(5)) as Record<string, any>
      return (event.event ?? event) as Record<string, any>
    })
  }
  const textOf = (events: Array<Record<string, any>>) => events
    .filter((event) => event.type === 'message.part.updated' && event.part?.type === 'text' && typeof event.delta === 'string').map((event) => event.delta).join('')
  /** The steer receipts a run carries: raw events from the agent session. */
  const steersOf = (events: Array<Record<string, any>>) => events.filter((event) => event.type === 'raw' && event.event?.type === 'steer').map((event) => event.event)
  const open = async (name: string) => {
    const cwd = join(root, `${name}-${randomBytes(3).toString('hex')}`), id = `${name}-${randomBytes(3).toString('hex')}`
    await mkdir(cwd)
    const created = await post('/v1/sessions', { id, model: 'gemini/fixture-model', cwd, interaction_policy: 'unattended-allow',
      agent_profile: { name: 'fixture', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: join(cwd, 'server.cjs') }] } } } })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    /** The calls of this session's one process, found by the workspace its `session/new` names. */
    const mine = async () => {
      const all = await calls()
      const pid = all.find((call) => call.method === 'session/new' && call.params?.cwd === cwd)?.pid
      return all.filter((call) => call.pid === pid)
    }
    return { id, cwd, turn, mine }
  }

  it('keeps one `gemini --acp` across turns, started with the model, the API route, the workspace trust and the profile\'s MCP server', async () => {
    const session = await open('retained')
    expect(textOf(await runEvents(await session.turn(1, 'first')))).toBe('echo first')
    expect(textOf(await runEvents(await session.turn(2, 'repeat')))).toBe('echo first')
    const mine = await session.mine()
    const launches = mine.filter((call) => call.launch)
    expect(launches).toHaveLength(1)
    // No approval mode: the CLI asks, and the turn's interaction policy answers.
    expect(launches[0]!.launch).toEqual(['--acp', '--model', 'fixture-model'])
    expect(launches[0]!.env).toEqual({ GEMINI_API_KEY: 'fixture-key', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9/router',
      GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_UNRELATED: null })
    const created = mine.filter((call) => call.method === 'session/new')
    expect(created).toHaveLength(1)
    expect(created[0]!.params!.mcpServers).toEqual([{ name: 'conformance', command: process.execPath, args: [join(session.cwd, 'server.cjs')], env: [] }])
    expect(mine.filter((call) => call.method === 'session/prompt').map((call) => call.params!.prompt[0].text)).toEqual(['first', 'repeat'])
    await post(`/v1/sessions/${session.id}/close`, {})
  }, 40_000)

  it('steers with a second prompt: the running tool call is aborted and the turn goes on with the steer\'s answer', async () => {
    const session = await open('steer')
    const running = await session.turn(1, 'wait')
    // The tool call asked permission and the session's policy allowed it once; the call is now running.
    let allowed: Call | undefined
    for (const end = Date.now() + 10_000; !allowed && Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
      allowed = (await session.mine().catch(() => [])).find((call) => call.permission)
    }
    expect(allowed?.permission).toEqual({ outcome: 'selected', optionId: 'proceed_once' })
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const operationId = `steer-${randomBytes(3).toString('hex')}`
    const steered = await post(`/v1/sessions/${session.id}/steer`, { operationId, message: 'turn left',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    const events = await runEvents(running)
    expect(textOf(events)).toBe('echo turn left')
    expect(JSON.stringify(events)).toContain('Tool call aborted')
    expect(steersOf(events)).toEqual([{ type: 'steer', operationId, state: 'applied' }])
    // The same agent session takes the next turn, with the steer's answer in its history.
    expect(textOf(await runEvents(await session.turn(2, 'repeat')))).toBe('echo turn left')
    const mine = await session.mine()
    expect(mine.filter((call) => call.launch)).toHaveLength(1)
    const prompts = mine.filter((call) => call.method === 'session/prompt')
    expect(prompts.map((call) => call.params!.prompt[0].text)).toEqual(['wait', 'turn left', 'repeat'])
    expect(new Set(prompts.map((call) => call.params!.sessionId)).size).toBe(1)
    expect(mine.filter((call) => call.method === 'session/cancel')).toEqual([])
    await post(`/v1/sessions/${session.id}/close`, {})
  }, 40_000)
})
