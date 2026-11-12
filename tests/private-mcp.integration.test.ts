import { createHash } from 'node:crypto'
import { HubClient } from '@tangle-network/hub-sdk'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'
import type { StartServerOptions } from '../src/server-options.js'

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
    servers = {hub:{url:str(block('hub'),'url')},coord:{url:str(block('coord'),'url'),headers:{Authorization:str(block('coord'),'Authorization')}},remote: {url:str(remote, 'url'), headers:{Authorization:str(remote,'Authorization')}}, local: {command:str(local,'command'), args:JSON.parse(/args\s*=\s*(\[[^\n]*\])/.exec(local)[1]), env:{MCP_PRIVATE:str(local,'MCP_PRIVATE')}}}
  }
  const remote = await fetch(servers.remote.url, {method:'POST',headers:{'content-type':'application/json',...servers.remote.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})
  if (remote.status !== 200) throw new Error('MCP HTTP credentials were not admitted')
  const child = cp.spawn(servers.local.command, servers.local.args, {env:{...process.env,...servers.local.env},stdio:['pipe','pipe','pipe']})
  const initialized = new Promise((resolve,reject) => { child.stdout.once('data', data => resolve(JSON.parse(String(data)))); child.once('error', reject); child.once('exit', code => {if(code)reject(new Error('MCP stdio failed'))}) })
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n')
  const answer = await initialized
  if (!answer.result?.protocolVersion) throw new Error('MCP stdio did not initialize')
  const tools = await fetch(servers.hub.url+'/tools').then(r => r.json())
  if (!tools.tools?.length) throw new Error('Hub grant did not resolve its tool')
  const invoked = await fetch(servers.hub.url+'/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:tools.tools[0].name,arguments:{proof:true}})}).then(r=>r.json())
  if (invoked.isError) throw new Error('Hub grant did not authorize its tool')
  if ((await fetch(servers.coord.url,{headers:servers.coord.headers})).status!==200) throw new Error('Coordination bearer did not reach its private native config')
  const protectedValues = [servers.local.env.MCP_PRIVATE,servers.hub.url.split('/').pop(),servers.coord.headers.Authorization.slice(7)]
  const echo = 'mcp-authenticated ' + protectedValues.join(' ')
  const nativeId = require('node:crypto').randomUUID()
  const vendorRoot = claude ? (process.env.CLAUDE_CONFIG_DIR || path.join(process.cwd(),'.claude')) : process.env.CODEX_HOME
  const vendorDir = path.join(vendorRoot,claude?'projects/owned-native':'sessions/2026/11/12')
  fs.mkdirSync(vendorDir,{recursive:true})
  const vendorFile = path.join(vendorDir,claude?nativeId+'.jsonl':'rollout-2026-11-12T00-00-00-'+nativeId+'.jsonl')
  const records = claude ? [{type:'user',sessionId:nativeId,cwd:process.cwd(),message:{role:'user',content:'private native tool proof'}},{type:'assistant',sessionId:nativeId,message:{role:'assistant',content:[{type:'text',text:echo}]}}]
    : [{type:'session_meta',payload:{id:nativeId,cwd:process.cwd()}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:echo}]}}]
  fs.writeFileSync(vendorFile,records.map(record=>JSON.stringify(record)).join('\n')+'\n')
  fs.writeFileSync(path.join(process.cwd(),'private-vendor-path.txt'),vendorFile)


  const emit = async (value,secret=protectedValues[0]) => { const line=JSON.stringify(value)+'\n', at=line.indexOf(JSON.stringify(secret).slice(1,-1))+8; process.stdout.write(line.slice(0,at)); await new Promise(resolve=>setTimeout(resolve,10)); process.stdout.write(line.slice(at)) }
  for (const secret of protectedValues) { process.stderr.write(secret.slice(0,11)); await new Promise(resolve=>setTimeout(resolve,10)); process.stderr.write(secret.slice(11)+'\n') }
  if (claude) {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:nativeId}))
    for (const secret of protectedValues) await emit({type:'assistant',message:{id:'msg',content:[{type:'text',text:echo}]}},secret)
    console.log(JSON.stringify({type:'result',subtype:'success',session_id:nativeId,usage:{input_tokens:0,output_tokens:0},total_cost_usd:0}))
  } else {
    console.log(JSON.stringify({type:'thread.started',thread_id:nativeId}))
    for (const secret of protectedValues) await emit({type:'item.completed',item:{id:'message',type:'agent_message',text:echo}},secret)
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}))
  }
}
main().catch(() => {console.error('native MCP check failed');process.exitCode=1})
`

async function bytesUnder(directory: string, excluded: ReadonlySet<string> = new Set()): Promise<Buffer[]> {
  const values: Buffer[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) values.push(...await bytesUnder(file, excluded))
    else if (entry.isFile() && !excluded.has(file)) values.push(await readFile(file))
  }
  return values
}

function processStreams(files: readonly Buffer[]): Buffer[] {
  const streams = new Map<string, Buffer[]>()
  for (const bytes of files) for (const line of bytes.toString().split('\n')) {
    try {
      const frame = JSON.parse(line)
      if (typeof frame.processId !== 'string' || !['stdout','stderr','protocol'].includes(frame.stream) || typeof frame.base64Bytes !== 'string') continue
      const key = `${frame.processId}/${frame.stream}`
      const stream = streams.get(key) ?? []
      stream.push(Buffer.from(frame.base64Bytes,'base64')); streams.set(key,stream)
    } catch (error) { if (!(error instanceof SyntaxError)) throw error }
  }
  return [...streams.values()].map(chunks => Buffer.concat(chunks))
}

it.each([['claude', false], ['claude', true], ['codex', false], ['codex', true]] as const)('keeps %s MCP credentials private with raw capture %s', async (backend, capture) => {
  const harness = backend === 'claude' ? 'claude-code' : backend
  const root = await mkdtemp(join(tmpdir(), 'private-mcp-'))
  const captureRoot = await mkdtemp(join(tmpdir(), 'private-mcp-capture-'))
  if (capture) vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR', captureRoot)
  else vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR', '')
  const secret = 'private-mcp-provider-canary-9e5dff-quote-"\\'
  const methods: string[] = []
  const grantTokens: string[] = []
  const coordination = 'private-coordination-provider-canary-6ab256'
  const hubKey = 'public-hub-client-fixture'
  let hubInvoked = 0, coordinationInvoked = 0
  let vendorPath = "", vendorDigest = ""
  const upstream = createServer(async (request, response) => {
    if (request.url?.startsWith('/v1/hub/')) {
      if (request.headers.authorization !== `Bearer ${hubKey}`) { response.writeHead(403).end(); return }
      let raw=''; for await (const chunk of request) raw+=chunk
      const data = request.url === '/v1/hub/connections' ? {connections:[{id:'hubconn_fixture',providerId:'fixture',status:'active'}]}
        : request.url === '/v1/hub/tools/describe' ? {tool:{path:'fixture.proof',requiredConnectionProviderId:'fixture',inputSchema:{type:'object'}}}
        : request.url === '/v1/hub/exec' ? (hubInvoked++,{result:{ok:JSON.parse(raw).connectionId==='hubconn_fixture'}}) : undefined
      response.writeHead(data ? 200 : 404, {'content-type':'application/json'}).end(JSON.stringify({success:!!data,data})); return
    }
    if (request.url === '/coord') {
      if (request.headers.authorization !== `Bearer ${coordination}`) { response.writeHead(403).end(); return }
      coordinationInvoked++; response.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}'); return
    }
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
  const redactors: Parameters<NonNullable<StartServerOptions['onRunRedaction']>>[0][] = []
  const createHost = () => startServer({ cwd: root, quiet: true, handleSignals: false,
    config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: backend, BRIDGE_JAIL_MODE: 'off', CLAUDE_BIN: binary, CODEX_BIN: binary }), port: 0 },
    onRunRedaction: run => redactors.push(run),
    mcpSecrets: { async get(key) { calls.push(key); return key === 'private-tool' ? secret : undefined } },
    hub: { client: new HubClient({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:hubKey}),
      hash: value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'),
      serverForGrant(token) { grantTokens.push(token); return {transport:'http',url:`${server.url}/hub/mcp/grants/${token}`} } },
  })
  let server = await createHost()
  const profile = { name: 'private-tool-agent', connections:[{connectionId:'hubconn_fixture',capabilities:['fixture.proof'],alias:'hub'}], mcp: {
    remote: { transport: 'http', url, headers: { Authorization: { kind: 'secret-ref', key: 'private-tool', format: 'bearer' } } },
    local: { command: process.execPath, args: [{ kind: 'public', value: stdio }], env: { MCP_PRIVATE: { kind: 'secret-ref', key: 'private-tool' } } },
  } }
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: `${harness}/test`, session_id: `private-${backend}`, messages: [{ role: 'user', content: 'Use the declared tools' }], cwd: root, agent_profile: profile, env:{AGENT_RUNTIME_COORDINATION_TOKEN:coordination,CLAUDE_CONFIG_DIR:join(root,"claude-home")}, runtime_attachments:{mcp:{coord:{transport:'http',url:`http://127.0.0.1:${address.port}/coord`,headers:{Authorization:{kind:'secret-ref',key:'AGENT_RUNTIME_COORDINATION_TOKEN',format:'bearer'}}}}} }) })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(text).toContain('mcp-authenticated [redacted:MCP]')
    expect(calls).toEqual(['private-tool'])
    expect(methods).toEqual(['tools/list', 'initialize'])
    expect(hubInvoked).toBe(1)
    expect(coordinationInvoked).toBe(1)
    expect(grantTokens).toHaveLength(1)
    expect(redactors).toHaveLength(1)
    const authority = redactors[0]!
    const terminal = await fetch(`${server.url}/v1/runs/${encodeURIComponent(authority.runId)}`).then(r => r.json())
    expect(terminal.nativeCapture).toMatchObject({status:'unavailable'})
    // This HTTP/authentication fixture is deliberately unjailed; it cannot attest a retained native producer copy.
    expect(Object.isFrozen(authority)).toBe(true)
    expect(authority).toMatchObject({sessionId:`private-${backend}`,cwd:root,profileDigest:expect.stringMatching(/^sha256:/),requestDigest:expect.stringMatching(/^sha256:/)})
    vendorPath = await readFile(join(root,'private-vendor-path.txt'),'utf8')
    expect(vendorPath.startsWith(root+"/")).toBe(true)
    const source = await readFile(vendorPath)
    vendorDigest = createHash('sha256').update(source).digest('hex')
    const copied = Buffer.from(authority.redact(source))
    expect(createHash("sha256").update(await readFile(vendorPath)).digest("hex")).toBe(vendorDigest)
    await writeFile(join(captureRoot,"redacted-native.jsonl"),copied)
    for (const value of [secret,coordination,...grantTokens]) {
      expect(copied.toString()).not.toContain(value)
      expect(copied.toString()).not.toContain(JSON.stringify(value).slice(1,-1))
      expect(JSON.stringify(authority)).not.toContain(value)
    }
    expect(copied.toString()).toContain('[redacted:MCP]')
    expect((await fetch(`${server.url}/hub/mcp/grants/${grantTokens[0]}/tools`)).status).toBe(403)
    for (const value of [secret, coordination, hubKey, ...grantTokens]) expect(text).not.toContain(value)
    expect(text + JSON.stringify(profile)).not.toContain(secret)
    const rejected = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: `${harness}/test`, messages: [{ role: 'user', content: 'Use the declared tools' }], cwd: root, agent_profile: { ...profile, mcp: { local: { command: process.execPath, args: [{ kind: 'secret-ref', key: 'private-tool' }] } } } }) })
    expect(rejected.status).not.toBe(200)
    expect(await rejected.text()).toContain('argv')
    expect(calls).toEqual(['private-tool'])
    const missing = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: `${harness}/test`, messages: [{ role: 'user', content: 'Use the declared tools' }], cwd: root, agent_profile: { ...profile, mcp: { local: { command: process.execPath, env: { MCP_PRIVATE: { kind: 'secret-ref', key: 'unbound' } } } } } }) })
    expect(missing.status).not.toBe(200)
    expect(await missing.text()).toContain('missing or invalid')
    expect(calls).toEqual(['private-tool', 'unbound'])
    expect((await readFile(join(root, 'private-config-paths.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    for (const line of (await readFile(join(root, 'private-config-paths.jsonl'), 'utf8')).trim().split('\n'))
      await expect(access(JSON.parse(line).configPath)).rejects.toThrow()
    // The original vendor conversation still contains the now-revoked first Hub grant.
    expect((await readFile(vendorPath,'utf8')).includes(grantTokens[0]!)).toBe(true)
    await server.close()
    server = await createHost()
    const readback = await fetch(`${server.url}/v1/runs/${encodeURIComponent(authority.runId)}`).then(r => r.json())
    expect(readback.requestDigest).toBe(authority.requestDigest)
    expect(readback.nativeCapture).toEqual(terminal.nativeCapture)
    const resume = await fetch(`${server.url}/v1/chat/completions`, { method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:`${harness}/test`,session_id:`private-${backend}`,run_id:`restart-private-${backend}`,
        cwd:root,agent_profile:profile,messages:[{role:'user',content:'Continue the original native conversation'}],
        metadata:{native_redaction_history:{protectedHistory:false}},
        env:{AGENT_RUNTIME_COORDINATION_TOKEN:coordination,CLAUDE_CONFIG_DIR:join(root,'claude-home')},
        runtime_attachments:{mcp:{coord:{transport:'http',url:`http://127.0.0.1:${address.port}/coord`,headers:{Authorization:{kind:'secret-ref',key:'AGENT_RUNTIME_COORDINATION_TOKEN',format:'bearer'}}}}}}) })
    expect(resume.status).not.toBe(200)
    expect(await resume.text()).toContain('redaction history is unavailable')
    expect((await readFile(join(root,'private-config-paths.jsonl'),'utf8')).trim().split('\n')).toHaveLength(1)
    expect(redactors).toHaveLength(1)
    expect(methods).toEqual(['tools/list','initialize'])
    expect(hubInvoked).toBe(1)
    expect(coordinationInvoked).toBe(1)
    expect(createHash('sha256').update(await readFile(vendorPath)).digest('hex')).toBe(vendorDigest)
  } finally {
    await server.close()
    for (const redactor of redactors) expect(() => redactor.redact(new Uint8Array())).toThrow('closed')
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
  try {
    expect(createHash('sha256').update(await readFile(vendorPath)).digest('hex')).toBe(vendorDigest)
    const retained = [...await bytesUnder(root,new Set([vendorPath])), ...await bytesUnder(captureRoot)]
    const streams = processStreams(retained)
    for (const bytes of [...retained,...streams]) for (const value of [secret,coordination,hubKey,...grantTokens]) {
      expect(bytes.includes(Buffer.from(value))).toBe(false)
      expect(bytes.includes(Buffer.from(JSON.stringify(value).slice(1,-1)))).toBe(false)
    }
    if (capture) {
      expect(streams.length).toBeGreaterThan(0)
      const manifests = (await readdir(captureRoot)).filter(file => file.endsWith('.json'))
      expect(manifests.length).toBeGreaterThan(0)
      for (const name of manifests) expect(JSON.parse(await readFile(join(captureRoot, name), 'utf8')).redaction).toBe('private-mcp-secrets')
    }
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await rm(captureRoot, { recursive: true, force: true }) }
}, 30000)

