/**
 * Exo through a real Bridge listener and the host spawner, against a synthetic `exo` that keeps the rules
 * of `exo run --serve` measured on Exo 0.1.0-unstable-2026-11-17 (exo-serve-session.ts): it has no
 * `--version`, refuses `--sandbox` and `--mount` with `--serve`, runs one service per state root, serves
 * the agent its definition names only with a credential in the root's vault, prints its listener, creates
 * and reads threads, answers a turn 202 and streams the thread's events, runs a turn sent while one runs
 * after it unless it interrupts, cancels a turn, and keeps its threads for a later process on the same root.
 * Its MCP tools are a real stdio server's, reached through the Bridge's URL relay; its `shell` runs in the
 * thread's environment. No model is called.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const exo = String.raw`
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), { execSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--help') { console.log('CLI for exo agents'); process.exit(0) }
if (args.includes('--version')) { console.error("error: unexpected argument '--version' found"); process.exit(2) }
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const log = (entry) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const home = process.env.EXO_HOME
fs.mkdirSync(home, { recursive: true })
const vaultFile = path.join(home, 'vault.json')
const vault = () => fs.existsSync(vaultFile) ? JSON.parse(fs.readFileSync(vaultFile, 'utf8')) : {}
if (args[0] === 'vault') {
  // vault secret create|delete global <name> [--token-env VAR --allow-origin ORIGIN]
  const action = args[2], name = args[4], entries = vault()
  if (action === 'create') {
    if (!process.env[args[args.indexOf('--token-env') + 1]]) { console.error('the token variable is empty'); process.exit(3) }
    entries[name] = { origin: args[args.indexOf('--allow-origin') + 1] }
  } else delete entries[name]
  fs.writeFileSync(vaultFile, JSON.stringify(entries))
  log({ method: 'vault', action, name, home })
  process.exit(0)
}
log({ method: 'spawn', args, home })
if (args[0] !== 'run' || !args.includes('--serve')) process.exit(2)
if (args.includes('--sandbox') || args.includes('--mount')) { console.error("error: the argument '--serve' cannot be used with: --sandbox, --mount"); process.exit(2) }
const lock = path.join(home, 'service.lock')
try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); console.error('Error: another agent service is using this root'); process.exit(1) } catch {}
fs.writeFileSync(lock, String(process.pid))
const definition = fs.readFileSync(args[1], 'utf8')
const credential = /^  credential: (\S+)$/m.exec(definition)[1]
if (!vault()[credential]) { console.error('Error: credential ' + credential + ' is not in the vault'); process.exit(1) }
const model = JSON.parse(/^  name: (".*")$/m.exec(definition)[1])
const servers = [...definition.matchAll(/^    name: ("[^"]+")\n    url: ("[^"]+")\n    permission_policy:\n      type: always_allow$/gm)]
  .map((match) => ({ name: JSON.parse(match[1]), url: JSON.parse(match[2]) }))
const storeFile = path.join(home, 'threads.json')
const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : { agent: crypto.randomUUID(), threads: {} }
const save = () => fs.writeFileSync(storeFile, JSON.stringify(store))
save()
const watchers = new Map(), queues = new Map()
function emit(thread, turnId, data) {
  const event = { id: crypto.randomUUID(), thread_id: thread.id, session_id: turnId, turn_id: turnId, created_at: new Date().toISOString(), data }
  thread.events.push(event)
  thread.latest_event_id = event.id
  save()
  for (const res of watchers.get(thread.id) || []) res.write('event: exo_event\ndata: ' + JSON.stringify(event) + '\n\n')
}
let tools = null
async function mcpTools() {
  if (tools) return tools
  tools = []
  for (const server of servers) {
    let next = 0
    const rpc = async (method, params) => {
      const notification = method.startsWith('notifications/')
      const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++next }), method, params }) })
      return notification ? null : (await response.json()).result
    }
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'exo-fixture', version: '1' } })
    await rpc('notifications/initialized', {})
    for (const tool of (await rpc('tools/list', {})).tools) tools.push({ name: 'exo_mcp__' + server.name + '__' + tool.name, call: (input) => rpc('tools/call', { name: tool.name, arguments: input }) })
  }
  return tools
}
const usage = () => ({ model, prompt_tokens: 10, completion_tokens: 2, prompt_cached_tokens: 4 })
function say(thread, turn, text) {
  emit(thread, turn.id, { type: 'messages', messages: [{ role: 'assistant', content: text, id: null }], response_id: crypto.randomUUID(), usage: usage() })
  thread.said.push(text)
}
async function execute(thread, turn) {
  emit(thread, turn.id, { type: 'turn_started' })
  emit(thread, turn.id, { type: 'messages', messages: [{ role: 'user', content: turn.text }], response_id: null })
  const cancelled = new Promise((resolve) => { turn.cancel = resolve })
  // One model call: the turn's instruction decides, as on the Router's scripted model.
  const call = /^Call the tool \*(\S+) with exactly (\{.*\})$/s.exec(turn.text)
  if (call) {
    const shell = call[1] === 'shell', input = JSON.parse(call[2])
    const tool = shell ? null : (await mcpTools()).find((entry) => entry.name.endsWith(call[1]))
    const name = shell ? 'shell' : tool.name, id = 'call_' + crypto.randomBytes(6).toString('hex')
    emit(thread, turn.id, { type: 'messages', messages: [{ role: 'assistant', content: [{ type: 'tool_call', tool_call_id: id, tool_name: name, arguments: { type: 'valid', value: input } }], id: null }],
      response_id: crypto.randomUUID(), usage: usage() })
    emit(thread, turn.id, { type: 'tool_requested', tool_call_id: id, response_id: null, request: { function_name: name, arguments: input } })
    log({ method: 'tool.start', name, turnId: turn.id })
    const run = shell
      ? Promise.resolve({ exit_code: 0, stdout: execSync(input.command, { cwd: thread.environment.file_system_mounts[0].host_path, encoding: 'utf8' }), stderr: '' })
      : tool.call(input)
    const result = await Promise.race([run, cancelled.then(() => null)])
    if (result === null) return
    emit(thread, turn.id, { type: 'tool_result', tool_call_id: id, result })
    say(thread, turn, 'Tool ' + name + ' returned: ' + JSON.stringify(result))
  } else if (turn.text === 'Repeat your previous answer.') {
    say(thread, turn, thread.said.at(-1) || 'nothing')
  } else {
    say(thread, turn, /^Reply with exactly (.+)$/s.exec(turn.text)?.[1] ?? 'No instruction')
  }
}
async function pump(thread, queue) {
  if (queue.running) return
  const turn = queue.pending.shift()
  if (!turn) return
  queue.running = turn
  await execute(thread, turn).catch((error) => emit(thread, turn.id, { type: 'error', message: String(error) }))
  if (turn.cancelled) emit(thread, turn.id, { type: 'error', message: 'harness turn cancelled' })
  emit(thread, turn.id, { type: 'turn_ended' })
  log({ method: 'turn.ended', turnId: turn.id, cancelled: turn.cancelled })
  queue.running = null
  void pump(thread, queue)
}
function cancel(turn) {
  if (!turn || turn.cancelled) return false
  turn.cancelled = true
  if (turn.cancel) turn.cancel()
  return true
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const url = new URL(req.url, 'http://fixture')
    const parts = url.pathname.replace(/^\/exo\//, '').split('/')
    const body = raw ? JSON.parse(raw) : null
    log({ method: 'http', verb: req.method, path: parts.join('/'), body })
    const agent = { id: store.agent, slug: 'bridge', name: 'bridge' }
    if (req.method === 'GET' && parts.join('/') === 'agent') return json(res, 200, { agents: [agent] })
    if (parts[0] !== 'agent' || parts[1] !== store.agent || parts[2] !== 'thread') return json(res, 404, { error: 'not found' })
    if (parts.length === 3 && req.method === 'POST') {
      const thread = { id: crypto.randomUUID(), slug: 'conversation-1', name: '', latest_event_id: crypto.randomUUID(), environment: body.environment, events: [], said: [] }
      store.threads[thread.id] = thread
      save()
      const { events, said, ...record } = thread
      return json(res, 200, { agent, thread: record, harness: 'basic' })
    }
    const thread = store.threads[parts[3]]
    if (!thread) return json(res, 404, { error: 'thread not found' })
    const queue = queues.get(thread.id) || { running: null, pending: [] }
    queues.set(thread.id, queue)
    if (parts.length === 4 && req.method === 'GET') { const { events, said, ...record } = thread; return json(res, 200, { agent, thread: record }) }
    if (parts[4] === 'turn' && parts.length === 5 && req.method === 'POST') {
      const turn = { id: crypto.randomUUID(), text: body.input.content, cancelled: false }
      if (body.attention === 'interrupt') cancel(queue.running)
      log({ method: 'turn', turnId: turn.id, attention: body.attention || 'wake', text: turn.text })
      queue.pending.push(turn)
      void pump(thread, queue)
      return json(res, 202, { agent, thread: { id: thread.id }, turn: { id: turn.id, session_id: turn.id }, harness: 'basic' })
    }
    if (parts[4] === 'turn' && parts[6] === 'cancel') {
      return json(res, 200, { canceled_active_turn: queue.running && queue.running.id === parts[5] ? cancel(queue.running) : false, finished_event_id: null })
    }
    if (parts[4] === 'event' && parts[5] === 'watch') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const after = url.searchParams.get('after'), from = thread.events.findIndex((event) => event.id === after)
      for (const event of thread.events.slice(from + 1)) res.write('event: exo_event\ndata: ' + JSON.stringify(event) + '\n\n')
      const set = watchers.get(thread.id) || new Set()
      watchers.set(thread.id, set)
      set.add(res)
      // A request's own 'close' comes once its body is read; the response's comes when the client goes.
      res.on('close', () => set.delete(res))
      return
    }
    json(res, 404, { error: 'not found' })
  })
})
server.listen(0, '127.0.0.1', () => {
  console.log('preview listener: 127.0.0.1:1 (domain: localhost)')
  console.log('listening: http://127.0.0.1:' + server.address().port + '/exo')
})
process.on('SIGTERM', () => {
  log({ method: 'sigterm' })
  fs.rmSync(lock, { force: true })
  server.closeAllConnections()
  server.close(() => process.exit(1))
})
`

// The matrix's MCP server: write_nonce writes <dir>/<nonce>.nonce; wait_seconds answers after the given seconds.
const nonceServer = (dir: string) => `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'write_nonce',inputSchema:{type:'object'}},{name:'wait_seconds',inputSchema:{type:'object'}}]};else if(r.params.name==='wait_seconds'){setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'waited'}]}})+'\\n'),r.params.arguments.seconds*1000);return}else{const nonce=String(r.params.arguments.nonce);fs.writeFileSync(path.join(${JSON.stringify(dir)},nonce+'.nonce'),nonce+' '+process.env.NONCE_TAG);result={content:[{type:'text',text:'nonce '+nonce+' written'}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

type Call = { pid: number; method: string; args?: string[]; home?: string; action?: string; name?: string; verb?: string; path?: string
  body?: Record<string, any> | null; attention?: string; text?: string; turnId?: string; cancelled?: boolean }

const ENV = { EXO_HOME: '', EXO_MODEL_BASE_URL: 'http://127.0.0.1:9/exo/v1', EXO_MODEL_API_KEY: 'fixture-exo-key' }

describe('Exo on its HTTP service through the Bridge', () => {
  let root: string, bridge: BridgeServer
  const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]))
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'exo-')))
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'exo.cjs')
    await writeFile(bin, `#!${process.execPath}\n${exo}`, { mode: 0o700 })
    Object.assign(process.env, ENV, { EXO_HOME: join(root, 'exo-home') })
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'exo',
      EXO_BIN: bin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
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
  const sessionRoot = (session: string) => join(root, 'exo-home', 'bridge-sessions', createHash('sha256').update(session).digest('hex').slice(0, 16))
  // The services the Bridge started on a state root, in order.
  const services = async (home: string) => (await calls((call) => call.method === 'spawn' && call.home === home)).map((call) => call.pid)
  const until = async (found: () => Promise<boolean>) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) if (await found()) return
    throw new Error('timed out')
  }
  const chat = async (cwd: string, content: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'exo/fixture-model', cwd, stream: false, messages: [{ role: 'user', content }], ...extra }), signal: AbortSignal.timeout(20_000) })
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

  it('serves a chat turn\'s MCP servers by URL on the session\'s own root, and continues its thread in a later process', async () => {
    const cwd = await workspace('chat'), session = `chat-${randomBytes(3).toString('hex')}`, nonce = `N-${randomBytes(3).toString('hex')}`
    const home = sessionRoot(session)
    const one = await chat(cwd, `Call the tool *write_nonce with exactly ${JSON.stringify({ nonce })}`, { session_id: session, agent_profile: profile(cwd) })
    expect(one.status, JSON.stringify(one.error)).toBe(200)
    expect(one.text).toBe(`Tool exo_mcp__conformance__write_nonce returned: ${JSON.stringify({ content: [{ type: 'text', text: `nonce ${nonce} written` }] })}`)
    expect(await readFile(join(cwd, `${nonce}.nonce`), 'utf8'), 'the MCP server ran with its env').toBe(`${nonce} tagged`)
    // Two model calls, each 10 prompt tokens (4 of them cached) and 2 completion tokens.
    expect(one.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 4 })
    const [first] = await services(home)
    const spawn = (await calls((call) => call.pid === first && call.method === 'spawn'))[0]!
    expect(spawn.args).toEqual(['run', join(home, 'bridge.md'), '--serve', '--bind', '127.0.0.1:0'])
    const created = (await calls((call) => call.pid === first && call.method === 'http' && call.verb === 'POST' && call.path?.endsWith('/thread') === true))[0]!
    expect(created.body!.environment).toMatchObject({ provider: 'local_process', file_system_mounts: [{ host_path: cwd, mount_path: '/workspace', mode: 'rw' }] })

    const two = await chat(cwd, 'Repeat your previous answer.', { session_id: session, agent_profile: profile(cwd) })
    expect(two.status, JSON.stringify(two.error)).toBe(200)
    expect(two.text).toBe(one.text)
    const shell = await chat(cwd, `Call the tool *shell with exactly ${JSON.stringify({ command: 'echo made > made.txt && pwd' })}`, { session_id: session, agent_profile: profile(cwd) })
    expect(shell.status, JSON.stringify(shell.error)).toBe(200)
    expect(await readFile(join(cwd, 'made.txt'), 'utf8'), 'the thread\'s tools run on the workspace').toBe('made\n')
    const [, second] = await services(home)
    const requests = (await calls((call) => call.pid === second && call.method === 'http')).map((call) => `${call.verb} ${call.path?.replace(/[0-9a-f-]{36}/gu, '<id>')}`)
    expect(requests.slice(0, 3), 'a later process reads the thread and creates none').toEqual(['GET agent', 'GET agent/<id>/thread/<id>', 'POST agent/<id>/thread/<id>/turn'])
    // Each process's key is a vault credential created before it starts and deleted after it stops.
    const vault = await calls((call) => call.method === 'vault' && call.home === home)
    expect(vault.map((call) => call.action)).toEqual(['create', 'delete', 'create', 'delete', 'create', 'delete'])
    expect(new Set(vault.map((call) => call.name)).size).toBe(3)
    expect(await calls((call) => call.method === 'sigterm' && [first, second].includes(call.pid))).toHaveLength(2)
  }, 60_000)

  it('gives a turn outside a session a root of its own, removed after it', async () => {
    const cwd = await workspace('loose')
    const one = await chat(cwd, 'Reply with exactly LOOSE')
    expect(one.status, JSON.stringify(one.error)).toBe(200)
    expect(one.text).toBe('LOOSE')
    const spawn = (await calls((call) => call.method === 'spawn' && call.home?.startsWith(join(root, 'exo-home', 'bridge-turns')) === true)).at(-1)!
    await until(async () => !existsSync(spawn.home!))
    expect(await readdir(join(root, 'exo-home', 'bridge-turns'))).toEqual([])
  }, 30_000)

  it('retains one Exo service across turns and steers a running turn by interrupting it', async () => {
    const cwd = await workspace('native'), id = `native-${randomBytes(3).toString('hex')}`
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    const created = await post('/v1/sessions', { id, model: 'exo/fixture-model', cwd, interaction_policy: 'unattended-allow', agent_profile: profile(cwd) })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    expect(await runText(await turn(1, 'Reply with exactly ALPHA'))).toBe('ALPHA')
    expect(await runText(await turn(2, 'Repeat your previous answer.'))).toBe('ALPHA')

    const running = await turn(3, `Call the tool *wait_seconds with exactly ${JSON.stringify({ seconds: 30 })}`)
    const [service] = await services(sessionRoot(id))
    await until(async () => (await calls((call) => call.pid === service && call.method === 'tool.start')).length > 0)
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const started = Date.now()
    const steered = await post(`/v1/sessions/${id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'Reply with exactly STEERED',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    expect(await runText(running)).toBe('STEERED')
    expect(Date.now() - started, 'the steer interrupted the 30 s tool call').toBeLessThan(10_000)
    expect(await services(sessionRoot(id)), 'one service for every turn').toHaveLength(1)
    const mine = await calls((call) => call.pid === service)
    expect(mine.filter((call) => call.method === 'turn').map((call) => call.attention)).toEqual(['wake', 'wake', 'wake', 'interrupt'])
    expect(mine.filter((call) => call.method === 'turn.ended').map((call) => call.cancelled), 'the steer cancelled the third turn').toEqual([false, false, true, false])
    await post(`/v1/sessions/${id}/close`, {})
  }, 60_000)

  it('cancels a cancelled chat turn in Exo, and the session answers its next turn', async () => {
    const cwd = await workspace('cancel'), session = `cancel-${randomBytes(3).toString('hex')}`, runId = `cancel-run-${randomBytes(3).toString('hex')}`
    const pending = chat(cwd, `Call the tool *wait_seconds with exactly ${JSON.stringify({ seconds: 30 })}`,
      { session_id: session, run_id: runId, agent_profile: profile(cwd) }).catch(() => undefined)
    await until(async () => {
      const [pid] = await services(sessionRoot(session))
      return (await calls((call) => call.pid === pid && call.method === 'tool.start')).length > 0
    })
    const started = Date.now()
    const cancelled = await fetch(`${bridge.url}/v1/runs/${runId}/cancel?wait_ms=10000`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(cancelled.status).toBeLessThan(300)
    await pending
    expect(Date.now() - started).toBeLessThan(10_000)
    const [pid] = await services(sessionRoot(session))
    expect((await calls((call) => call.pid === pid && call.method === 'http')).map((call) => call.path ?? '').some((path) => path.endsWith('/cancel'))).toBe(true)
    const next = await chat(cwd, 'Reply with exactly AFTER', { session_id: session, agent_profile: profile(cwd) })
    expect(next.status, JSON.stringify(next.error)).toBe(200)
    expect(next.text).toBe('AFTER')
  }, 60_000)
})
