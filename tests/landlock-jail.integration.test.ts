/** Real kernel confinement, including deliberately unconfined negative controls. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { link, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostSpawner } from '../src/executors/host.js'
import { LinuxLandlockJail, selectJailBackend } from '../src/jail/index.js'
import { JAIL_HOST_EGRESS_ENV } from '../src/config.js'
import { resolveJailSpec } from '../src/jail/resolve-spec.js'
import type { JailSpec } from '../src/jail/types.js'
import { loadConfig, startServer } from '../src/server.js'

const launcher = fileURLToPath(new URL('../src/jail/landlock-exec.py', import.meta.url))
const probe = spawnSync('python3', ['-I', '-S', launcher, '--probe'], { encoding: 'utf8' })
const enabled = process.platform === 'linux' && probe.status === 0
const jail = new LinuxLandlockJail()
const savedEnv = { ...process.env }
let base: string, workspace: string, root: string, outside: string, readonly: string, standin: string
let forcePath: string, backendBin: string

async function output(child: ChildProcess) {
  let stdout = '', stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk })
  child.stderr!.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

async function run(code: string, spec: JailSpec, unconfined = false) {
  if (!unconfined) {
    const result = await hostSpawner(process.execPath, ['-e', code], { cwd: workspace, jail: spec, env: { PATH: process.env.PATH } })
    try { return await output(result.child) } finally { await result.terminate?.(); result.release() }
  }
  const wrapped = await jail.wrap(process.execPath, ['-e', code], spec)
  // Replace only the launcher. The same argv, policy, env and cwd reach the command.
  const args = wrapped.args.map((arg) => arg === launcher ? standin : arg)
  try { return await output(spawn(wrapped.bin, args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })) }
  finally { await wrapped.cleanup?.() }
}

function spec(extra: Partial<JailSpec> = {}): JailSpec {
  return { root, projectDir: workspace, readConfine: true, hostEgressEnforced: true, network: 'none', extraReadablePaths: [readonly], ...extra }
}

async function discriminate(name: string, code: string, policy = spec()) {
  const red = await run(code, policy, true)
  expect(red.code, `${name}: stand-in must fail the confinement assertion: ${red.stdout} ${red.stderr}`).not.toBe(0)
  expect(red.stderr).toContain('AssertionError')
  const green = await run(code, policy)
  expect(green.code, `${name}: ${green.stderr}`).toBe(0)
  console.log(`${name}: stand-in RED exit=${red.code}; Landlock GREEN exit=${green.code}`)
}

// Never silently report acceptance on an unqualified gate host.
describe.skipIf(!enabled)(`Landlock real spawn (ABI ${probe.stdout.trim() || 'unavailable'})`, () => {
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'landlock-proof-')))
    workspace = join(base, 'workspace'); root = join(workspace, '.agent-home')
    const home = join(base, 'home'), tools = join(base, 'tools')
    for (const path of [workspace, home, tools]) await mkdir(path)
    outside = join(base, 'outside'); readonly = join(base, 'readonly')
    await writeFile(outside, 'outside'); await writeFile(readonly, 'inside-readonly')
    // Force an unusable bubblewrap in THIS test’s environment, irrespective of host namespaces.
    await writeFile(join(tools, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    forcePath = `${tools}${delimiter}${savedEnv.PATH}`
    process.env.PATH = forcePath; process.env.HOME = home
    process.env.BRIDGE_JAIL_BACKEND = 'landlock'
    process.env.GIT_CONFIG_GLOBAL = join(home, 'absent-config')
    delete process.env.XDG_CONFIG_HOME; delete process.env.GIT_PRIVACY_DENYLIST
    standin = join(base, 'unconfined.py')
    await writeFile(standin, "import json,os,sys\nwith open(sys.argv[1]) as f: p=json.load(f)\nos.environ.update(p['env'])\nos.chdir(p['cwd'])\nos.execvpe(sys.argv[2],sys.argv[2:],os.environ)\n")
    backendBin = join(workspace, 'codex.cjs')
    // Same native event protocol fixture as the existing jailed private-endpoint integration.
    await writeFile(backendBin, `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('fixture 1.0.0'); process.exit(0) }\nrequire('node:assert/strict').throws(()=>require('node:fs').readFileSync(${JSON.stringify(outside)}),{code:'EACCES'});\nfor(const e of [{type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000043'},{type:'item.completed',item:{type:'agent_message',text:'confined-turn-ok'}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}]) console.log(JSON.stringify(e))\n`, { mode: 0o700 })
    expect(selectJailBackend().name).toBe('landlock')
    console.log(`kernel=${spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()} Landlock ABI=${probe.stdout.trim()}`)
  })
  afterAll(async () => {
    process.env = savedEnv
    await rm(base, { recursive: true, force: true })
  })

  it('a: reads only allowed files, including through symlinks', async () => {
    await discriminate('a', `const fs=require('node:fs'),a=require('node:assert/strict');
      a.equal(fs.readFileSync(${JSON.stringify(readonly)},'utf8'),'inside-readonly');
      fs.symlinkSync(${JSON.stringify(outside)},process.env.HOME+'/escape-'+process.pid);
      for(const p of [${JSON.stringify(outside)},process.env.HOME+'/escape-'+process.pid]) a.throws(()=>fs.readFileSync(p),{code:'EACCES'});`)
  })

  it('b: writes only allowed paths; shared /tmp is denied and TMPDIR works', async () => {
    const shared = join(tmpdir(), `landlock-shared-${base.split('/').at(-1)}`)
    try {
      await discriminate('b', `const fs=require('node:fs'),a=require('node:assert/strict');
        fs.writeFileSync(process.env.HOME+'/inside','ok'); fs.writeFileSync(process.env.TMPDIR+'/inside','ok');
        a.equal(fs.readFileSync(process.env.TMPDIR+'/inside','utf8'),'ok');
        a.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'bad'),{code:'EACCES'});
        a.throws(()=>fs.truncateSync(${JSON.stringify(readonly)},0),{code:'EACCES'});
        a.throws(()=>fs.writeFileSync(${JSON.stringify(shared)},'bad'),{code:'EACCES'});`)
    } finally { await writeFile(outside, 'outside'); await writeFile(readonly, 'inside-readonly'); await rm(shared, { force: true }) }
  })

  it('c: child and grandchild inherit the restriction', async () => {
    const leaf = `const fs=require('node:fs'),a=require('node:assert/strict');a.throws(()=>fs.readFileSync(${JSON.stringify(outside)}),{code:'EACCES'});console.log('inherited')`
    const child = `const p=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(leaf)}],{encoding:'utf8'});require('node:assert/strict').equal(p.status,0,p.stderr);process.stdout.write(p.stdout)`
    await discriminate('c', `const cp=require('node:child_process'),a=require('node:assert/strict');for(const code of [${JSON.stringify(leaf)},${JSON.stringify(child)}]){const p=cp.spawnSync(process.execPath,['-e',code],{encoding:'utf8'});a.equal(p.status,0,p.stderr);a.match(p.stdout,/inherited/);}`)
  })

  it('d: relay TCP port works, another loopback TCP port and all TCP binds fail', async () => {
    const listener = createServer((socket) => socket.end('outside'))
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    try {
      const port = (listener.address() as AddressInfo).port
      await discriminate('d', `const net=require('node:net'),a=require('node:assert/strict');
        const connect=(port)=>new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r('ok')});s.on('error',e=>r(e.code))});
        (async()=>{a.equal(await connect(Number(new URL(process.env.HTTP_PROXY).port)),'ok');a.equal(await connect(${port}),'EACCES');
        const bound=await new Promise(r=>{const s=net.createServer();s.on('error',e=>r(e.code));s.listen(0,'127.0.0.1',()=>s.close(()=>r('ok')))});a.equal(bound,'EACCES')})().catch(e=>{console.error(e);process.exitCode=1})`, spec({ network: 'router', hostEgressEnforced: true }))
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())) }
  })

  function config(allow = true, network: 'none' | 'relay' = 'none', selected = true) {
    return { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(base, `state-${allow}-${network}`), BRIDGE_BACKENDS: 'codex',
      CODEX_BIN: backendBin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: network,
      ...(selected ? { BRIDGE_JAIL_BACKEND: 'landlock' } : {}), [JAIL_HOST_EGRESS_ENV]: allow ? '1' : '0' }), port: 0 }
  }

  it('e/f: fs-jail server starts without bubblewrap and a real backend turn completes', async () => {
    const server = await startServer({ config: config(), cwd: workspace, quiet: true, handleSignals: false })
    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, model: 'codex/confinement-proof', cwd: workspace, messages: [{ role: 'user', content: 'Reply' }] }) })
      const body = await response.text()
      expect(response.status, body).toBe(200); expect(body).toContain('confined-turn-ok')
    } finally { await server.close() }
  }, 60_000)

  it('f: both backends unusable retain the floor refusal text', async () => {
    const tools = join(base, 'unavailable'); await mkdir(tools)
    for (const bin of ['bwrap', 'python3']) await writeFile(join(tools, bin), '#!/bin/sh\nexit 126\n', { mode: 0o700 })
    process.env.PATH = tools
    try {
      await expect(startServer({ config: config(), cwd: workspace, quiet: true, handleSignals: false }))
        .rejects.toThrow("CLI Bridge jail floor 'fs-jail' is unavailable. Enable a supported jail backend, or unset the jail floor.")
    } finally { process.env.PATH = forcePath }
  }, 60_000)

  it('captures a custom-env Landlock selection independently of the daemon environment', async () => {
    process.env.BRIDGE_JAIL_BACKEND = 'bwrap'
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      server = await startServer({ config: config(true), cwd: workspace, quiet: true, handleSignals: false })
      const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, model: 'codex/confinement-proof', cwd: workspace, messages: [{ role: 'user', content: 'Reply' }] }) })
      const body = await response.text()
      // The native fixture also asserts a real file outside the grants gets EACCES.
      expect(response.status, body).toBe(200); expect(body).toContain('confined-turn-ok')
    } finally { await server?.close(); process.env.BRIDGE_JAIL_BACKEND = 'landlock' }
  }, 60_000)

  it('refuses a custom-env server with no backend choice when bubblewrap is unavailable', async () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined, error: unknown
    try {
      try { server = await startServer({ config: config(true, 'none', false), cwd: workspace, quiet: true, handleSignals: false }) }
      catch (caught) { error = caught }
      expect(error, 'no operator choice must preserve the unavailable bubblewrap refusal').toBeDefined()
      expect(String(error)).toContain("CLI Bridge jail floor 'fs-jail' is unavailable")
    } finally { await server?.close() }
  }, 60_000)

  it('requires an explicit Landlock selection when bubblewrap cannot spawn', async () => {
    delete process.env.BRIDGE_JAIL_BACKEND
    let result: Awaited<ReturnType<typeof hostSpawner>> | undefined, error: unknown
    try {
      try { result = await hostSpawner(process.execPath, ['-e', "console.log('unexpected-automatic-fallback')"], { cwd: workspace, jail: spec() }) }
      catch (caught) { error = caught }
      if (result) { await output(result.child); await result.terminate?.(); result.release() }
      expect(error, 'unselected Landlock must never replace unavailable bubblewrap').toBeDefined()
      expect(selectJailBackend().name).toBe('bwrap')
    } finally { process.env.BRIDGE_JAIL_BACKEND = 'landlock' }
    const selected = await run("console.log('explicit-landlock')", spec())
    expect(selected.code, selected.stderr).toBe(0); expect(selected.stdout.trim()).toBe('explicit-landlock')
  })

  it('removes host socket-discovery variables from the real Landlock payload', async () => {
    const keys = ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'WAYLAND_DISPLAY', 'DOCKER_HOST', 'CUSTOM_SOCKET']
    const wrapped = await jail.wrap(process.execPath, ['-e', `const a=require('node:assert/strict');for(const k of ${JSON.stringify(keys)})a.equal(process.env[k],undefined,k);console.log('socket-env-absent')`], spec())
    const inherited = Object.fromEntries(keys.map((key) => [key, '/host/socket-proof']))
    try {
      // Simulate the outer scope's final transport injection, after any executor sanitization.
      const result = await output(spawn(wrapped.bin, wrapped.args, { cwd: workspace, env: { PATH: process.env.PATH, ...inherited }, stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(result.code, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('socket-env-absent')
    } finally { await wrapped.cleanup?.() }
  })

  it('requires the operator egress assertion for network none before a real backend turn', async () => {
    for (const allow of [false, true]) {
      const server = await startServer({ config: config(allow), cwd: workspace, quiet: true, handleSignals: false })
      try {
        const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stream: false, model: 'codex/confinement-proof', cwd: workspace, messages: [{ role: 'user', content: 'Reply' }] }) })
        const body = await response.text()
        if (allow) { expect(response.status, body).toBe(200); expect(body).toContain('confined-turn-ok') }
        else { expect(response.status, body).toBe(501); expect(body).toContain(`relay-grade isolation without ${JAIL_HOST_EGRESS_ENV}=1`); expect(body).not.toContain('confined-turn-ok') }
      } finally { await server.close() }
    }
  }, 60_000)

  it('g: relay-required HTTP turn is refused unless the operator asserts host egress enforcement', async () => {
    // Authored JSON cannot assert the trusted operator flag; it only comes from captured jail env.
    expect(resolveJailSpec({ cwd: workspace, execMode: 'fs-jail', execNetwork: 'relay', env: { BRIDGE_JAIL_NETWORK: 'relay' } })?.hostEgressEnforced).toBe(false)
    for (const allow of [false, true]) {
      const server = await startServer({ config: config(allow, 'relay'), cwd: workspace, quiet: true, handleSignals: false })
      try {
        const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stream: false, model: 'codex/confinement-proof', cwd: workspace, messages: [{ role: 'user', content: 'Reply' }] }) })
        const body = await response.text()
        if (allow) { expect(response.status, body).toBe(200); expect(body).toContain('confined-turn-ok') }
        else { expect(response.status, body).not.toBe(200); expect(body).toContain(JAIL_HOST_EGRESS_ENV) }
      } finally { await server.close() }
    }
  }, 60_000)

  it('measures signal and abstract Unix-socket residuals, and scopes them on ABI 6+', async () => {
    const address = `\0landlock-proof-${process.pid}-${Date.now()}`
    const listener = createServer((socket) => socket.end())
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(address, resolve) })
    const code = `const a=require('node:assert/strict'),net=require('node:net');
      let signal='ok';try{process.kill(${process.pid},0)}catch(e){signal=e.code}
      const scoped=${Number(probe.stdout.trim()) >= 6};
      a.equal(signal==='ok',!scoped);
      new Promise(r=>{const s=net.connect({path:${JSON.stringify(address)}});s.on('connect',()=>{s.destroy();r('ok')});s.on('error',e=>r(e.code))})
      .then(result=>a.equal(result==='ok',!scoped)).catch(e=>{console.error(e);process.exitCode=1});`
    try {
      if (Number(probe.stdout.trim()) >= 6) await discriminate('signal/abstract socket scopes', code)
      else { const result = await run(code, spec()); expect(result.code, result.stderr).toBe(0); console.log('ABI 4/5 residuals measured: signal 0 and host abstract Unix socket allowed; scopes unavailable') }
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())) }
  })

  it('routes protected host-service claims only to their owning jailed run and closes them on release', async () => {
    const secret = 'host-service-proof-canary-7b9e'
    const calls: string[] = []
    const endpoint = createHttpServer(async (request, response) => {
      for await (const _ of request) { /* consume the actual MCP request */ }
      calls.push(request.headers.authorization ?? '')
      response.end('host-service-ok')
    })
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
    const serviceBin = join(workspace, 'host-service.cjs')
    await writeFile(serviceBin, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('fixture 1.0.0');process.exit(0)}
