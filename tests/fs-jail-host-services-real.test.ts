/** Actual HTTP peers reached only through bwrap's private network and the maintained UNIX relay. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claimTrustedHostService, registerTrustedHostService } from '../src/jail/egress.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import type { JailSpec } from '../src/jail/types.js'

const jail = new LinuxBwrapJail()
const enabled = jail.isAvailable()

it.skipIf(!enabled)(
  'admits scoped Hub/coordination paths, refuses HTTP escapes, and revokes each turn independently',
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'fs-jail-services-')))
    const project = join(base, 'project')
    await mkdir(project)
    const calls: Array<{
      path: string
      method: string
      authorization?: string
      body: string
      extra?: string
    }> = []
    let cancel: (() => void) | undefined
    const peer = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.push({
        path: req.url!,
        method: req.method!,
        authorization: req.headers.authorization,
        body,
        extra: req.headers['x-unscoped'] as string | undefined,
      })
      if (body === 'hold') {
        cancel?.()
        return
      }
      res.setHeader('mcp-session-id', 'scoped-session')
      res.end(JSON.stringify({ path: req.url, body }))
    })
    peer.listen(0, '127.0.0.1')
    await once(peer, 'listening')
    const address = peer.address()
    if (!address || typeof address === 'string') throw new Error('HTTP peer did not bind')
    const canonical = `http://127.0.0.1:${address.port}`
    const hub = registerTrustedHostService({
      url: `${canonical}/grant`,
      paths: { '/tools': ['GET'], '/call': ['POST'] },
      headers: { authorization: 'Bearer host-only' },
    })
    const coord = registerTrustedHostService({
      url: `${canonical}/coord`,
      paths: { '': ['POST'] },
      headers: { authorization: 'Bearer actor-only' },
    })
    const run = async (claims: ReturnType<typeof claimTrustedHostService>[], source: string) => {
      const spec: JailSpec = {
        root: join(project, '.agent-home'),
        projectDir: project,
        readConfine: true,
        network: 'none',
        trustedHostServices: claims.map((claim) => claim.registration),
      }
      const wrapped = await jail.wrap(process.execPath, ['-e', source], spec)
      try {
        const child = spawn(wrapped.bin, wrapped.args, {
          cwd: project,
          env: { ...process.env, ...wrapped.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '',
          stderr = ''
        child.stdout.setEncoding('utf8').on('data', (data) => {
          stdout += data
        })
        child.stderr.setEncoding('utf8').on('data', (data) => {
          stderr += data
        })
        const [code] = await once(child, 'close')
        expect(code, stderr).toBe(0)
        return JSON.parse(stdout)
      } finally {
        await wrapped.cleanup?.()
      }
    }
    const firstHub = claimTrustedHostService(hub.owner)
    const firstCoord = claimTrustedHostService(coord.owner)
    expect(firstHub.protectedValues).toContain('Bearer host-only')
    expect(firstHub.protectedValues).toContain(new URL(firstHub.nativeUrl).pathname.slice(1))
    expect(JSON.stringify(firstHub.registration)).toBe('{}')
    try {
      const results = await run(
        [firstHub, firstCoord],
        `
      const net = require('node:net');
      const hub = ${JSON.stringify(firstHub.nativeUrl)}, coord = ${JSON.stringify(firstCoord.nativeUrl)};
      const status = async (url, init) => { try { return (await fetch(url, {...init,signal:AbortSignal.timeout(5000)})).status } catch { return 0 } };
      const raw = text => new Promise(resolve => { const s=net.connect(3128,'127.0.0.1'); let out=''; s.on('error',()=>{}); s.on('data',b=>out+=b); s.on('close',()=>resolve(out)); s.setTimeout(5000,()=>s.destroy()); s.on('connect',()=>s.end(text)); });
      (async()=>{
        const out={};
        out.tools=await status(hub+'/tools');
        out.call=await status(hub+'/call',{method:'POST',headers:{authorization:'Bearer spoof','x-unscoped':'must-drop'},body:'allowed'});
        out.coord=await status(coord,{method:'POST',body:'actor'});
        out.root=await status(hub); out.method=await status(hub+'/call');
        out.suffix=await status(hub+'/tools/other'); out.query=await status(hub+'/tools?url='+encodeURIComponent(${JSON.stringify(canonical)}));
        out.foreign=await status('http://127.0.0.1:3128/not-a-cap/tools');
        out.loopback=await status(${JSON.stringify(canonical + '/grant/tools')});
        out.large=await status(hub+'/call',{method:'POST',body:'x'.repeat(1024*1024+1)});
        const p=new URL(hub).pathname;
        out.upgrade=await raw('GET '+p+'/tools HTTP/1.1\\r\\nHost: 127.0.0.1:3128\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
        out.connect=await raw('CONNECT 127.0.0.1:${address.port} HTTP/1.1\\r\\nHost: 127.0.0.1:${address.port}\\r\\n\\r\\n');
        out.absolute=await raw('POST '+hub+'/call HTTP/1.1\\r\\nHost: 127.0.0.1:3128\\r\\nContent-Length: 6\\r\\n\\r\\nescape');
        out.framing=await raw('POST '+p+'/call HTTP/1.1\\r\\nHost: 127.0.0.1:3128\\r\\nContent-Length: 6\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\n');
        out.pipeline=await raw('GET '+p+'/tools HTTP/1.1\\r\\nHost: 127.0.0.1:3128\\r\\n\\r\\nPOST '+p+'/call HTTP/1.1\\r\\nHost: 127.0.0.1:3128\\r\\nContent-Length: 6\\r\\n\\r\\nescape');
        console.log(JSON.stringify(out));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `,
      )
      expect(results.tools).toBe(200)
      expect(results.call).toBe(200)
      expect(results.coord).toBe(200)
      for (const key of ['root', 'method', 'suffix', 'query', 'foreign', 'loopback', 'large'])
        expect(results[key]).not.toBe(200)
      expect(results.connect).toContain('403')
      expect(results.absolute).not.toContain('200 OK')
      expect(results.upgrade).not.toContain('101')
      expect(calls.filter((call) => call.path === '/grant/call')).toEqual([
        {
          path: '/grant/call',
          method: 'POST',
          authorization: 'Bearer host-only',
          body: 'allowed',
          extra: undefined,
        },
      ])
      expect(calls.find((call) => call.path === '/coord')).toMatchObject({
        method: 'POST',
        authorization: 'Bearer actor-only',
        body: 'actor',
      })
      expect(calls.every((call) => ['/grant/tools', '/grant/call', '/coord'].includes(call.path))).toBe(true)
      expect(calls.some((call) => call.body === 'escape')).toBe(false)
      // Relay cleanup consumes only the turn claim. The trusted owner still admits another turn.
      const secondHub = claimTrustedHostService(hub.owner)
      expect(secondHub.nativeUrl).not.toBe(firstHub.nativeUrl)
      const next = await run(
        [secondHub],
        `
      (async()=>{const a=await fetch(${JSON.stringify(firstHub.nativeUrl + '/tools')});const b=await fetch(${JSON.stringify(secondHub.nativeUrl + '/tools')});console.log(JSON.stringify([a.status,b.status]))})().catch(e=>{console.error(e);process.exitCode=1});
    `,
      )
      expect(next).toEqual([403, 200])
      // An owner lifetime ending destroys an admitted, in-flight host call.
      const held = claimTrustedHostService(hub.owner)
      cancel = hub.revoke
      expect(
        await run(
          [held],
          `
      fetch(${JSON.stringify(held.nativeUrl + '/call')},{method:'POST',body:'hold',signal:AbortSignal.timeout(5000)}).then(()=>console.log('false'),()=>console.log('true'));
    `,
        ),
      ).toBe(true)
      expect(() => claimTrustedHostService(hub.owner)).toThrow('unavailable')
      await expect(run([firstHub], 'console.log(true)')).rejects.toThrow('unavailable')
    const copied = { ...firstCoord, registration: JSON.parse(JSON.stringify(firstCoord.registration)) }
    await expect(run([copied], 'console.log(true)')).rejects.toThrow('unavailable')
    } finally {
      hub.revoke()
      coord.revoke()
      peer.closeAllConnections()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      await rm(base, { recursive: true, force: true })
    }
  },
  45_000,
)
