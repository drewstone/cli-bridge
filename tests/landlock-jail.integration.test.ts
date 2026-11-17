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
import { configuredJailBackend, JAIL_HOST_EGRESS_ENV } from '../src/config.js'
import { resolveJailSpec } from '../src/jail/resolve-spec.js'
import { startEgressRelay } from '../src/jail/egress-relay.js'
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
    expect(selectJailBackend(process.platform, configuredJailBackend()).name).toBe('landlock')
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
    const listener = createServer((socket) => { socket.on('error', () => {}); socket.end('outside') })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    try {
      const port = (listener.address() as AddressInfo).port
      await discriminate('d', `const net=require('node:net'),a=require('node:assert/strict');
        const connect=(port)=>new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r('ok')});s.on('error',e=>r(e.code))});
        (async()=>{a.equal(await connect(Number(new URL(process.env.HTTP_PROXY).port)),'ok');a.equal(await connect(${port}),'EACCES');
        const bound=await new Promise(r=>{const s=net.createServer();s.on('error',e=>r(e.code));s.listen(0,'127.0.0.1',()=>s.close(()=>r('ok')))});a.equal(bound,'EACCES')})().catch(e=>{console.error(e);process.exitCode=1})`, spec({ network: 'router', hostEgressEnforced: true }))
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())) }
  })

  it('isolates a concurrent network-none spawn from an authenticated relay spawn', async () => {
    const relayCode = `const net=require('node:net'),a=require('node:assert/strict'),u=new URL(process.env.HTTPS_PROXY);
      const auth='Basic '+Buffer.from(u.username+':'+u.password).toString('base64');
      const check=(credential,status)=>new Promise((resolve,reject)=>{
        const s=net.connect(Number(u.port),'127.0.0.1',()=>s.write('CONNECT router.tangle.tools:443 HTTP/1.1\\r\\nHost: router.tangle.tools:443\\r\\n'+(credential?'Proxy-Authorization: '+credential+'\\r\\n':'')+'\\r\\n'));
        s.once('error',reject);s.once('data',b=>{s.destroy();try{a.match(b.toString(),new RegExp('^HTTP/1.1 '+status));if(status===407)a.match(b.toString(),/Proxy-Authenticate: Basic realm="cli-bridge"/i);resolve()}catch(e){reject(e)}})});
      (async()=>{await check('',407);await check('Basic invalid',407);await check(auth,200);console.log(u.port);setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exitCode=1});`
    const relay = await hostSpawner(process.execPath, ['-e', relayCode], { cwd: workspace,
      jail: spec({ root: join(workspace, '.relay-home'), network: 'router' }), env: { PATH: process.env.PATH } })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = ''
        const timer = setTimeout(() => reject(new Error('relay readiness timeout: ' + stderr)), 10_000)
        relay.child.stderr!.on('data', (b) => { stderr += b })
        relay.child.once('exit', (code) => { clearTimeout(timer); reject(new Error('relay exited ' + code + ': ' + stderr)) })
        relay.child.stdout!.once('data', (b) => { clearTimeout(timer); resolve(Number(String(b).trim())) })
      })
      expect(port).toBeGreaterThan(0)
      await discriminate('two-spawn relay isolation', `const a=require('node:assert/strict'),net=require('node:net');
        const s=net.connect(${port},'127.0.0.1');s.once('connect',()=>{s.destroy();a.fail('borrowed concurrent relay')});
        s.once('error',e=>a.equal(e.code,'EACCES'));`)
    } finally { await relay.terminate?.(); relay.release() }
  }, 30_000)

  it('blocks Fast Open send syscalls and still mediates TCP_FASTOPEN_CONNECT', async () => {
    let connections = 0
    const sockets = new Set<import('node:net').Socket>()
    const listener = createServer((socket) => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.end() })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    try {
      const port = (listener.address() as AddressInfo).port
      const python = `import ctypes,errno,platform,socket
libc=ctypes.CDLL(None,use_errno=True)
addr=('127.0.0.1',${port})
s=socket.socket()
try:
 s.sendto(b'x',0x20000000,addr)
except OSError as e:
 assert e.errno==errno.EACCES,e
else:
 raise AssertionError('MSG_FASTOPEN connected')
finally:
 s.close()
# Null message pointers must not hide a missing seccomp denial behind EFAULT.
# The extra bit verifies JSET rather than equality on flags; high bits are ignored.
nrs=(44,46,307) if platform.machine()=='x86_64' else (206,211,269)
for nr in nrs:
 s=socket.socket()
 args=(s.fileno(),0,0,ctypes.c_ulonglong(0x120000040)) if nr!=nrs[1] else (s.fileno(),0,ctypes.c_ulonglong(0x120000040))
 result=libc.syscall(nr,*args);error=ctypes.get_errno();s.close()
 assert result==-1 and error==errno.EACCES,(nr,result,error)
s=socket.socket();s.setsockopt(socket.IPPROTO_TCP,30,1)
try:
 s.connect(addr)
except OSError as e:
 assert e.errno==errno.EACCES,e
 print('TCP_FASTOPEN_CONNECT connect returned EACCES')
else:
 raise AssertionError('TCP_FASTOPEN_CONNECT bypassed connect mediation')
finally:
 s.close()`
      const code = `const p=require('node:child_process').spawnSync('python3',['-I','-S','-c',${JSON.stringify(python)}],{encoding:'utf8',timeout:5000});require('node:assert/strict').equal(p.status,0,p.error?.message || p.stderr);process.stdout.write(p.stdout)`
      const red = await run(code, spec(), true)
      console.log('TFO control exit=' + red.code + ' ' + red.stderr.trim())
      expect(red.code, red.stderr).not.toBe(0); expect(red.stderr).toContain('MSG_FASTOPEN connected')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(connections, 'unconfined Fast Open must reach the listener').toBe(1)
      const green = await run(code, spec())
      expect(green.code, green.stderr).toBe(0)
      expect(green.stdout).toContain('TCP_FASTOPEN_CONNECT connect returned EACCES')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(connections, 'jailed sends and connect must not reach the listener').toBe(1)
      console.log('TFO: unconfined connected; jailed sendto/sendmsg/sendmmsg EACCES; ' + green.stdout.trim())
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => listener.close(() => resolve())) }
  }, 15_000)

  it('requires credentials before opening a TCP relay and challenges plain HTTP requests', async () => {
    await expect(startEgressRelay({ tcp: true, allow: [] })).rejects.toThrow('requires proxy authorization')
    const relay = await startEgressRelay({ tcp: true, proxyAuthorization: 'Basic integration-only', allow: [] })
    try {
      const { get } = await import('node:http')
      const response = await new Promise<{ status?: number; challenge?: string }>((resolve, reject) => {
        get(`http://127.0.0.1:${relay.port}/`, (res) => {
          res.resume(); res.once('end', () => resolve({ status: res.statusCode, challenge: res.headers['proxy-authenticate'] }))
        }).once('error', reject)
      })
      expect(response.status).toBe(407)
      expect(response.challenge).toBe('Basic realm="cli-bridge"')
    } finally { await relay.close() }
  })

  it('requires a verified private-destination policy for outer CONNECT, preserving NO_PROXY and the allowlist', async () => {
    const { createServer: httpServer } = await import('node:http')
    const { createServer: tlsServer } = await import('node:tls')
    const { connect } = await import('node:net')
    const { randomBytes } = await import('node:crypto')
    const key = join(workspace, 'outer-key.pem'), cert = join(workspace, 'outer-cert.pem')
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com,DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    const sockets = new Set<import('node:net').Socket>()
    let tlsRequests = 0
    const origin = tlsServer({ key: await readFile(key), cert: await readFile(cert) }, (socket) => {
      let head = ''
      socket.on('data', (b) => {
        head += b.toString()
        if (!head.includes('\r\n\r\n')) return
        tlsRequests++
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nouter-proxy-ok!')
      })
    })
    origin.on('tlsClientError', () => {})
    const outer = httpServer()
    const records: Array<{ target: string; authorized: boolean; phase: string }> = []
    let phase = 'verification', privateStatus = 403
    const password = randomBytes(24).toString('hex')
    const expected = 'Basic ' + Buffer.from('operator:' + password).toString('base64')
    for (const server of [origin, outer]) server.on('connection', (socket) => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
    const originPort = (origin.address() as AddressInfo).port
    outer.on('connect', (req, socket, head) => {
      const authorized = req.headers['proxy-authorization'] === expected
      records.push({ target: req.url!, authorized, phase })
      if (!authorized) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
      // After startup verification, the proxy is deliberately permissive: local targets must never reach CONNECT.
      if (req.url !== 'example.com:443' && phase === 'verification' && privateStatus !== 200) {
        socket.end(`HTTP/1.1 ${privateStatus} Refused\r\n\r\n`); return
      }
      const upstream = connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream))
      upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => outer.listen(0, '127.0.0.1', resolve))
    const url = `http://operator:${password}@127.0.0.1:${(outer.address() as AddressInfo).port}`
    const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'BRIDGE_JAIL_OUTER_PROXY_ENFORCED'] as const
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const payload = (host: string, port: number) => `const a=require('node:assert/strict'),http=require('node:http'),tls=require('node:tls'),fs=require('node:fs'),u=new URL(process.env.HTTPS_PROXY);
      const req=http.request({host:u.hostname,port:u.port,method:'CONNECT',path:${JSON.stringify((host.includes(':') ? '[' + host + ']' : host) + ':' + port)},headers:{'Proxy-Authorization':'Basic '+Buffer.from(u.username+':'+u.password).toString('base64')}});
      req.on('connect',(res,socket)=>{a.equal(res.statusCode,200);const stream=tls.connect({socket,servername:${JSON.stringify(host)},ca:fs.readFileSync(${JSON.stringify(cert)})},()=>stream.write(${JSON.stringify('GET / HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n')}));
        let body='';stream.on('data',b=>body+=b);stream.on('end',()=>{a.match(body,/outer-proxy-ok!/);console.log('outer-proxy-request-ok')});stream.on('error',()=>{console.error('TLS refused');process.exitCode=1})});
      req.on('error',()=>{console.error('CONNECT refused');process.exitCode=1});req.end();setTimeout(()=>process.exit(2),5000).unref();`
    const request = async (host: string, port: number, proxy?: string, noProxy = '', lower = false, declared = true) => {
      for (const key of keys) delete process.env[key]
      if (proxy) process.env[lower ? 'https_proxy' : 'HTTPS_PROXY'] = proxy
      process.env[lower ? 'no_proxy' : 'NO_PROXY'] = noProxy
      if (proxy && declared) process.env.BRIDGE_JAIL_OUTER_PROXY_ENFORCED = '1'
      phase = 'verification'
      const wrapped = await jail.wrap(process.execPath, ['-e', payload(host, port)], spec({ network: 'relay', passThroughHosts: ['example.com', 'localhost', 'localhost.', 'service.localhost', 'service.localhost.', '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', `127.0.0.1:${originPort}`] }))
      phase = 'request'
      // Relay configuration must remain captured, even if the bridge environment changes afterwards.
      process.env.HTTPS_PROXY = 'http://127.0.0.1:1'; process.env.NO_PROXY = '*'
      try { return await output(spawn(wrapped.bin, wrapped.args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })) }
      finally { await wrapped.cleanup?.() }
    }
    try {
      await expect(request('example.com', 443, url, '', false, false)).rejects.toThrow('BRIDGE_JAIL_OUTER_PROXY_ENFORCED')
      expect(records).toHaveLength(0)
      for (const status of [200, 407, 502]) {
        privateStatus = status
        await expect(request('example.com', 443, url)).rejects.toThrow('private-destination refusal not verified')
      }
      privateStatus = 403
      let result = await request('example.com', 443, url, '', true)
      expect(result.code, result.stderr).toBe(0)
      expect(tlsRequests).toBe(1)
      for (const host of ['localhost', 'localhost.', 'service.localhost', 'service.localhost.']) {
        result = await request(host, 443, url)
        expect(result.code, `local name ${host} must be refused before CONNECT`).not.toBe(0)
      }
      for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
        result = await request(host, 443, url)
        expect(result.code, `private literal ${host} must be refused before CONNECT`).not.toBe(0)
      }
      result = await request('localhost', 443)
      expect(result.code, 'direct private-address control must be refused').not.toBe(0)
      result = await request('localhost', 443, url, 'localhost:443')
      expect(result.code, 'NO_PROXY bypass retains the direct private-address guard').not.toBe(0)
      result = await request('127.0.0.1', originPort, url, `127.0.0.1:${originPort}`)
      expect(result.code, result.stderr).toBe(0)
      result = await request('not-allowed.invalid', 443, url)
      expect(result.code, 'outer proxy must not bypass the relay allowlist').not.toBe(0)
      expect(records.filter((r) => r.phase === 'request')).toEqual([
        { target: 'example.com:443', authorized: true, phase: 'request' },
      ])
      expect(records.every((r) => r.authorized)).toBe(true)
      expect(tlsRequests).toBe(2)
      console.log('outer CONNECT: public TLS request succeeds; private/local targets refused before CONNECT even with permissive proxy; private literals refused before CONNECT; permissive/407/502 proxies and undeclared policy refuse startup; NO_PROXY direct control succeeds')
    } finally {
      for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key] }
      for (const socket of sockets) socket.destroy()
      await Promise.all([origin, outer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    }
  }, 60_000)

  it('refuses pathname Unix sockets, including user-manager sockets, while the unconfined control connects', async () => {
    const { stat } = await import('node:fs/promises')
    const address = join(base, 'user-manager.sock')
    const listener = createServer((socket) => { socket.resume(); socket.on('error', () => {}); socket.end() })
    await new Promise<void>((resolve) => listener.listen(address, resolve))
    const paths = [address]
    for (const suffix of ['bus', 'systemd/private']) {
      const path = `/run/user/${process.getuid!()}/${suffix}`
      if (await stat(path).then((s) => s.isSocket(), () => false)) paths.push(path)
    }
    if (paths.length === 1) console.log('canonical user-manager/session-bus sockets absent; testing same-uid stand-in')
    try {
      for (const path of paths) {
        const code = (denied: boolean) => `const a=require('node:assert/strict'),net=require('node:net');
          const s=net.connect({path:${JSON.stringify(path)}});s.once('connect',()=>{s.destroy();a.equal(${denied},false);console.log('connected')});
          s.once('error',e=>{if(!${denied}){console.log('unavailable:'+e.code);process.exitCode=1;return}a.equal(e.code,'EACCES');console.log('denied')});`
        const control = await run(code(false), spec(), true)
        if (path !== address && control.code !== 0) {
          expect(control.stdout.trim(), control.stderr).toMatch(/^unavailable:(ENOENT|ECONNREFUSED|EACCES)$/)
        } else { expect(control.code, control.stderr).toBe(0); expect(control.stdout.trim()).toBe('connected') }
        const jailed = await run(code(true), spec())
        expect(jailed.code, jailed.stderr).toBe(0); expect(jailed.stdout.trim()).toBe('denied')
        console.log(`pathname Unix ${path === address ? 'stand-in' : path}: unconfined ${control.stdout.trim()}; jailed EACCES`)
      }
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())) }
  }, 15_000)

  it('enforces ordinary TCP sockets and refuses UDP, MPTCP, netlink and io_uring in descendants', async () => {
    const python = `import ctypes,errno,os,socket
libc=ctypes.CDLL(None,use_errno=True)
# Actual kernel probes, including MPTCP even when the host disables it.
for family in (socket.AF_INET,socket.AF_INET6):
 for kind in (socket.SOCK_STREAM,socket.SOCK_STREAM|socket.SOCK_CLOEXEC|socket.SOCK_NONBLOCK):
  for protocol in (0,socket.IPPROTO_TCP):
   s=socket.socket(family,kind,protocol);s.close()
 for kind,protocol in ((socket.SOCK_DGRAM,0),(socket.SOCK_STREAM,262),(socket.SOCK_RAW,0)):
  result=libc.socket(family,kind,protocol);error=ctypes.get_errno()
  if result>=0: os.close(result)
  assert result==-1 and error==errno.EACCES,(family,kind,protocol,result,error)
result=libc.socket(socket.AF_NETLINK,socket.SOCK_RAW,4);error=ctypes.get_errno()
if result>=0: os.close(result)
assert result==-1 and error==errno.EACCES,(result,error)
params=ctypes.create_string_buffer(256)
result=libc.syscall(425,1,ctypes.byref(params));error=ctypes.get_errno()
if result>=0: os.close(result)
assert result==-1 and error==errno.ENOSYS,(result,error)
# Connected stream pairs support local IPC; datagram pairs can retarget pathname sockets.
for kind in (socket.SOCK_STREAM,socket.SOCK_STREAM|socket.SOCK_CLOEXEC|socket.SOCK_NONBLOCK):
 a,b=socket.socketpair(socket.AF_UNIX,kind);a.send(b'ipc');assert b.recv(3)==b'ipc';a.close();b.close()
for kind in (socket.SOCK_DGRAM,socket.SOCK_SEQPACKET):
 fds=(ctypes.c_int*2)();result=libc.socketpair(socket.AF_UNIX,kind,0,fds);error=ctypes.get_errno()
 assert result==-1 and error==errno.EACCES,(kind,result,error)
print('socket filter enforced')`
    const code = `const p=require('node:child_process').spawnSync('python3',['-I','-S','-c',${JSON.stringify(python)}],{encoding:'utf8'});require('node:assert/strict').equal(p.status,0,p.stderr);process.stdout.write(p.stdout)`
    await discriminate('seccomp socket filter', code)
    const mptcp = spawnSync('python3', ['-c', "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_STREAM,262); print('MPTCP enabled');s.close()"], { encoding: 'utf8' })
    console.log('host MPTCP probe exit=' + mptcp.status + ' ' + (mptcp.stdout || mptcp.stderr).trim())
  })

  it('allows git config --global writes when no host global config exists', async () => {
    const previous = process.env.GIT_CONFIG_GLOBAL
    delete process.env.GIT_CONFIG_GLOBAL
    try {
      const result = await run(`const a=require('node:assert/strict'),cp=require('node:child_process');
        a.equal(process.env.GIT_CONFIG_GLOBAL,undefined);
        let p=cp.spawnSync('git',['config','--global','review.local','writable'],{encoding:'utf8'});a.equal(p.status,0,p.stderr);
        p=cp.spawnSync('git',['config','--global','--get','review.local'],{encoding:'utf8'});a.equal(p.status,0,p.stderr);a.equal(p.stdout.trim(),'writable');`, spec())
      expect(result.code, result.stderr).toBe(0)
    } finally { if (previous !== undefined) process.env.GIT_CONFIG_GLOBAL = previous }
  })

  it('keeps the credentialed launcher policy beneath the hidden egress parent and removes it on cleanup', async () => {
    const wrapped = await jail.wrap(process.execPath, ['-e', `const a=require('node:assert/strict'),fs=require('node:fs');a.throws(()=>fs.readFileSync(process.argv[1]),{code:'EACCES'});console.log('policy-hidden')`], spec({ network: 'relay' }))
    const file = wrapped.args[3]!
    const { prepareEgress } = await import('../src/jail/egress.js')
    const hidden = await prepareEgress(spec(), 'tcp-port')
    try { expect(file.startsWith(hidden.hiddenParent! + '/')).toBe(true) } finally { await hidden.cleanup() }
    wrapped.args.push(file)
    try {
      const result = await output(spawn(wrapped.bin, wrapped.args, { cwd: workspace, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }))
      expect(result.code, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('policy-hidden')
    } finally { await wrapped.cleanup?.() }
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a global Git config, relative includes and conditional includes at read-only snapshot paths', async () => {
    const previous = process.env.GIT_CONFIG_GLOBAL
    const config = join(base, 'global-gitconfig'), included = join(base, 'included-gitconfig'), conditional = join(base, 'conditional-gitconfig')
    expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0)
    await writeFile(included, '[review]\n included = preserved\n')
    await writeFile(conditional, '[review]\n conditional = matched\n')
    await writeFile(config, '[review]\n value = global\n[include]\n path = ./included-gitconfig\n[includeIf "gitdir:' + workspace + '/.git"]\n path = ./conditional-gitconfig\n')
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const result = await run(`const a=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
        for(const [key,value] of [['review.value','global'],['review.included','preserved'],['review.conditional','matched']]){
          const p=cp.spawnSync('git',['config','--get',key],{encoding:'utf8'});a.equal(p.status,0,p.stderr);a.equal(p.stdout.trim(),value)}
        a.throws(()=>fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL,'changed'),{code:'EACCES'});
        a.throws(()=>fs.readFileSync(${JSON.stringify(config)}),{code:'EACCES'});`, spec())
      expect(result.code, result.stderr).toBe(0)
    } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous }
  })

  it('reads only own runtime proc files and refuses socket discovery and sibling contents', async () => {
    await discriminate('own proc grant', `const fs=require('node:fs'),a=require('node:assert/strict');
      a.match(fs.readFileSync('/proc/self/maps','utf8'),/r.xp/);
      for(const name of ['stat','statm','cgroup'])fs.readFileSync('/proc/self/'+name);
      for(const p of ['/proc/self/net/tcp','/proc/self/net/tcp6','/proc/self/net/unix','/proc/self/environ','/proc/${process.pid}/maps','/proc/${process.pid}/environ','/proc/stat'])a.throws(()=>fs.readFileSync(p),{code:'EACCES'});`)
  })

  function config(allow = true, network: 'none' | 'relay' = 'none', selected = true) {
    return { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(base, `state-${allow}-${network}`), BRIDGE_BACKENDS: 'codex',
      CODEX_BIN: backendBin, BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: network,
      ...(selected ? { BRIDGE_JAIL_BACKEND: 'landlock' } : {}), [JAIL_HOST_EGRESS_ENV]: allow ? '1' : '0' }), port: 0 }
  }

  it('e/f: fs-jail server starts without bubblewrap and a real backend turn completes', async () => {
    const server = await startServer({ config: config(), cwd: workspace, quiet: false, handleSignals: false })
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
    const code = `import { startServer, loadConfig } from ${JSON.stringify(new URL('../src/server.ts', import.meta.url).href)};
      import a from 'node:assert/strict';
      await a.rejects(startServer({config:loadConfig({BRIDGE_HOST:'127.0.0.1',BRIDGE_BACKENDS:'codex',BRIDGE_DATA_DIR:${JSON.stringify(join(base, 'unavailable-state'))},BRIDGE_JAIL_MODE:'fs-jail',BRIDGE_JAIL_BACKEND:'landlock'}),cwd:${JSON.stringify(workspace)},quiet:true,handleSignals:false}),/CLI Bridge jail floor 'fs-jail' is unavailable/);`
    const result = await output(spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { ...process.env, PATH: tools }, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    expect(result.code, result.stderr).toBe(0)
  }, 60_000)

  it('caches a timed-out probe across instances while retaining the warn fallback', async () => {
    const tools = join(base, 'slow-probe'); await mkdir(tools)
    const count = join(tools, 'probes')
    await writeFile(join(tools, 'python3'), `#!/bin/sh\necho probe >> ${JSON.stringify(count)}\nexec /bin/sleep 30\n`, { mode: 0o700 })
    const code = `import a from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {LinuxLandlockJail} from ${JSON.stringify(new URL('../src/jail/linux-landlock.ts', import.meta.url).href)};
      import {hostSpawner} from ${JSON.stringify(new URL('../src/executors/host.ts', import.meta.url).href)};
      a.equal(new LinuxLandlockJail().isAvailable(),false);
      for(let i=0;i<2;i++){
        const p=await hostSpawner(process.execPath,['-e',"console.log('explicit-warn-fallback')"],{cwd:${JSON.stringify(workspace)},jail:${JSON.stringify(spec({ backend: 'landlock', fallback: 'warn' }))}});
        p.child.stdout.on('data',b=>process.stdout.write(b));p.child.stderr.on('data',b=>process.stderr.write(b));
        await new Promise((resolve,reject)=>{p.child.once('error',reject);p.child.once('close',c=>{try{a.equal(c,0);resolve()}catch(e){reject(e)}})});p.release();
      }
      a.equal(readFileSync(${JSON.stringify(count)},'utf8'),'probe\\n');`
    const result = await output(spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { ...process.env, PATH: tools }, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.match(/explicit-warn-fallback/g)).toHaveLength(2)
    expect(result.stderr.match(/UNCONFINED/g)).toHaveLength(1)
  }, 15_000)

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
      expect(selectJailBackend(process.platform, configuredJailBackend()).name).toBe('bwrap')
    } finally { process.env.BRIDGE_JAIL_BACKEND = 'landlock' }
    const selected = await run("console.log('explicit-landlock')", spec())
    expect(selected.code, selected.stderr).toBe(0); expect(selected.stdout.trim()).toBe('explicit-landlock')
  })

  it('removes host socket-discovery variables from the real Landlock payload', async () => {
    const keys = ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'WAYLAND_DISPLAY', 'DOCKER_HOST', 'CUSTOM_SOCKET']
    const wrapped = await jail.wrap(process.execPath, ['-e', `const a=require('node:assert/strict');for(const k of ${JSON.stringify(keys)})a.equal(process.env[k],undefined,k);a.equal(process.env.XDG_RUNTIME_DIR,process.env.HOME+'/.runtime');console.log('socket-env-absent')`], spec())
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

  it('measures signal scopes and refuses abstract Unix-socket creation on every ABI', async () => {
    const address = `\0landlock-proof-${process.pid}-${Date.now()}`
    const listener = createServer((socket) => socket.end())
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(address, resolve) })
    const code = `const a=require('node:assert/strict'),net=require('node:net');
      let signal='ok';try{process.kill(${process.pid},0)}catch(e){signal=e.code}
      const scoped=${Number(probe.stdout.trim()) >= 6};
      a.equal(signal==='ok',!scoped);
      new Promise(r=>{const s=net.connect({path:${JSON.stringify(address)}});s.on('connect',()=>{s.destroy();r('ok')});s.on('error',e=>r(e.code))})
      .then(result=>a.equal(result,'EACCES')).catch(e=>{console.error(e);process.exitCode=1});`
    try {
      if (Number(probe.stdout.trim()) >= 6) await discriminate('signal/abstract socket scopes', code)
      else { const result = await run(code, spec()); expect(result.code, result.stderr).toBe(0); console.log('ABI 4/5 residuals measured: signal 0 allowed; AF_UNIX creation refused by seccomp; kernel scopes unavailable') }
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
 const tag=process.argv.at(-1).includes('second-service')?'second-':'';
 if(tag){
  const other=fs.readFileSync('host-service-url','utf8');
  const denied=await new Promise((resolve,reject)=>require('node:http').get(other,r=>{r.resume();reject(new Error('borrowed first claim'))}).on('error',e=>resolve(e.code)));
  require('node:assert/strict').equal(denied,'EACCES');fs.writeFileSync('second-denied',denied);
 }
 fs.writeFileSync(tag+'host-service-url',url);fs.writeFileSync(tag+'host-service-ready',String(result.status));
 if(process.argv.at(-1).includes('hold-service'))while(!fs.existsSync(tag+'host-service-release'))await new Promise(r=>setTimeout(r,20));
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
    let held: ReturnType<typeof dispatch> | undefined, secondHeld: ReturnType<typeof dispatch> | undefined
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
      // A second live run must first use its own claim, then fail to connect to the first port.
      secondHeld = dispatch('hold-service second-service')
      const secondReady = join(workspace, 'second-host-service-ready')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error('second jailed claim did not become ready')) }, 10_000)
        const check = () => { void readFile(secondReady).then(() => { clearTimeout(timer); watcher.close(); resolve() }, () => {}) }
        const watcher = watch(workspace, check); check()
      })
      expect(await readFile(secondReady, 'utf8')).toBe('200')
      expect(await readFile(join(workspace, 'second-denied'), 'utf8')).toBe('EACCES')
      const secondUrl = await readFile(join(workspace, 'second-host-service-url'), 'utf8')
      expect(new URL(secondUrl).port).not.toBe(new URL(url).port)
      expect(calls).toEqual([`Bearer ${secret}`, `Bearer ${secret}`, `Bearer ${secret}`])
      // The unconfined control can still reach the first listener with its URL credential.
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(200)
      console.log('two live claimed runs: own claims 200; second to first port EACCES; unconfined control 200')
      lifetime.abort()
      await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
      await writeFile(release, 'go')
      const completed = await held
      expect(completed.status, completed.text).toBe(200); expect(completed.text).toContain('host-service-ok')
    } finally {
      lifetime.abort(); await writeFile(release, 'go'); await writeFile(join(workspace, 'second-host-service-release'), 'go')
      await Promise.all([held?.catch(() => undefined), secondHeld?.catch(() => undefined)])
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