(async()=>{
 const config=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
 if(config.includes(${JSON.stringify(secret)}))throw new Error('protected header entered the jail');
 const match=/\\[mcp_servers\\.tool\\]\\nurl = ("(?:[^"\\\\]|\\\\.)*")/.exec(config);
 if(!match)throw new Error('private MCP URL missing');
 const url=JSON.parse(match[1]);
 const result=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'});
 const text=await result.text();
 fs.writeFileSync('host-service-url',url);fs.writeFileSync('host-service-ready',String(result.status));
 if(process.argv.at(-1).includes('hold-service'))while(!fs.existsSync('host-service-release'))await new Promise(r=>setTimeout(r,20));
 const id=require('node:crypto').randomUUID();
 for(const event of [{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:result.status+' '+text}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}])console.log(JSON.stringify(event));
})().catch(e=>{console.error(e);process.exitCode=1});
`, { mode: 0o700 })
    const lifetime = new AbortController()
    const settings = { ...config(true), bearer: 'host-service-proof-bearer', codexBin: serviceBin, dataDir: join(base, 'state-host-service') }
    const server = await startServer({ config: settings, cwd: workspace, quiet: true, handleSignals: false,
      mcpSecrets: { async get(key) { return key === 'host-service-key' ? secret : undefined } } })
    const ready = join(workspace, 'host-service-ready'), release = join(workspace, 'host-service-release')
    const dispatch = (content: string) => fetch(`${server.url}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${settings.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, model: 'codex/confinement-proof', cwd: workspace, messages: [{ role: 'user', content }],
        runtime_attachments: { mcp: { tool: { transport: 'http', url: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/mcp`,
          headers: { Authorization: { kind: 'secret-ref', key: 'host-service-key', format: 'bearer' } } } } } }) })
      .then(async (response) => ({ status: response.status, text: await response.text() }))
    let held: ReturnType<typeof dispatch> | undefined
    try {
      server.registerPrivateMcpEndpoint({ runId: 'landlock-service-proof', url: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/mcp`, paths: { '': ['POST'] }, signal: lifetime.signal })
      const first = await dispatch('call-service')
      expect(first.status, first.text).toBe(200); expect(first.text).toContain('200 host-service-ok'); expect(first.text).not.toContain(secret)
      expect(calls).toEqual([`Bearer ${secret}`])
      await rm(ready); held = dispatch('hold-service')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error('jailed host-service call did not finish')) }, 10_000)
        const check = () => { void readFile(ready).then(() => { clearTimeout(timer); watcher.close(); resolve() }, () => {}) }
        const watcher = watch(workspace, check); check()
      })
      const url = await readFile(join(workspace, 'host-service-url'), 'utf8')
      expect(await readFile(ready, 'utf8')).toBe('200')
      const forged = new URL(url); forged.pathname = '/'+ 'x'.repeat(forged.pathname.length - 1)
      expect((await fetch(forged, { method: 'POST', body: '{}' })).status).toBe(403)
      const second = await run(`const a=require('node:assert/strict');require('node:http').get(${JSON.stringify(url)},r=>{r.resume();console.error('borrowed claim');process.exitCode=1}).on('error',e=>a.equal(e.code,'EACCES'))`, spec({ hostEgressEnforced: true }))
      expect(second.code, second.stderr).toBe(0)
      expect(calls).toEqual([`Bearer ${secret}`, `Bearer ${secret}`])
      lifetime.abort()
      await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
      await writeFile(release, 'go')
      const completed = await held
      expect(completed.status, completed.text).toBe(200); expect(completed.text).toContain('host-service-ok')
    } finally {
      lifetime.abort(); await writeFile(release, 'go'); await held?.catch(() => undefined)
      await server.close(); endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    }
  }, 60_000)

  it('does not let child PATH replace the trusted interpreter', async () => {
    const tools = join(base, 'hostile-path'); await mkdir(tools)
    await writeFile(join(tools, 'python3'), '#!/bin/sh\necho interpreter-substituted\nexit 0\n', { mode: 0o700 })
    const code = `require('node:assert/strict').throws(()=>require('node:fs').readFileSync(${JSON.stringify(outside)}),{code:'EACCES'});console.log('confined')`
    const result = await hostSpawner(process.execPath, ['-e', code], { cwd: workspace, jail: spec(), env: { PATH: tools } })
    try {
      const observed = await output(result.child)
      expect(observed.code, observed.stderr).toBe(0); expect(observed.stdout.trim()).toBe('confined')
    } finally { await result.terminate?.(); result.release() }
  })

  it('refuses read-only paths nested beneath a writable grant before a real spawn', async () => {
    const directory = join(base, 'nested-writable'), file = join(directory, 'readonly')
    await mkdir(directory); await writeFile(file, 'unchanged')
    let error: unknown
    try { await run(`require('node:fs').writeFileSync(${JSON.stringify(file)},'changed')`, spec({ extraWritablePaths: [directory], extraReadablePaths: [file] })) }
    catch (caught) { error = caught }
    expect(String(error)).toContain('read-only path nested in a writable grant')
    expect(await readFile(file, 'utf8')).toBe('unchanged')
  })

  it('refuses a changed grant identity between preparation and the real launcher', async () => {
    const file = join(base, 'identity-readable'), original = file + '.original'
    await writeFile(file, 'allowed')
    const wrapped = await jail.wrap(process.execPath, ['-e', `console.log(require('node:fs').readFileSync(${JSON.stringify(outside)},'utf8'))`], spec({ extraReadablePaths: [file] }))
    let moved = false
    try {
      await rename(file, original); moved = true; await symlink(outside, file)
      const result = await output(spawn(wrapped.bin, wrapped.args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(result.code, result.stdout + result.stderr).toBe(126)
      expect(result.stderr).toMatch(/path identity changed|Too many levels of symbolic links/)
      expect(result.stdout).toBe('')
    } finally {
      if (moved) { await rm(file, { force: true }); await rename(original, file) }
      await wrapped.cleanup?.()
    }
  })

  it('refuses a parent symlink even when the leaf identity still matches', async () => {
    const directory = join(base, 'grant-parent'), original = directory + '.original', alternate = join(base, 'grant-alternate')
    await mkdir(directory); await mkdir(alternate)
    const file = join(directory, 'leaf'); await writeFile(file, 'allowed')
    await link(file, join(alternate, 'leaf'))
    const wrapped = await jail.wrap(process.execPath, ['-e', "console.log('must-not-execute-through-parent-alias')"], spec({ extraReadablePaths: [file] }))
    try {
      await rename(directory, original); await symlink(alternate, directory)
      const result = await output(spawn(wrapped.bin, wrapped.args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(result.code, result.stdout + result.stderr).toBe(126)
      expect(result.stderr).toContain('Too many levels of symbolic links'); expect(result.stdout).toBe('')
    } finally { await rm(directory, { force: true }); await rename(original, directory); await wrapped.cleanup?.() }
  })

  it('starts an unprivileged real payload with no held Linux capabilities', async () => {
    const code = `import ctypes,os
class H(ctypes.Structure):_fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
class D(ctypes.Structure):_fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
h=H(0x20080522,0);d=(D*2)()
assert ctypes.CDLL(None).capget(ctypes.byref(h),ctypes.byref(d))==0
assert os.geteuid()!=0 and not any(x.effective or x.permitted or x.inheritable for x in d)
print('unprivileged')`
    const result = await run(`const p=require('node:child_process').spawnSync('python3',['-I','-S','-c',${JSON.stringify(code)}],{encoding:'utf8'});require('node:assert/strict').equal(p.status,0,p.stderr);process.stdout.write(p.stdout)`, spec())
    expect(result.code, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('unprivileged')
  })

  it('refuses remapped binds and write-jail rather than widening the boundary', async () => {
    const source = join(base, 'remapped-auth-source'); await writeFile(source, 'auth-fixture')
    expect(await readFile(source, 'utf8')).toBe('auth-fixture')
    await expect(jail.wrap('/bin/true', [], { ...spec(), readConfine: false })).rejects.toThrow('write-jail')
    await expect(jail.wrap('/bin/true', [], spec({ authSources: [{ source, jailRel: '.auth', mode: 'read-only' }] }))).rejects.toThrow('remapped bind')
  })
})

it('required Landlock gate qualification is explicit', () => {
  if (process.env.CLI_BRIDGE_REQUIRE_LANDLOCK === '1') expect(enabled, probe.stderr || 'Linux/python3/Landlock ABI 4+ required').toBe(true)
})
