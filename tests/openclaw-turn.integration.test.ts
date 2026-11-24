/**
 * OpenClaw turns through a real Bridge listener and the host spawner, against a synthetic
 * `openclaw agent --local --json` that keeps OpenClaw 2026.11.5's contract: the message on stdin
 * (`--message-file -`), sessions filed under `--session-id`, MCP servers only from the config
 * OPENCLAW_CONFIG_PATH names, one JSON document on stdout with `payloads` and
 * `meta.agentMeta.usage`, and exit 1 with `{ error }` for a refused turn; and, for a retained session,
 * an `openclaw gateway run` its `openclaw agent` calls reach, where a `/steer` sent during a held run
 * is answered after it. No model is called.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const openclaw = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('OpenClaw 2026.11.5 (fixture)'); process.exit(0) }
const argv = process.argv.slice(2), flag = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const configPath = process.env.OPENCLAW_CONFIG_PATH
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const gatewayState = argv.includes('--local') ? null : process.env.OPENCLAW_STATE_DIR
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ argv, configPath, config, workspace: process.env.OPENCLAW_WORKSPACE_DIR, gatewayState, pid: process.pid }) + '\n')
// A Gateway answers until it is stopped; its agent calls find it through the state directory they share.
if (argv[0] === 'gateway') {
  fs.writeFileSync(path.join(gatewayState, 'gateway.pid'), String(process.pid))
  setTimeout(() => console.log('[gateway] ready'), 200)
  setInterval(() => {}, 1000)
  return
}
const done = (document, code = 0) => {
  process.stdout.write(JSON.stringify(gatewayState ? { runId: 'run', status: code === 0 ? 'ok' : 'error', summary: 'completed', result: document } : document, null, 2) + '\n')
  process.exit(code)
}
const marker = (name) => path.join(gatewayState || state, flag('--session-id') + '.' + name)
const until = (file) => new Promise((resolve) => { const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); resolve() } }, 50) })
function callMcp() {
  const name = 'conformance', server = config.mcp.servers[name]
  const child = cp.spawn(server.command, server.args || [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let id = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)(reply.result) })
  const call = (method, params) => new Promise((resolve) => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  return call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openclaw-fixture', version: '1' } })
    .then(() => call('tools/list', {}))
    .then(({ tools }) => call('tools/call', { name: tools[0].name, arguments: {} }))
    .then((result) => { child.kill('SIGTERM'); return name + '__' + 'tool returned: ' + result.content[0].text })
}
let message = ''
process.stdin.on('data', (chunk) => { message += chunk }).on('end', async () => {
  const model = flag('--model')
  if (model && model !== config.agents.defaults.model.primary) done({ error: { type: 'cli_error', message: 'Model ' + model + ' is not configured' } }, 1)
  const transcript = path.join(state, flag('--session-id') + '.json')
  const past = fs.existsSync(transcript) ? JSON.parse(fs.readFileSync(transcript, 'utf8')) : []
  if (gatewayState && !fs.existsSync(path.join(gatewayState, 'gateway.pid'))) done({ error: { type: 'gateway', message: 'no Gateway' } }, 1)
  // A held run takes a /steer at its next boundary: the run answers first, then the steer.
  if (message === 'hold') { fs.writeFileSync(marker('hold'), ''); await until(marker('steer')) }
  if (message.startsWith('/steer ')) { await until(marker('hold')); fs.writeFileSync(marker('steer'), ''); await new Promise((resolve) => setTimeout(resolve, 300)) }
  const text = message === 'mcp' ? await callMcp() : message === 'repeat' ? (past[past.length - 1] || 'nothing')
    : message === 'hold' ? 'held' : message.startsWith('/steer ') ? 'steered: ' + message.slice('/steer '.length) : 'echo ' + message
  fs.writeFileSync(transcript, JSON.stringify([...past, text]))
  done({ payloads: [{ text, mediaUrl: null }], meta: { durationMs: 1, agentMeta: { sessionId: flag('--session-id'), provider: 'tangle', model: 'fixture',
    usage: { input: 11, output: 4, cacheRead: 2, cacheWrite: 0, total: 17 } }, stopReason: 'stop' } })
})
`

const tokenServer = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.CONFORMANCE_REPLY}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

describe('an OpenClaw turn through the Bridge', () => {
  let root: string, operatorConfig: string, bridge: BridgeServer
  const operator = { agents: { defaults: { model: { primary: 'tangle/tangle/canary-echo' } } }, tools: { toolSearch: false },
    mcp: { servers: { operator_tools: { command: 'operator-mcp' } } } }
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-turn-')))
    await mkdir(join(root, 'bin'))
    const bin = join(root, 'bin', 'openclaw.cjs')
    await writeFile(bin, `#!${process.execPath}\n${openclaw}`, { mode: 0o700 })
    operatorConfig = join(root, 'openclaw.json')
    await writeFile(operatorConfig, JSON.stringify(operator))
    vi.stubEnv('OPENCLAW_CONFIG_PATH', operatorConfig)
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'openclaw', OPENCLAW_BIN: bin,
      BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const workspace = async (name: string) => {
    const cwd = join(root, `${name}-${randomBytes(3).toString('hex')}`)
    await mkdir(cwd)
    return cwd
  }
  const chat = async (cwd: string, content: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openclaw', cwd, stream: false, messages: [{ role: 'user', content }], ...extra }), signal: AbortSignal.timeout(20_000) })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; usage?: Record<string, unknown>; error?: { message: string; type: string } }
    return { status: response.status, text: body.choices?.[0]?.message.content ?? '', usage: body.usage, error: body.error }
  }
  const calls = async () => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { argv: string[]; configPath: string; config: typeof operator & { mcp: { servers: Record<string, unknown> }; gateway?: Record<string, unknown> };
      workspace: string; gatewayState: string | null; pid: number })

  it('runs the embedded agent in the request workspace, continues its session, and reports its usage', async () => {
    const cwd = await workspace('session'), session = `openclaw-${randomBytes(3).toString('hex')}`
    const first = await chat(cwd, 'first', { session_id: session })
    expect(first.status, JSON.stringify(first.error)).toBe(200)
    expect(first.text).toBe('echo first')
    expect(first.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 4 })
    const second = await chat(cwd, 'repeat', { session_id: session })
    expect(second.text).toBe('echo first')
    const mine = (await calls()).filter((call) => call.workspace === cwd)
    expect(mine).toHaveLength(2)
    for (const call of mine) {
      expect(call.argv.slice(0, 3)).toEqual(['agent', '--local', '--json'])
      expect(call.argv.slice(-2)).toEqual(['--message-file', '-'])
      expect(call.configPath).toBe(operatorConfig)
    }
    expect(mine[1]!.argv[mine[1]!.argv.indexOf('--session-id') + 1]).toBe(mine[0]!.argv[mine[0]!.argv.indexOf('--session-id') + 1])
  }, 30_000)

  it("adds the request's MCP servers to a per-run copy of the operator's config", async () => {
    const cwd = await workspace('mcp'), token = `TOKEN-${randomBytes(4).toString('hex')}`
    const server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer)
    const turn = await chat(cwd, 'mcp', { session_id: `openclaw-mcp-${randomBytes(3).toString('hex')}`, agent_profile: { name: 'conformance',
      mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }],
        env: { CONFORMANCE_REPLY: { kind: 'public', value: token } } } } } })
    expect(turn.status, JSON.stringify(turn.error)).toBe(200)
    expect(turn.text).toBe(`conformance__tool returned: ${token}`)
    const call = (await calls()).find((entry) => entry.workspace === cwd)!
    expect(call.configPath).not.toBe(operatorConfig)
    // The operator's settings and servers stay; the request's server joins them; the operator's file is untouched.
    expect(call.config).toMatchObject({ agents: operator.agents, tools: operator.tools })
    expect(Object.keys(call.config.mcp.servers).sort()).toEqual(['conformance', 'operator_tools'])
    expect(JSON.parse(await readFile(operatorConfig, 'utf8'))).toEqual(operator)
    expect((await readdir(tmpdir())).filter((name) => call.configPath.includes(name) && name.startsWith('cli-bridge-openclaw-'))).toEqual([])
  }, 30_000)

  it('retains a session on its own Gateway and steers its running turn with /steer', async () => {
    const cwd = await workspace('native'), id = `openclaw-native-${randomBytes(3).toString('hex')}`
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
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    const created = await post('/v1/sessions', { id, model: 'openclaw', cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    expect(await runText(await turn(1, 'native first'))).toBe('echo native first')
    expect(await runText(await turn(2, 'repeat'))).toBe('echo native first')

    const running = await turn(3, 'hold')
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const steered = await post(`/v1/sessions/${id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'turn left',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    expect(await runText(running)).toBe('heldsteered: turn left')

    const mine = (await calls()).filter((call) => call.workspace === cwd)
    const gateway = mine.find((call) => call.argv[0] === 'gateway')!
    // The session's own loopback Gateway, with a token, on its own state; the operator's settings stay.
    expect(gateway.config.gateway).toMatchObject({ mode: 'local', bind: 'loopback', auth: { mode: 'token' } })
    expect(gateway.config.agents).toEqual(operator.agents)
    const agents = mine.filter((call) => call.argv[0] === 'agent')
    expect(agents.map((call) => call.argv.includes('--local'))).toEqual([false, false, false, false])
    expect(new Set(agents.map((call) => call.argv[call.argv.indexOf('--session-id') + 1])).size).toBe(1)
    expect(new Set(agents.map((call) => call.gatewayState))).toEqual(new Set([gateway.gatewayState]))

    await post(`/v1/sessions/${id}/close`, {})
    let alive = true
    for (const end = Date.now() + 10_000; alive && Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
      try { process.kill(gateway.pid, 0) } catch { alive = false }
    }
    expect(alive).toBe(false)
  }, 60_000)

  it('passes a named model and reports a refused one as a typed error', async () => {
    const cwd = await workspace('model')
    const named = await chat(cwd, 'hello', { model: 'openclaw/tangle/tangle/canary-echo' })
    expect(named.status, JSON.stringify(named.error)).toBe(200)
    const call = (await calls()).find((entry) => entry.workspace === cwd)!
    expect(call.argv[call.argv.indexOf('--model') + 1]).toBe('tangle/tangle/canary-echo')
    const refused = await chat(await workspace('refused'), 'hello', { model: 'openclaw/no-such-model' })
    expect(refused.status).toBeGreaterThanOrEqual(500)
    expect(refused.error?.type).toBeTruthy()
    expect(refused.error?.message).toContain('no-such-model is not configured')
  }, 30_000)
})
