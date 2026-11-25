/**
 * prime-agent 0.10 through a real Bridge listener and the host spawner, against a synthetic
 * `prime-agent --mode rpc` that keeps prime's contract as measured on 0.10.3: it reads MCP servers
 * from `<agent dir>/settings.json` (stdio env values by `{ env: NAME }` reference) and reaches them
 * from its REPL, applies an rpc `steer` to the running prompt, ends a prompt at `agent_end` without
 * `agent_settled`, and reports `isStreaming` from `get_state`, which the Bridge asks after each turn.
 * No model is called.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const prime = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('0.10.3-fixture'); process.exit(0) }
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let messages = 0, streaming = false, waiting = false, stdinEnded = false, slowState = false
const exitWhenDone = () => { if (stdinEnded && !streaming) process.exit(0) }
function callMcp() {
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.PRIME_AGENT_CODING_AGENT_DIR, 'settings.json'), 'utf8'))
  const [name, server] = Object.entries(settings.mcpServers)[0]
  const env = { ...process.env }
  for (const [key, reference] of Object.entries(server.env || {})) env[key] = process.env[reference.env]
  const child = cp.spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let id = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply.result) })
  const call = (method, params) => new Promise((resolve) => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  return call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'prime-fixture', version: '1' } })
    .then(() => call('tools/list', {}))
    .then(({ tools }) => call('tools/call', { name: tools[0].name, arguments: {} }))
    .then((result) => { child.kill('SIGTERM'); return name + ': ' + result.content[0].text })
}
function finish(text) {
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
  out({ type: 'turn_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } })
  messages += 2
  streaming = false
  out({ type: 'agent_end' })
  exitWhenDone()
}
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const command = JSON.parse(line)
  const ok = (data) => out({ type: 'response', id: command.id, command: command.type, success: true, ...(data ? { data } : {}) })
  if (command.type === 'get_state') {
    const state = { sessionId: 'prime-fixture-session', messageCount: messages, isStreaming: streaming, isCompacting: false }
    // A loaded host answers late; the Bridge asks get_state after a turn's run has ended.
    if (slowState) { slowState = false; return void setTimeout(() => ok(state), 1500) }
    return ok(state)
  }
  if (command.type === 'prompt') {
    ok()
    streaming = true
    out({ type: 'agent_start' })
    if (command.message === 'wait') { waiting = true; return }
    if (command.message === 'settle slowly') slowState = true
    if (command.message === 'mcp') return void callMcp().then(finish)
    return finish('echo ' + command.message)
  }
  if (command.type === 'steer') {
    ok()
    if (waiting) { waiting = false; setTimeout(() => finish('steered: ' + command.message), 50) }
    return
  }
  if (command.type === 'abort') {
    ok()
    if (streaming) { waiting = false; finish('aborted') }
  }
})
lines.on('close', () => { stdinEnded = true; exitWhenDone() })
`

// Answers its one tool with the token from its env.
const tokenServer = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.CONFORMANCE_REPLY}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

describe('prime through the Bridge', () => {
  let root: string, bridge: BridgeServer
  const model = 'prime/fixture/fixture-model'
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'prime-native-')))
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'prime-agent.cjs')
    await writeFile(bin, `#!${process.execPath}\n${prime}`, { mode: 0o700 })
    const models = join(root, 'models.json')
    await writeFile(models, JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions',
      apiKey: 'fixture-literal-key', models: [{ id: 'fixture-model' }] } } }))
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'prime', PRIME_BIN: bin,
      PRIME_MODELS_JSON: models, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
  })

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> }
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
  const profile = async (cwd: string, token: string) => {
    const server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer)
    return { name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }],
      env: { CONFORMANCE_REPLY: { kind: 'public', value: token } } } } }
  }

  it("mounts the profile's MCP server where prime's REPL reaches it", async () => {
    const cwd = join(root, 'mcp')
    await mkdir(cwd)
    const token = `TOKEN-${randomBytes(4).toString('hex')}`
    const turn = await post('/v1/chat/completions', { model, cwd, stream: false, session_id: `prime-mcp-${randomBytes(3).toString('hex')}`,
      messages: [{ role: 'user', content: 'mcp' }], agent_profile: await profile(cwd, token) })
    expect(turn.status, JSON.stringify(turn.body.error)).toBe(200)
    expect(turn.body.choices[0].message.content).toBe(`conformance: ${token}`)
  }, 30_000)

  it('retains a native session across turns and applies a steer to the running turn', async () => {
    const cwd = join(root, 'native')
    await mkdir(cwd)
    const id = `prime-native-${randomBytes(3).toString('hex')}`
    const created = await post('/v1/sessions', { id, model, cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    expect(await runText(await turn(1, 'hello'))).toBe('echo hello')

    const running = await turn(2, 'wait')
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const steered = await post(`/v1/sessions/${id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'turn left',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    expect(await runText(running)).toBe('steered: turn left')
    await post(`/v1/sessions/${id}/close`, {})
  }, 40_000)

  it('admits the next turn once the previous run has ended, while that turn is still being committed', async () => {
    const cwd = join(root, 'settle')
    await mkdir(cwd)
    const id = `prime-settle-${randomBytes(3).toString('hex')}`
    const created = await post('/v1/sessions', { id, model, cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    expect(await runText(await turn(1, 'settle slowly'))).toBe('echo settle slowly')
    expect(await runText(await turn(2, 'next'))).toBe('echo next')
    await post(`/v1/sessions/${id}/close`, {})
  }, 40_000)
})
