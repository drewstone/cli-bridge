import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

const nativePeer = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
if (process.argv.includes('--version')) { console.log('native-peer 1.0'); process.exit(0) }
async function main() {
  const argv = process.argv.slice(2), claude = argv.includes('--mcp-config')
  const configPath = claude ? argv[argv.indexOf('--mcp-config') + 1] : path.join(process.env.CODEX_HOME, 'config.toml')
  fs.appendFileSync(path.join(process.cwd(), 'private-config-paths.jsonl'), JSON.stringify({configPath}) + '\n')
  let servers
  if (claude) servers = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers
  else {
    const toml = fs.readFileSync(configPath, 'utf8')
    const block = name => new RegExp('\\[mcp_servers\\.' + name + '\\]([\\s\\S]*?)(?=\\n\\[|$)').exec(toml)?.[1] ?? ''
    const str = (part, key) => JSON.parse(new RegExp(key + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")').exec(part)[1])
    const remote = block('remote'), local = block('local')
    servers = {remote: {url:str(remote, 'url'), headers:{Authorization:str(remote,'Authorization')}}, local: {command:str(local,'command'), args:JSON.parse(/args\s*=\s*(\[[^\n]*\])/.exec(local)[1]), env:{MCP_PRIVATE:str(local,'MCP_PRIVATE')}}}
  }
  const remote = await fetch(servers.remote.url, {method:'POST',headers:{'content-type':'application/json',...servers.remote.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})
  if (remote.status !== 200) throw new Error('MCP HTTP credentials were not admitted')
  const child = cp.spawn(servers.local.command, servers.local.args, {env:{...process.env,...servers.local.env},stdio:['pipe','pipe','pipe']})
  const initialized = new Promise((resolve,reject) => { child.stdout.once('data', data => resolve(JSON.parse(String(data)))); child.once('error', reject); child.once('exit', code => {if(code)reject(new Error('MCP stdio failed'))}) })
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n')
  const answer = await initialized
  if (!answer.result?.protocolVersion) throw new Error('MCP stdio did not initialize')
  const echo = 'mcp-authenticated ' + servers.local.env.MCP_PRIVATE
  const emit = async value => { const line=JSON.stringify(value)+'\n', at=line.indexOf(servers.local.env.MCP_PRIVATE)+8; process.stdout.write(line.slice(0,at)); await new Promise(resolve=>setTimeout(resolve,10)); process.stdout.write(line.slice(at)) }
  process.stderr.write(servers.local.env.MCP_PRIVATE.slice(0,11)); await new Promise(resolve=>setTimeout(resolve,10)); process.stderr.write(servers.local.env.MCP_PRIVATE.slice(11)+'\n')
  if (claude) {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'private-native'}))
    await emit({type:'assistant',message:{id:'msg',content:[{type:'text',text:echo}]}})
    console.log(JSON.stringify({type:'result',subtype:'success',session_id:'private-native',usage:{input_tokens:0,output_tokens:0},total_cost_usd:0}))
  } else {
    console.log(JSON.stringify({type:'thread.started',thread_id:'private-native'}))
    await emit({type:'item.completed',item:{id:'message',type:'agent_message',text:echo}})
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}))
  }
}
main().catch(() => {console.error('native MCP check failed');process.exitCode=1})
`

async function bytesUnder(directory: string): Promise<Buffer[]> {
  const values: Buffer[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) values.push(...await bytesUnder(file))
    else if (entry.isFile()) values.push(await readFile(file))
  }
  return values
}

it.each([['claude', false], ['claude', true], ['codex', false], ['codex', true]] as const)('keeps %s MCP credentials private with raw capture %s', async (backend, capture) => {
  const root = await mkdtemp(join(tmpdir(), 'private-mcp-'))
  const captureRoot = await mkdtemp(join(tmpdir(), 'private-mcp-capture-'))
  if (capture) vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR', captureRoot)
  else vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR', '')
  const secret = 'private-mcp-provider-canary-9e5dff'
  const methods: string[] = []
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(403).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const rpc = JSON.parse(raw); methods.push(rpc.method)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('peer did not bind')
  const url = `http://127.0.0.1:${address.port}/mcp`
  const binary = join(root, 'native-peer.cjs'), stdio = join(root, 'mcp-peer.cjs')
  await writeFile(binary, `#!${process.execPath}\n${nativePeer}`, { mode: 0o700 })
  await writeFile(stdio, `const rl=require('node:readline').createInterface({input:process.stdin});rl.once('line',async line=>{const req=JSON.parse(line);const r=await fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.MCP_PRIVATE},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize'})});if(r.status!==200)process.exit(1);console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'private-peer',version:'1'}}}));rl.close()})`)
  const calls: string[] = []
  const server = await startServer({ cwd: root, quiet: true, handleSignals: false,
    config: loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '0', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: backend, BRIDGE_JAIL_MODE: 'off', CLAUDE_BIN: binary, CODEX_BIN: binary }),
    mcpSecrets: { async get(key) { calls.push(key); return key === 'private-tool' ? secret : undefined } },
  })
  const profile = { name: 'private-tool-agent', mcp: {
    remote: { transport: 'http', url, headers: { Authorization: { kind: 'secret-ref', key: 'private-tool', format: 'bearer' } } },
    local: { command: process.execPath, args: [{ kind: 'public', value: stdio }], env: { MCP_PRIVATE: { kind: 'secret-ref', key: 'private-tool' } } },
  } }
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: `${backend}/test`, session_id: `private-${backend}`, messages: [{ role: 'user', content: 'Use the declared tools' }], cwd: root, agent_profile: profile }) })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(text).toContain('mcp-authenticated [redacted:MCP]')
    expect(calls).toEqual(['private-tool'])
    expect(methods).toEqual(['tools/list', 'initialize'])
    expect(text + JSON.stringify(profile)).not.toContain(secret)
    const rejected = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: `${backend}/test`, messages: [{ role: 'user', content: 'Use the declared tools' }], cwd: root, agent_profile: { ...profile, mcp: { local: { command: process.execPath, args: [{ kind: 'secret-ref', key: 'private-tool' }] } } } }) })
    expect(rejected.status).not.toBe(200)
    expect(await rejected.text()).toContain('argv')
    expect(calls).toEqual(['private-tool'])
    for (const line of (await readFile(join(root, 'private-config-paths.jsonl'), 'utf8')).trim().split('\n'))
      await expect(access(JSON.parse(line).configPath)).rejects.toThrow()
  } finally {
    await server.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
  try {
    for (const bytes of [...await bytesUnder(root), ...await bytesUnder(captureRoot)]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
      for (const line of bytes.toString().split('\n')) {
        try { const frame = JSON.parse(line); if (frame.base64Bytes) expect(Buffer.from(frame.base64Bytes, 'base64').includes(Buffer.from(secret))).toBe(false) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
      }
    }
    if (capture) {
      const manifests = (await readdir(captureRoot)).filter(file => file.endsWith('.json'))
      expect(manifests.length).toBeGreaterThan(0)
      for (const name of manifests) expect(JSON.parse(await readFile(join(captureRoot, name), 'utf8')).redaction).toBe('private-mcp-secrets')
    }
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await rm(captureRoot, { recursive: true, force: true }) }
}, 30000)
