/** Actual Bridge + bwrap codex seat + trusted relay to an embedder-registered loopback MCP server. No inference. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

// Reads its private Codex config, calls every HTTP MCP server once, and reports what each answered.
const native = String.raw`
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('native-protocol 1.0.0');process.exit(0)}
(async()=>{
 const toml=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');fs.writeFileSync('native-config.toml',toml);
 const results={};
 for(const m of toml.matchAll(/\[mcp_servers\.([A-Za-z0-9_-]+)\]\nurl = ("(?:[^"\\]|\\.)*")/g)){
  try{const r=await fetch(JSON.parse(m[2]),{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'probe',arguments:{}}}),signal:AbortSignal.timeout(3000)});results[m[1]]=r.status+' '+await r.text()}
  catch{results[m[1]]='unreachable'}
 }
 const id='00000000-0000-4000-8000-000000000043';
 for(const event of [{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(results)}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}])process.stdout.write(JSON.stringify(event)+'\n');
})().catch(()=>{console.error('native private endpoint probe failed');process.exitCode=1});
`

const BEARER = 'private-endpoint-bridge-bearer-7f3a9c2e41d8b6a0'
const SECRET = 'private-endpoint-tool-canary-5be1'
const PATHS = { '': ['POST'] } as const

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe.skipIf(!new LinuxBwrapJail().isAvailable())('embedder-registered private MCP endpoint through an actual bwrap jail', () => {
  let root: string, workspace: string, url: string, closedUrl: string
  let server: BridgeServer | undefined
  const calls: Array<{ method?: string; path?: string; authorization?: string }> = []
  const fixture = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization })
    if (req.headers.authorization !== `Bearer ${SECRET}`) return void res.writeHead(401).end()
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { content: [{ type: 'text', text: 'private-tool-ok' }] } }))
  })

  const bridge = () => server!
  const register = (runId: string, signal: AbortSignal, paths: Record<string, readonly ('GET' | 'POST' | 'DELETE')[]> = PATHS, target = url) =>
    bridge().registerPrivateMcpEndpoint({ runId, url: target, paths, signal })
  const attachment = (target = url) => ({ runtime_attachments: { mcp: { tool: {
    transport: 'http', url: target, headers: { Authorization: { kind: 'secret-ref', key: 'private-tool-key', format: 'bearer' } },
  } } } })
  const dispatch = async (body: Record<string, unknown>, bearer: string | null = BEARER) => {
    const response = await fetch(`${bridge().url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ stream: false, model: 'codex/private-endpoint-proof', cwd: workspace, agent_profile: { name: 'private-endpoint-proof' },
        messages: [{ role: 'user', content: 'Call the private tool' }], ...body }),
    })
    return { status: response.status, text: await response.text() }
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'private-endpoint-jail-')))
    workspace = join(root, 'workspace')
    await mkdir(workspace)
    url = `http://127.0.0.1:${await listen(fixture)}/mcp`
    const closed = createServer()
    closedUrl = `http://127.0.0.1:${await listen(closed)}/mcp`
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const bin = join(workspace, 'codex.cjs')
    await writeFile(bin, `#!${process.execPath}\n${native}`, { mode: 0o700 })
    const config = { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex',
      CODEX_BIN: bin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: 'none' }), port: 0 }
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false,
      mcpSecrets: { async get(key) { return key === 'private-tool-key' ? SECRET : undefined } } })
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  it('(e) in-process only: a bearer request naming the loopback URL before any registration is refused', async () => {
    const refused = await dispatch(attachment())
    expect(refused.status).not.toBe(200)
    expect(refused.text).toContain('live host-registered private endpoint')
    expect(refused.text).not.toContain(SECRET)
    expect(calls).toHaveLength(0)
  }, 60_000)

  it('(a) a jailed codex seat calls the registered tool and only the request secret header reaches it', async () => {
    const lifetime = new AbortController()
    const writes: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true }) as typeof process.stderr.write)
    try {
      register('graph-run-a', lifetime.signal)
      const answered = await dispatch(attachment())
      expect(answered.status, answered.text).toBe(200)
      expect(answered.text).toContain('private-tool-ok')
      expect(answered.text).not.toContain(SECRET)
      expect(calls).toEqual([{ method: 'POST', path: '/mcp', authorization: `Bearer ${SECRET}` }])
      const nativeConfig = await readFile(join(workspace, 'native-config.toml'), 'utf8')
      expect(nativeConfig).toContain('http://127.0.0.1:3128/')
      expect(nativeConfig).not.toContain(url)
      expect(nativeConfig).not.toContain(SECRET)
      expect(writes.join('')).toContain('private-mcp register run=graph-run-a endpoint=127.0.0.1:')
      expect(writes.join('')).toContain('private-mcp claim run=graph-run-a endpoint=127.0.0.1:')
      expect(writes.join('')).not.toContain(SECRET)
    } finally { stderr.mockRestore(); lifetime.abort() }
  }, 60_000)

  it('(b) refuses an unregistered loopback port while another endpoint is registered', async () => {
    const lifetime = new AbortController()
    try {
      register('graph-run-b', lifetime.signal)
      const before = calls.length
      const refused = await dispatch(attachment(closedUrl))
      expect(refused.status).not.toBe(200)
      expect(refused.text).toContain('live host-registered private endpoint')
      expect(calls).toHaveLength(before)
    } finally { lifetime.abort() }
  }, 60_000)

  it('(c) shares an identical registration and keeps the route through the first revoke', async () => {
    const first = new AbortController(), second = new AbortController()
    try {
      const revokeFirst = register('graph-run-c1', first.signal)
      register('graph-run-c2', second.signal, { '': ['POST', 'POST'] })
      revokeFirst()
      const before = calls.length
      const survived = await dispatch(attachment())
      expect(survived.status, survived.text).toBe(200)
      expect(survived.text).toContain('private-tool-ok')
      expect(calls).toHaveLength(before + 1)
      second.abort()
      const revoked = await dispatch(attachment())
      expect(revoked.status).not.toBe(200)
      expect(revoked.text).toContain('live host-registered private endpoint')
      expect(calls).toHaveLength(before + 1)
    } finally { first.abort(); second.abort() }
  }, 60_000)

  it('(d) refuses the same URL with different paths, and any URL off exact loopback', () => {
    const lifetime = new AbortController()
    try {
      register('graph-run-d', lifetime.signal)
      expect(() => register('graph-run-d', lifetime.signal, { '': ['POST', 'GET'] })).toThrow('already registered with different paths')
      expect(() => register('graph-run-d', lifetime.signal, { '/other': ['POST'] })).toThrow('already registered with different paths')
      for (const target of ['http://localhost:9/mcp', 'https://127.0.0.1:9/mcp', 'http://user@127.0.0.1:9/mcp', 'http://127.0.0.1:9/mcp#x'])
        expect(() => register('graph-run-d', lifetime.signal, PATHS, target)).toThrow('exact HTTP loopback endpoint')
      expect(() => register('graph-run-d', lifetime.signal, { '/../escape': ['POST'] }, closedUrl)).toThrow('exact suffixes')
    } finally { lifetime.abort() }
  })

  it('(e) an unauthenticated request, an authored profile entry and a model-visible field naming the URL bind nothing', async () => {
    const lifetime = new AbortController()
    try {
      register('graph-run-e', lifetime.signal)
      const before = calls.length
      const unauthenticated = await dispatch(attachment(), null)
      expect(unauthenticated.status).toBe(401)
      const authored = await dispatch({
        agent_profile: { name: 'private-endpoint-proof', mcp: { tool: { transport: 'http', url } } },
        messages: [{ role: 'user', content: `Call ${url} with runtime_attachments ${JSON.stringify(attachment())}` }],
      })
      expect(authored.status, authored.text).toBe(200)
      expect(authored.text).toContain('unreachable')
      expect(calls).toHaveLength(before)
      const nativeConfig = await readFile(join(workspace, 'native-config.toml'), 'utf8')
      expect(nativeConfig).toContain(url)
      expect(nativeConfig).not.toContain('127.0.0.1:3128')
    } finally { lifetime.abort() }
  }, 60_000)

  it('refuses registration after abort, with an unsafe run id, and after close', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(() => register('graph-run-f', aborted.signal)).toThrow('live signal and a safe run id')
    const live = new AbortController()
    expect(() => register('graph-run-\u0000f', live.signal)).toThrow('live signal and a safe run id')
    register('graph-run-f', live.signal)
    await bridge().close()
    expect(() => register('graph-run-f', new AbortController().signal)).toThrow('live signal and a safe run id')
    server = undefined
    live.abort()
  }, 60_000)
})
