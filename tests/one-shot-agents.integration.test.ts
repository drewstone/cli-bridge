/**
 * nanocode and Exo through a real Bridge listener and the host spawner, against a synthetic CLI for each
 * that keeps its measured rules (one-shot-agents.ts): nanocode prints its reply on stdout, its session on
 * stderr and its usage in its OpenTelemetry trace export; Exo reads an agent definition with URL MCP
 * servers, prints headers and its reply, and keeps usage in its thread's event log. Exo's MCP call reaches
 * a real stdio server through the Bridge's URL relay. No model is called.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const common = String.raw`
const fs = require('node:fs'), path = require('node:path')
if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0) }
const args = process.argv.slice(2)
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const log = (entry) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(entry) + '\n')
const uuid = () => [8, 4, 4, 4, 12].map((n) => require('node:crypto').randomBytes(n).toString('hex').slice(0, n)).join('-')
`

const nanocode = String.raw`${common}
const prompt = args[args.indexOf('--') + 1]
log({ flavor: 'nc', cwd: at('-C'), args, route: process.env.NANOCODE_OPENAI_BASE_URL ?? null })
const sid = at('-r') || uuid()
const dir = path.join(process.env.NANOCODE_HOME, 'log', 'otel', Date.now() + '000000-' + process.pid)
fs.mkdirSync(dir, { recursive: true })
const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })
const span = (status, input, output) => ({ name: 'attempt', attributes: [attr('status', status), attr('input_tokens', input), attr('output_tokens', output)] })
fs.writeFileSync(path.join(dir, 'traces.jsonl'), [
  JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span('completed', 1200, 50), span('failed', 99, 9)] }] }] }),
  JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span('completed', 34, 6)] }] }] }),
].join('\n') + '\n')
process.stderr.write('nanocode: computer use unavailable, continuing without it\nsession ' + sid + '\n')
process.stdout.write('echo ' + prompt + '\n')
`

const exo = String.raw`${common}
const AGENT = '01a211f1-c778-7132-b355-905b67eaa71d'
if (args[0] === 'vault') { log({ flavor: 'exo', method: 'vault', args, key: process.env.EXO_MODEL_API_KEY ? 'set' : 'unset', home: process.env.EXO_HOME }); process.exit(0) }
if (args[0] === 'thread' && args[1] === 'events') {
  const usage = (prompt_tokens, completion_tokens) => ({ type: 'messages', usage: { prompt_tokens, completion_tokens } })
  console.log(JSON.stringify({ events: [
    { id: 'e3', turn_id: 'latest', data: usage(4, 1) }, { id: 'e2', turn_id: 'latest', data: usage(3, 2) }, { id: 'e1', turn_id: 'earlier', data: usage(100, 100) },
  ], cursor: null }))
  process.exit(0)
}
const file = args[1], definition = fs.readFileSync(file, 'utf8'), prompt = args.find((arg) => arg.startsWith('--prompt=')).slice('--prompt='.length)
const thread = at('--thread') || uuid()
log({ flavor: 'exo', method: 'run', file, args, cwd: process.cwd(), home: process.env.EXO_HOME, definition })
const url = /^    url: "([^"]+)"/m.exec(definition)?.[1]
const rpc = async (id, method, params) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) })
  return response.status === 202 ? null : (await response.json()).result
}
;(async () => {
  let token = ''
  if (url) {
    await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'exo-fixture', version: '1' } })
    await rpc(null, 'notifications/initialized', {})
    const { tools } = await rpc(2, 'tools/list', {})
    token = ' ' + (await rpc(3, 'tools/call', { name: tools[0].name, arguments: {} })).content[0].text
  }
  console.log('agent: ' + path.basename(file, '.md') + ' (' + AGENT + ')')
  console.log('thread: quiet-river-1 (' + thread + ')')
  console.log('model: fixture')
  console.log('[12:00:00] agent: echo ' + prompt + token)
  console.log('ttft: 1ms, duration: 2ms (1 tok/s), 10 [10 total] tok, cost: unavailable')
})()
`

// Answers its one tool with the token from its env.
const tokenServer = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.CONFORMANCE_REPLY}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

type Call = { flavor: string; cwd?: string | null; method?: string; args: string[]; route?: string | null
  file?: string; home?: string; key?: string; definition?: string }

const ENV = { NANOCODE_HOME: '', NANOCODE_OPENAI_BASE_URL: 'http://127.0.0.1:9/nanocode/v1', EXO_HOME: '', EXO_MODEL_BASE_URL: 'http://127.0.0.1:9/exo/v1',
  EXO_MODEL_API_KEY: 'fixture-exo-key' }

describe('nanocode and Exo as one-shot agents through the Bridge', () => {
  let root: string, bridge: BridgeServer
  const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]))
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'one-shot-agents-')))
    await mkdir(join(root, 'bin'))
    const bins: Record<string, string> = {}
    for (const [name, source] of Object.entries({ nc: nanocode, exo })) {
      bins[name] = join(root, 'bin', `${name}.cjs`)
      await writeFile(bins[name]!, `#!${process.execPath}\n${source}`, { mode: 0o700 })
    }
    Object.assign(process.env, ENV, { NANOCODE_HOME: join(root, 'nanocode-home'), EXO_HOME: join(root, 'exo-home') })
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'nanocode,exo',
      NANOCODE_BIN: bins.nc, EXO_BIN: bins.exo, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
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
    return cwd
  }
  const calls = async (match: (call: Call) => boolean) => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Call).filter(match)
  const chat = async (model: string, cwd: string, content: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, cwd, stream: false, messages: [{ role: 'user', content }], ...extra }), signal: AbortSignal.timeout(20_000) })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; usage?: Record<string, unknown>; error?: Record<string, unknown> }
    return { status: response.status, text: body.choices?.[0]?.message.content ?? '', usage: body.usage, error: body.error }
  }
  const profile = async (cwd: string, token: string) => {
    const server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer)
    return { name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }],
      env: { CONFORMANCE_REPLY: { kind: 'public', value: token } } } } }
  }

  it('runs nanocode, reads its session from stderr and its usage from its trace export, and refuses MCP servers it cannot take', async () => {
    const cwd = await workspace('nc'), session = `nc-${randomBytes(3).toString('hex')}`
    const one = await chat('nanocode/fixture-model', cwd, 'one', { session_id: session })
    expect(one.status, JSON.stringify(one.error)).toBe(200)
    expect(one.text).toBe('echo one')
    // The failed attempt's span is not the turn's usage.
    expect(one.usage).toMatchObject({ prompt_tokens: 1234, completion_tokens: 56 })
    await chat('nanocode/fixture-model', cwd, 'two', { session_id: session })
    const [first, second] = await calls((call) => call.flavor === 'nc' && call.cwd === cwd)
    expect(first!.args.slice(0, 7)).toEqual(['exec', '--harness', 'codex', '-C', cwd, '-m', 'fixture-model'])
    expect(first!.route).toBe(ENV.NANOCODE_OPENAI_BASE_URL)
    expect(second!.args[second!.args.indexOf('-r') + 1]).toMatch(/^[0-9a-f-]{36}$/u)
    const refused = await chat('nanocode/fixture-model', cwd, 'mcp', { agent_profile: await profile(cwd, 'unused') })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(refused.error)).toMatch(/no MCP server configuration/u)
  }, 60_000)

  it('runs Exo with its MCP servers relayed by URL, resumes its thread under the same definition, and reads usage from the thread log', async () => {
    const cwd = await workspace('exo'), session = `exo-${randomBytes(3).toString('hex')}`, token = `T-${randomBytes(3).toString('hex')}`
    const one = await chat('exo/fixture-model', cwd, 'one', { session_id: session, agent_profile: await profile(cwd, token) })
    expect(one.status, JSON.stringify(one.error)).toBe(200)
    expect(one.text).toBe(`echo one ${token}`)
    expect(one.usage, 'the latest turn of the thread').toMatchObject({ prompt_tokens: 7, completion_tokens: 3 })
    // The session keeps its profile, and its MCP servers keep their URLs: Exo refuses a thread whose MCP destinations changed.
    const two = await chat('exo/fixture-model', cwd, 'two', { session_id: session })
    expect(two.text).toBe(`echo two ${token}`)
    const runs = await calls((call) => call.flavor === 'exo' && call.method === 'run' && call.cwd === cwd)
    expect(runs).toHaveLength(2)
    expect(runs[1]!.file).toBe(runs[0]!.file)
    expect(runs[0]!.file!.startsWith(join(process.env.EXO_HOME!, 'bridge-agents'))).toBe(true)
    expect(runs[0]!.args).not.toContain('--thread')
    expect(runs[1]!.args[runs[1]!.args.indexOf('--thread') + 1]).toMatch(/^[0-9a-f-]{36}$/u)
    expect(runs[0]!.definition).toContain('permission_policy:\n      type: always_allow')
    expect(runs[0]!.definition).toContain(`name: "fixture-model"\n  base_url: "${ENV.EXO_MODEL_BASE_URL}"`)
    const url = (definition: string) => /^    url: "([^"]+)"/mu.exec(definition)?.[1]
    expect(url(runs[1]!.definition!)).toBe(url(runs[0]!.definition!))
    // Each turn's key is a vault secret created before the run and deleted after it.
    const vault = await calls((call) => call.flavor === 'exo' && call.method === 'vault')
    const credential = /credential: (\S+)/u.exec(runs[0]!.definition!)![1]
    expect(vault.filter((call) => call.args.includes(credential!)).map((call) => [call.args[2], call.key])).toEqual([['create', 'set'], ['delete', 'set']])
  }, 60_000)
})
