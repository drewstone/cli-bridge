/** Real kernel confinement, including deliberately unconfined negative controls. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
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
    try { return await output(result.child) } finally { await result.terminate(); result.release() }
  }
  const wrapped = await jail.wrap(process.execPath, ['-e', code], spec)
  // Replace only the launcher. The same argv, policy, env and cwd reach the command.
  const args = wrapped.args.map((arg) => arg === launcher ? standin : arg)
  try { return await output(spawn(wrapped.bin, args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })) }
  finally { await wrapped.cleanup?.() }
}

function spec(extra: Partial<JailSpec> = {}): JailSpec {
  return { root, projectDir: workspace, readConfine: true, network: 'none', extraReadablePaths: [readonly], ...extra }
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
    process.env.GIT_CONFIG_GLOBAL = join(home, 'absent-config')
    delete process.env.XDG_CONFIG_HOME; delete process.env.GIT_PRIVACY_DENYLIST
    standin = join(base, 'unconfined.py')
    await writeFile(standin, "import json,os,sys\nwith open(sys.argv[1]) as f: p=json.load(f)\nos.environ.update(p['env'])\nos.chdir(p['cwd'])\nos.execvpe(sys.argv[2],sys.argv[2:],os.environ)\n")
    backendBin = join(workspace, 'codex.cjs')
    // Same native event protocol fixture as the existing jailed private-endpoint integration.
    await writeFile(backendBin, `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('fixture 1.0.0'); process.exit(0) }\nfor(const e of [{type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000043'},{type:'item.completed',item:{type:'agent_message',text:'confined-turn-ok'}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}]) console.log(JSON.stringify(e))\n`, { mode: 0o700 })
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

  function config(allow = false, network: 'none' | 'relay' = 'none') {
    return { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(base, `state-${allow}-${network}`), BRIDGE_BACKENDS: 'codex',
      CODEX_BIN: backendBin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: network,
      [JAIL_HOST_EGRESS_ENV]: allow ? '1' : '0' }), port: 0 }
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

  it('does not let child PATH replace the trusted interpreter', async () => {
    const tools = join(base, 'hostile-path'); await mkdir(tools)
    await writeFile(join(tools, 'python3'), '#!/bin/sh\necho interpreter-substituted\nexit 0\n', { mode: 0o700 })
    const code = `require('node:assert/strict').throws(()=>require('node:fs').readFileSync(${JSON.stringify(outside)}),{code:'EACCES'});console.log('confined')`
    const result = await hostSpawner(process.execPath, ['-e', code], { cwd: workspace, jail: spec(), env: { PATH: tools } })
    try {
      const observed = await output(result.child)
      expect(observed.code, observed.stderr).toBe(0); expect(observed.stdout.trim()).toBe('confined')
    } finally { await result.terminate(); result.release() }
  })

  it('refuses remapped binds and write-jail rather than widening the boundary', async () => {
    await expect(jail.wrap('/bin/true', [], { ...spec(), readConfine: false })).rejects.toThrow('write-jail')
    await expect(jail.wrap('/bin/true', [], spec({ authSources: [{ source: readonly, jailRel: '.auth', mode: 'read-only' }] }))).rejects.toThrow('remapped bind')
  })
})

it('required Landlock gate qualification is explicit', () => {
  if (process.env.CLI_BRIDGE_REQUIRE_LANDLOCK === '1') expect(enabled, probe.stderr || 'Linux/python3/Landlock ABI 4+ required').toBe(true)
})
