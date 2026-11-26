/**
 * Factory Droid through a real Bridge listener and the host spawner, against a synthetic `droid` that keeps
 * the stream-jsonrpc rules measured on Droid 1.13.0 and 1.21.0 (droid-native-session.ts): it refuses a frame
 * without its envelope, stamps its own (newer) protocol version on every frame, starts the MCP servers a
 * session request lists, titles an unnamed session with a model call it counts in the turn's usage, replaces
 * an unknown model with its own and refuses one in `update_session_settings`, queues a message sent while a
 * turn runs and applies it after the running tool call, ends a turn on `interrupt_session`, and keeps its
 * sessions on disk for `load_session` in a later process. Its MCP tools are a real stdio server's. No model
 * is called.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const droid = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), { spawn } = require('node:child_process')
if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0) }
const args = process.argv.slice(2)
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const factory = path.join(process.env.FACTORY_HOME_OVERRIDE || process.env.HOME, '.factory'), store = path.join(factory, 'sessions')
fs.mkdirSync(store, { recursive: true })
const log = (entry) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.999.0', ...frame }) + '\n')
const answer = (id, result) => send({ type: 'response', id, result })
const refuse = (id, code, message) => send({ type: 'response', id, error: { code, message } })
const id = () => require('node:crypto').randomUUID()
const models = JSON.parse(fs.readFileSync(path.join(factory, 'settings.json'), 'utf8')).customModels.map((entry) => entry.id)
log({ method: 'spawn', args })
let session = null, turn = null
const tools = new Map()
const note = (notification) => send({ type: 'notification', method: 'droid.session_notification', params: { sessionId: session && session.id, notification } })
// Droid's first frame comes before any request.
send({ type: 'notification', method: 'droid.session_notification', params: { notification: { type: 'mcp_status_changed', servers: [] } } })
const save = () => fs.writeFileSync(path.join(store, session.id + '.json'), JSON.stringify(session))
async function startMcp(servers) {
  for (const server of servers || []) {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'] })
    const pending = new Map()
    let next = 0
    readline.createInterface({ input: child.stdout }).on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply.result); pending.delete(reply.id) })
    const rpc = (method, params) => new Promise((resolve) => { pending.set(++next, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n') })
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'droid-fixture', version: '1' } })
    for (const tool of (await rpc('tools/list', {})).tools) tools.set(server.name + '___' + tool.name, (input) => rpc('tools/call', { name: tool.name, arguments: input }))
  }
}
function say(text) {
  const messageId = id()
  note({ type: 'assistant_text_delta', messageId, blockIndex: 0, textDelta: text })
  note({ type: 'assistant_text_complete', messageId, blockIndex: 0 })
  note({ type: 'create_message', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } })
  session.messages.push(text)
}
// One model call: the last instruction decides, as on the Router's scripted model.
function reply(text) {
  turn.usage.inputTokens += 10
  turn.usage.outputTokens += 2
  const exactly = /Reply with exactly (\S+)\s*$/u.exec(text)
  if (exactly) return exactly[1]
  if (text.trim() === 'Repeat your previous answer.') return session.messages[session.messages.length - 1] || 'nothing yet'
  return 'echo ' + text
}
async function run(requestId, text) {
  turn = { usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 }, queue: [], cancelled: false, cancel: () => {} }
  const turnId = id()
  note({ type: 'droid_working_state_changed', newState: 'streaming_assistant_message' })
  note({ type: 'create_message', message: { id: turnId, role: 'user', content: [{ type: 'text', text }] }, requestId })
  if (!session.titled) {
    session.titled = true
    reply(text)
    note({ type: 'session_title_updated', title: 'fixture', updateType: 'llm_generated' })
  }
  const call = /^Call the tool (\S+) with exactly (.+)$/su.exec(text)
  const name = call && [...tools.keys()].find((tool) => tool === call[1] || (call[1].startsWith('*') && tool.endsWith('___' + call[1].slice(1))))
  if (name) {
    turn.usage.inputTokens += 10
    turn.usage.outputTokens += 2
    const toolUseId = 'call_' + id().slice(0, 8), input = JSON.parse(call[2])
    note({ type: 'tool_call', toolUse: { type: 'tool_use', id: toolUseId, name, input: {} } })
    note({ type: 'tool_call', toolUse: { type: 'tool_use', id: toolUseId, name, input } })
    note({ type: 'tool_execution_phase_changed', toolUseId, toolName: name, phase: 'queued' })
    note({ type: 'tool_execution_phase_changed', toolUseId, toolName: name, phase: 'executing' })
    log({ method: 'tool.start', name })
    const result = await Promise.race([tools.get(name)(input), new Promise((resolve) => { turn.cancel = () => resolve(null) })])
    if (result) {
      const output = result.content[0].text
      note({ type: 'tool_result', toolUseId, content: output, isError: false })
      // A queued message is applied after the tool result, inside the same turn.
      const queued = turn.queue.shift()
      if (queued) {
        note({ type: 'queued_messages_changed', messages: [] })
        note({ type: 'create_message', message: { id: id(), role: 'user', content: [{ type: 'text', text: queued.text }] }, requestId: queued.requestId })
        say(reply(queued.text))
      } else {
        turn.usage.inputTokens += 10
        turn.usage.outputTokens += 2
        say('Tool ' + name + ' returned: ' + output)
      }
    }
  } else say(reply(text))
  const reason = turn.cancelled ? 'cancelled' : 'completed', usage = turn.usage
  turn = null
  save()
  log({ method: 'turn.completed', reason })
  const zero = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 }
  note({ type: 'agent_turn_completed', reason, turnId, tokenUsage: usage, childTokenUsage: zero })
  note({ type: 'droid_working_state_changed', newState: 'idle' })
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const frame = JSON.parse(line)
  log({ method: frame.method, params: frame.params, versions: [frame.factoryApiVersion, frame.factoryProtocolVersion] })
  if (frame.type !== 'request' || typeof frame.id !== 'string' || !frame.factoryApiVersion || !frame.factoryProtocolVersion)
    return send({ type: 'response', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message' } })
  const params = frame.params || {}
  if (frame.method === 'droid.initialize_session') {
    if (!params.machineId || !params.cwd) return refuse(frame.id, -32602, 'params.machineId: Required; params.cwd: Required')
    const modelId = params.modelId && models.includes(params.modelId) ? params.modelId : 'fixture-default'
    session = { id: id(), modelId, titled: false, messages: [] }
    await startMcp(params.mcpServers)
    save()
    const notices = params.modelId && modelId !== params.modelId ? [{ id: id(), role: 'system', systemNotice: true,
      content: [{ type: 'text', text: params.modelId + " isn't available on this machine. Using " + modelId + ' instead.' }] }] : []
    return answer(frame.id, { sessionId: session.id, session: { messages: notices }, settings: { modelId } })
  }
  if (frame.method === 'droid.load_session') {
    const file = path.join(store, params.sessionId + '.json')
    if (!fs.existsSync(file)) return refuse(frame.id, -32004, 'Session not found')
    session = JSON.parse(fs.readFileSync(file, 'utf8'))
    await startMcp(params.mcpServers)
    return answer(frame.id, { session: { messages: [] }, settings: { modelId: session.modelId } })
  }
  if (!session) return refuse(frame.id, -32000, 'No session')
  if (frame.method === 'droid.rename_session') { session.titled = true; save(); return answer(frame.id, { success: true }) }
  if (frame.method === 'droid.update_session_settings') {
    if (params.modelId && !models.includes(params.modelId)) return refuse(frame.id, -32602, 'Unknown model: ' + params.modelId)
    session.modelId = params.modelId || session.modelId
    return answer(frame.id, {})
  }
  if (frame.method === 'droid.add_user_message') {
    answer(frame.id, {})
    if (turn) {
      turn.queue.push({ requestId: frame.id, text: params.text })
      return note({ type: 'queued_messages_changed', messages: [{ requestId: frame.id, queuePlacement: params.queuePlacement || 'end_of_turn', text: params.text }] })
    }
    return run(frame.id, params.text)
  }
  if (frame.method === 'droid.interrupt_session') {
    if (turn) { turn.cancelled = true; turn.cancel() }
    return answer(frame.id, {})
  }
  refuse(frame.id, -32601, 'Method not found')
})
`

// The matrix's MCP server: write_nonce writes <dir>/<nonce>.nonce; wait_seconds answers after the given seconds.
const nonceServer = (dir: string) => `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'write_nonce',inputSchema:{type:'object'}},{name:'wait_seconds',inputSchema:{type:'object'}}]};else if(r.params.name==='wait_seconds'){setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'waited'}]}})+'\\n'),r.params.arguments.seconds*1000);return}else{const nonce=String(r.params.arguments.nonce);fs.writeFileSync(path.join(${JSON.stringify(dir)},nonce+'.nonce'),nonce+' '+process.env.NONCE_TAG);result={content:[{type:'text',text:'nonce '+nonce+' written'}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

type Call = { pid: number; method: string; params?: Record<string, any>; versions?: string[]; args?: string[]; reason?: string }

describe('Factory Droid on its streamed JSON-RPC mode through the Bridge', () => {
  let root: string, bridge: BridgeServer, ownMcp: string
  const saved = process.env.FACTORY_HOME_OVERRIDE
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'droid-')))
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'droid.cjs')
    await writeFile(bin, `#!${process.execPath}\n${droid}`, { mode: 0o700 })
    // The operator's own Droid home: its custom model and its own MCP server, which the Bridge never rewrites.
    const factory = join(root, 'droid-home', '.factory')
    await mkdir(factory, { recursive: true })
    await writeFile(join(factory, 'settings.json'), JSON.stringify({ customModels: [{ id: 'custom:fixture', model: 'fixture' }] }))
    ownMcp = JSON.stringify({ mcpServers: { own: { type: 'stdio', command: 'own-server' } } })
    await writeFile(join(factory, 'mcp.json'), ownMcp)
    process.env.FACTORY_HOME_OVERRIDE = join(root, 'droid-home')
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'factory-droids',
      DROID_BIN: bin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    if (saved === undefined) delete process.env.FACTORY_HOME_OVERRIDE
    else process.env.FACTORY_HOME_OVERRIDE = saved
  }, 30_000)

  const workspace = async (name: string) => {
    const cwd = join(root, `${name}-${randomBytes(3).toString('hex')}`)
    await mkdir(cwd)
    await writeFile(join(cwd, 'nonce-mcp.cjs'), nonceServer(cwd))
    return cwd
  }
  const profile = (cwd: string) => ({ name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath,
    args: [{ kind: 'public', value: join(cwd, 'nonce-mcp.cjs') }], env: { NONCE_TAG: { kind: 'public', value: 'tagged' } } } } })
  const calls = async (match: (call: Call) => boolean = () => true) => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Call).filter(match)
  // The Droid processes the Bridge started for a workspace, in order.
  const processes = async (cwd: string) => (await calls((call) => call.method === 'spawn' && call.args!.includes(cwd))).map((call) => call.pid)
  const until = async (found: () => Promise<boolean>) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) if (await found()) return
    throw new Error('timed out')
  }
  const chat = async (model: string, cwd: string, content: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, cwd, stream: false, messages: [{ role: 'user', content }], ...extra }), signal: AbortSignal.timeout(20_000) })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; usage?: Record<string, unknown>; error?: Record<string, unknown> }
    return { status: response.status, text: body.choices?.[0]?.message.content ?? '', usage: body.usage, error: body.error }
  }
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const runText = async (runId: string) => {
    const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, { signal: AbortSignal.timeout(20_000) })
    let text = ''
    for (const line of (await response.text()).split('\n')) {
      if (!line.startsWith('data:')) continue
      const event = JSON.parse(line.slice(5)) as Record<string, any>
      const inner = event.event ?? event
      if (inner.type === 'message.part.updated' && inner.part?.type === 'text' && typeof inner.delta === 'string') text += inner.delta
    }
    return text
  }

  it('passes a chat turn\'s MCP servers in the session request, names the session, and continues it in a later process', async () => {
    const cwd = await workspace('chat'), session = `chat-${randomBytes(3).toString('hex')}`, nonce = `N-${randomBytes(3).toString('hex')}`
    const one = await chat('factory-droids/custom:fixture', cwd, `Call the tool *write_nonce with exactly ${JSON.stringify({ nonce })}`,
      { session_id: session, agent_profile: profile(cwd) })
    expect(one.status, JSON.stringify(one.error)).toBe(200)
    expect(one.text).toBe(`Tool conformance___write_nonce returned: nonce ${nonce} written`)
    expect(await readFile(join(cwd, `${nonce}.nonce`), 'utf8'), 'the MCP server ran with its env').toBe(`${nonce} tagged`)
    // Two model calls (the tool call and its answer); the session was named, so Droid made no title call.
    expect(one.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 4 })
    const first = await calls((call) => call.params?.cwd === cwd && call.method === 'droid.initialize_session')
    expect(first).toHaveLength(1)
    expect(first[0]!.params).toMatchObject({ machineId: 'cli-bridge', modelId: 'custom:fixture',
      mcpServers: [{ type: 'stdio', name: 'conformance', command: process.execPath, args: [join(cwd, 'nonce-mcp.cjs')], env: { NONCE_TAG: 'tagged' } }] })
    const ofFirst = await calls((call) => call.pid === first[0]!.pid && call.method?.startsWith('droid.') === true)
    expect(ofFirst.map((call) => call.method)).toEqual(['droid.initialize_session', 'droid.rename_session', 'droid.add_user_message'])
    // Later requests answer in the protocol version Droid stamps on its frames.
    expect(ofFirst.at(-1)!.versions).toEqual(['1.0.0', '1.999.0'])
    const spawn = (await calls((call) => call.pid === first[0]!.pid && call.method === 'spawn'))[0]!
    expect(spawn.args).toEqual(['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--skip-permissions-unsafe', '--cwd', cwd])
    expect(await readFile(join(root, 'droid-home', '.factory', 'mcp.json'), 'utf8'), 'the operator\'s MCP config is untouched').toBe(ownMcp)

    const two = await chat('factory-droids/custom:fixture', cwd, 'Repeat your previous answer.', { session_id: session, agent_profile: profile(cwd) })
    expect(two.status, JSON.stringify(two.error)).toBe(200)
    expect(two.text).toBe(one.text)
    const [, later] = await processes(cwd)
    const loaded = await calls((call) => call.pid === later && call.method?.startsWith('droid.') === true)
    expect(loaded.map((call) => call.method), 'a later process loads the session, and names no new one').toEqual(['droid.load_session', 'droid.add_user_message'])
    expect(loaded[0]!.params).toMatchObject({ mcpServers: [{ name: 'conformance' }] })
    expect(existsSync(join(root, 'droid-home', '.factory', 'sessions', `${loaded[0]!.params!.sessionId}.json`))).toBe(true)
  }, 60_000)

  it('refuses a model Droid does not have instead of letting another one answer', async () => {
    const cwd = await workspace('model')
    const refused = await chat('factory-droids/custom:no-such-model', cwd, 'Reply with exactly NO')
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.error?.type).toBe('not_configured')
    expect(JSON.stringify(refused.error)).toContain('fixture-default')
    const created = await calls((call) => call.params?.cwd === cwd && call.method === 'droid.initialize_session')
    expect(await calls((call) => call.pid === created[0]!.pid && call.method === 'droid.add_user_message')).toHaveLength(0)
  }, 30_000)

  it('retains one Droid process across turns and steers a running turn with a queued message', async () => {
    const cwd = await workspace('native'), id = `native-${randomBytes(3).toString('hex')}`
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    const created = await post('/v1/sessions', { id, model: 'factory-droids/custom:fixture', cwd, interaction_policy: 'unattended-allow', agent_profile: profile(cwd) })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    expect(await runText(await turn(1, 'Reply with exactly ALPHA'))).toBe('ALPHA')
    expect(await runText(await turn(2, 'Repeat your previous answer.'))).toBe('ALPHA')

    const running = await turn(3, `Call the tool *wait_seconds with exactly ${JSON.stringify({ seconds: 3 })}`)
    const initialized = (await calls((call) => call.params?.cwd === cwd && call.method === 'droid.initialize_session'))[0]!
    await until(async () => (await calls((call) => call.pid === initialized.pid && call.method === 'tool.start')).length > 0)
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const steered = await post(`/v1/sessions/${id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'Reply with exactly STEERED',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    expect(await runText(running)).toBe('STEERED')
    const mine = await calls((call) => call.pid === initialized.pid)
    expect(await calls((call) => call.params?.cwd === cwd && call.method === 'droid.initialize_session'), 'one process for every turn').toHaveLength(1)
    expect(mine.filter((call) => call.method === 'droid.add_user_message').map((call) => call.params!.queuePlacement ?? null))
      .toEqual([null, null, null, 'end_of_turn'])
    expect(mine.filter((call) => call.method === 'turn.completed').map((call) => call.reason), 'the steer ran inside the third turn').toEqual(['completed', 'completed', 'completed'])
    await post(`/v1/sessions/${id}/close`, {})
  }, 60_000)

  it('ends a cancelled turn with interrupt_session, and the session answers its next turn', async () => {
    const cwd = await workspace('cancel'), session = `cancel-${randomBytes(3).toString('hex')}`, runId = `cancel-run-${randomBytes(3).toString('hex')}`
    const pending = chat('factory-droids/custom:fixture', cwd, `Call the tool *wait_seconds with exactly ${JSON.stringify({ seconds: 30 })}`,
      { session_id: session, run_id: runId, agent_profile: profile(cwd) }).catch(() => undefined)
    await until(async () => {
      const [pid] = await processes(cwd)
      return (await calls((call) => call.pid === pid && call.method === 'tool.start')).length > 0
    })
    const started = Date.now()
    const cancelled = await fetch(`${bridge.url}/v1/runs/${runId}/cancel?wait_ms=10000`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(cancelled.status).toBeLessThan(300)
    await pending
    expect(Date.now() - started).toBeLessThan(10_000)
    const [pid] = await processes(cwd)
    expect((await calls((call) => call.pid === pid)).map((call) => call.method)).toContain('droid.interrupt_session')
    const next = await chat('factory-droids/custom:fixture', cwd, 'Reply with exactly AFTER', { session_id: session, agent_profile: profile(cwd) })
    expect(next.status, JSON.stringify(next.error)).toBe(200)
    expect(next.text).toBe('AFTER')
  }, 60_000)
})
