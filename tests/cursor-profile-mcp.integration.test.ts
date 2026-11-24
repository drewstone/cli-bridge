/**
 * A Cursor Agent turn carries its AgentProfile's instructions and MCP servers into the project files
 * Cursor reads, through a real Bridge listener, the host spawner and, where bwrap exists, the
 * fs-jail. The synthetic cursor-agent records its argv and the workspace it finds at launch; with
 * `--approve-mcps` it starts each server in `.cursor/mcp.json` the way Cursor does, as its own
 * child inside the jail, calls the server's tool, and answers with the tool's result and every
 * always-applied rule. No model is called.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const SESSION = '00000000-0000-4000-8000-0000000c0501'

const cursorAgent = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('2026.11.22-fixture'); process.exit(0) }
const argv = process.argv.slice(2), workspace = argv[argv.indexOf('--workspace') + 1], approved = argv.includes('--approve-mcps')
const rulesDir = path.join(workspace, '.cursor', 'rules'), mcpFile = path.join(workspace, '.cursor', 'mcp.json')
const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((name) => name.endsWith('.mdc')).map((name) => fs.readFileSync(path.join(rulesDir, name), 'utf8')) : []
const always = rules.map((rule) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(rule)).filter((parts) => parts && /^alwaysApply: true$/m.test(parts[1])).map((parts) => parts[2].trim())
const servers = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers ?? {} : {}
async function callTool(server) {
  const child = cp.spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let id = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply.result) })
  const call = (method, params) => new Promise((resolve) => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cursor-fixture', version: '1' } })
    const { tools } = await call('tools/list', {})
    return (await call('tools/call', { name: tools[0].name, arguments: {} })).content[0].text
  } finally { child.kill('SIGTERM') }
}
let prompt = ''
process.stdin.on('data', (chunk) => { prompt += chunk }).on('end', async () => {
  const results = approved ? await Promise.all(Object.values(servers).map(callTool)) : []
  fs.writeFileSync(path.join(workspace, 'launch.json'), JSON.stringify({ argv, approved, rules, servers: Object.keys(servers), prompt, home: process.env.HOME }))
  const text = [...results, ...always].join(' ') || 'plain'
  for (const event of [{ type: 'system', subtype: 'init', session_id: '${SESSION}' },
    { type: 'assistant', session_id: '${SESSION}', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: '${SESSION}', usage: { inputTokens: 3, outputTokens: 5 } }]) {
    process.stdout.write(JSON.stringify(event) + '\n')
  }
})
`

// Answers its one tool with the token from its env and records the HOME it runs under.
const tokenServer = (record: string) => `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const r=JSON.parse(line);if(r.id===undefined)return;fs.writeFileSync(${JSON.stringify(record)},process.env.HOME||'');const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.CONFORMANCE_TOKEN}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

const jailed = new LinuxBwrapJail().isAvailable()

describe.each([
  { jail: 'off' as const },
  ...(jailed ? [{ jail: 'fs-jail' as const }] : []),
])('a Cursor turn with jail $jail', ({ jail }) => {
  let root: string, bridge: BridgeServer
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), `cursor-profile-${jail}-`)))
    const bin = join(root, 'cursor-agent.cjs')
    await writeFile(bin, `#!${process.execPath}\n${cursorAgent}`, { mode: 0o700 })
    // A fixture key, so the Bridge never reads a real enrolled token from this host.
    vi.stubEnv('CURSOR_API_KEY', 'fixture-cursor-key-not-a-credential')
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'cursor', CURSOR_BIN: bin,
      BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: jail, BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: 'none' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const workspace = async (name: string) => {
    const cwd = join(root, name)
    await mkdir(cwd)
    return cwd
  }
  const chat = async (cwd: string, extra: Record<string, unknown>) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor', cwd, stream: false, session_id: `cursor-${randomBytes(4).toString('hex')}`,
        messages: [{ role: 'user', content: 'Call the conformance_token tool, then reply with the token and your codeword.' }], ...extra }) })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; error?: { message: string; type: string; provider_dispatch?: string } }
    return { status: response.status, text: body.choices?.[0]?.message.content ?? '', error: body.error }
  }
  // The backend restores the workspace once Cursor exits, which may land just after the response.
  const eventually = async (check: () => Promise<boolean> | boolean) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) if (await check()) return true
    return false
  }
  const launch = async (cwd: string) => JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8')) as {
    argv: string[]; approved: boolean; rules: string[]; servers: string[]; prompt: string; home: string }

  it('declares instructions and MCP, and no system-prompt control', async () => {
    const response = await fetch(`${bridge.url}/v1/capabilities?model=cursor`)
    expect(response.status).toBe(200)
    const { profile } = await response.json() as { profile: Record<string, unknown> }
    expect(profile).toMatchObject({ instructions: true, mcp: true, systemPrompt: { replace: false, append: false }, tools: false, permissions: false })
  })

  it('carries the instructions as an always-applied rule and the MCP server, then restores the workspace', async () => {
    const cwd = await workspace('profiled')
    // The workspace's own project MCP config: Cursor must not load it beside the profile's, and it comes back byte for byte.
    const own = JSON.stringify({ mcpServers: { planted: { command: 'false' } } })
    await mkdir(join(cwd, '.cursor'))
    await writeFile(join(cwd, '.cursor', 'mcp.json'), own)
    const token = `TOKEN-${randomBytes(4).toString('hex')}`, codeword = `PROFILE-${randomBytes(4).toString('hex')}`
    const serverHome = join(cwd, 'server-home'), server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer(serverHome))
    const turn = await chat(cwd, { agent_profile: {
      name: 'conformance',
      prompt: { instructions: [`Your codeword is ${codeword}. Whenever you are asked for your codeword, give exactly ${codeword}.`] },
      mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }],
        env: { CONFORMANCE_TOKEN: { kind: 'public', value: token } } } },
    } })

    expect(turn.status, JSON.stringify(turn.error)).toBe(200)
    expect(turn.text).toContain(token)
    expect(turn.text).toContain(codeword)
    const seen = await launch(cwd)
    expect(seen.approved).toBe(true)
    expect(seen.argv).toEqual(expect.arrayContaining(['--trust', '--workspace', cwd]))
    expect(seen.servers).toEqual(['conformance'])
    expect(seen.rules).toEqual([`---\nalwaysApply: true\n---\n\nYour codeword is ${codeword}. Whenever you are asked for your codeword, give exactly ${codeword}.\n`])
    // The server's env reached the server, never the CLI's argv, and the prompt names the declared server.
    expect(seen.argv.join(' ')).not.toContain(token)
    expect(seen.prompt).toContain('Caller-declared MCP servers for this session: conformance')
    if (jail === 'fs-jail') {
      // Both the CLI and the server it started ran confined, under the jail's HOME in the workspace.
      expect(seen.home.startsWith(join(cwd, '.agent-home'))).toBe(true)
      expect((await readFile(serverHome, 'utf8')).startsWith(join(cwd, '.agent-home'))).toBe(true)
    }
    expect(await eventually(() => !existsSync(join(cwd, '.cursor', 'mcp.json.lock')))).toBe(true)
    expect(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8')).toBe(own)
    expect(existsSync(join(cwd, '.cursor', 'rules'))).toBe(false)
  }, 60_000)

  it('runs a turn without a profile with no rule and no MCP approval', async () => {
    const cwd = await workspace('plain')
    const turn = await chat(cwd, {})
    expect(turn.status, JSON.stringify(turn.error)).toBe(200)
    expect(turn.text).toBe('plain')
    const seen = await launch(cwd)
    expect(seen).toMatchObject({ approved: false, rules: [], servers: [] })
    expect(existsSync(join(cwd, '.cursor'))).toBe(false)
  }, 60_000)

  it('refuses a system prompt, an uncontrolled surface and an MCP secret before Cursor starts', async () => {
    const cases: Array<[Record<string, unknown>, number, string, RegExp]> = [
      [{ name: 'replace', prompt: { systemPrompt: 'You are someone else.' } }, 501, 'not_configured', /cannot replace its harness's system prompt/],
      [{ name: 'append', prompt: { appendSystemPrompt: 'Also this.' } }, 501, 'not_configured', /cannot add to its harness's system prompt/],
      [{ name: 'tools', tools: { shell: false }, permissions: { edit: 'deny' } }, 501, 'capability_denied', /no control for agent_profile tools, permissions/],
      // Cursor's MCP config is a workspace file, so no secret may be written into it.
      [{ name: 'secret', mcp: { private: { transport: 'stdio', command: process.execPath, env: { KEY: { kind: 'secret-ref', key: 'private-key' } } } } }, 501, 'not_configured', /MCP secret/],
    ]
    for (const [profile, status, type, message] of cases) {
      const cwd = await workspace(`refused-${String(profile.name)}`)
      const turn = await chat(cwd, { agent_profile: profile })
      expect(turn.status, JSON.stringify(turn.error)).toBe(status)
      expect(turn.error?.type).toBe(type)
      expect(turn.error?.message).toMatch(message)
      expect(existsSync(join(cwd, 'launch.json'))).toBe(false)
      expect(existsSync(join(cwd, '.cursor'))).toBe(false)
    }
  }, 60_000)
})