it.each([false,true])('fences historical private output on a host backend without vendor-family capture (raw %s)', async (capture) => {
  const root = await mkdtemp(join(tmpdir(),'private-opencode-history-'))
  const captureRoot = await mkdtemp(join(tmpdir(),'private-opencode-frames-'))
  vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR',capture ? captureRoot : '')
  const old = 'private-opencode-prior-"coordination"-canary-a783\\tail'
  const next = 'private-opencode-next-"coordination"-canary-c294\\tail'
  let expected = old, effects = 0
  const upstream = createServer((request,response) => {
    if (request.headers.authorization !== `Bearer ${expected}`) { response.writeHead(403).end(); return }
    effects++; response.writeHead(200).end('{}')
  })
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve))
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('peer did not bind')
  const bin = join(root,'opencode-peer.cjs')
  await writeFile(bin,`#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv.includes('--version')){console.log('opencode 1.0.0');process.exit(0)}
async function main(){
 const config=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'));
 fs.appendFileSync('native-launches','launched\\n');
 const auth=config.mcp.coord.headers.Authorization;
 if((await fetch(config.mcp.coord.url,{headers:{Authorization:auth}})).status!==200)throw new Error('private tool denied');
 const prior=fs.existsSync('native-conversation')?fs.readFileSync('native-conversation','utf8'):auth;
 fs.writeFileSync('native-conversation',prior);
 const text=Buffer.from(JSON.stringify({type:'text',sessionID:'owned-opencode-history',part:{type:'text',text:prior+' '+auth}})+'\\n');
 for(let at=0;at<text.length;at+=7){process.stdout.write(text.subarray(at,at+7));await new Promise(resolve=>setTimeout(resolve,1));}
 console.log(JSON.stringify({type:'turn.completed',sessionID:'owned-opencode-history',usage:{input_tokens:1,output_tokens:1}}));
} main().catch(()=>{console.error('native peer failed');process.exitCode=1});`,{mode:0o700})
  const createHost = () => startServer({ cwd:root,quiet:true,handleSignals:false,
    config:{...loadConfig({BRIDGE_HOST:'127.0.0.1',BRIDGE_DATA_DIR:join(root,'state'),BRIDGE_BACKENDS:'opencode',OPENCODE_BIN:bin,BRIDGE_TRACE:'off',BRIDGE_JAIL_MODE:'off'}),port:0} })
  let server = await createHost()
  const body = (token:string,runId:string) => JSON.stringify({stream:true,model:'opencode/history-fixture',session_id:'private-opencode-history',run_id:runId,cwd:root,
    messages:[{role:'user',content:'Use the private tool and continue the native conversation'}],env:{AGENT_RUNTIME_COORDINATION_TOKEN:token},
    runtime_attachments:{mcp:{coord:{transport:'http',url:`http://127.0.0.1:${address.port}/mcp`,headers:{Authorization:{kind:'secret-ref',key:'AGENT_RUNTIME_COORDINATION_TOKEN',format:'bearer'}}}}}})
  try {
    const first = await fetch(`${server.url}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:body(old,'private-opencode-first')})
    const text = await first.text()
    expect(first.status,text).toBe(200)
    expect(text).toContain('[redacted:MCP]')
    expect(text).not.toContain(old)
    expect(effects).toBe(1)
    expect(await readFile(join(root,'native-conversation'),'utf8')).toContain(old)
    expected = next
    const second = await fetch(`${server.url}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:body(next,'private-opencode-live-continuation')})
    const secondText = await second.text()
    expect(second.status,secondText).toBe(200)
    expect(secondText).toContain('[redacted:MCP]')
    expect(secondText).not.toContain(old)
    expect(secondText).not.toContain(next)
    expect(secondText).not.toContain(JSON.stringify(old).slice(1,-1))
    expect(secondText).not.toContain(JSON.stringify(next).slice(1,-1))
    expect(effects).toBe(2)
    await server.close(); server = await createHost()
    const held = await fetch(`${server.url}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:body(next,'private-opencode-after-restart')})
    expect(held.status).not.toBe(200)
    expect(await held.text()).toContain('redaction history is unavailable')
    expect((await readFile(join(root,'native-launches'),'utf8')).trim().split('\n')).toHaveLength(2)
    expect(effects).toBe(2)
    const retained = [...await bytesUnder(root,new Set([join(root,'native-conversation')])),...await bytesUnder(captureRoot)]
    for (const bytes of [...retained,...processStreams(retained)]) {
      expect(bytes.includes(Buffer.from(old))).toBe(false)
      expect(bytes.includes(Buffer.from(next))).toBe(false)
      expect(bytes.includes(Buffer.from(JSON.stringify(old).slice(1,-1)))).toBe(false)
      expect(bytes.includes(Buffer.from(JSON.stringify(next).slice(1,-1)))).toBe(false)
    }
    if(capture) expect(processStreams(retained).length).toBeGreaterThan(0)
  } finally {
    await server.close()
    await new Promise<void>(resolve => upstream.close(()=>resolve()))
    vi.unstubAllEnvs()
    await rm(root,{recursive:true,force:true})
    await rm(captureRoot,{recursive:true,force:true})
  }
},30000)
