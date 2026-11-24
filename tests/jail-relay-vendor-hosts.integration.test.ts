/**
 * The relay a jailed GLM (opencode) or Kimi Code turn talks through: a real bwrap jail, the
 * maintained host spawner and the relay the Bridge prepares for that harness. A refused host is
 * answered 403 by the relay itself; any other status means the relay let the tunnel through.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import { hostRequestJail } from '../src/jail/host-request.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

// Inside the jail: CONNECT each host through HTTPS_PROXY and print its status code.
const probe = (hosts: string[]) => `const net=require('node:net'),u=new URL(process.env.HTTPS_PROXY);
(async()=>{const out={};for(const h of ${JSON.stringify(hosts)}){out[h]=await new Promise((r)=>{const s=net.connect(Number(u.port),u.hostname,()=>s.write('CONNECT '+h+':443 HTTP/1.1\\r\\nHost: '+h+':443\\r\\n\\r\\n'));let b='';s.on('data',(d)=>{b+=d;if(b.includes('\\r\\n')){s.destroy();r(Number(b.split(' ')[1]))}});s.on('error',(e)=>r(e.code));setTimeout(()=>{s.destroy();r('timeout')},15000)})}console.log(JSON.stringify(out))})()`

describe.skipIf(!new LinuxBwrapJail().isAvailable())('the jail relay admits each harness\'s measured provider hosts', () => {
  let root: string
  beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'relay-vendor-hosts-'))) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const statuses = async (backend: string, hosts: string[]): Promise<Record<string, number | string>> => {
    const cwd = join(root, backend)
    await mkdir(cwd)
    const request: ChatRequest = { cwd, model: backend, messages: [{ role: 'user', content: 'probe' }] }
    const jail = hostRequestJail(request, backend, { ...process.env, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'relay' })
    expect(jail, 'BRIDGE_JAIL_MODE=fs-jail resolves a host jail').toBeTruthy()
    const spawned = await hostSpawner(process.execPath, ['-e', probe(hosts)], { cwd, jail: jail!, env: { PATH: process.env.PATH } })
    let stdout = ''
    spawned.child.stdout?.on('data', (chunk) => { stdout += chunk })
    await new Promise((resolve) => spawned.child.once('close', resolve))
    spawned.release()
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  }

  it('lets a GLM Coding Plan turn reach api.z.ai through opencode', async () => {
    const seen = await statuses('opencode', ['api.z.ai', 'registry.npmjs.org'])
    expect(seen['api.z.ai']).not.toBe(403)
    expect(seen['registry.npmjs.org']).toBe(403)
  }, 60_000)

  it('lets a Cursor Agent turn reach api2.cursor.sh', async () => {
    const seen = await statuses('cursor', ['api2.cursor.sh', 'registry.npmjs.org'])
    expect(seen['api2.cursor.sh']).not.toBe(403)
    expect(seen['registry.npmjs.org']).toBe(403)
  }, 60_000)

  it('lets Kimi Code sign in and call its API, and keeps its telemetry refused', async () => {
    const seen = await statuses('kimi-code', ['auth.kimi.com', 'code.kimi.com', 'api.kimi.com', 'cdn.kimi.com', 'telemetry-logs.kimi.com'])
    for (const host of ['auth.kimi.com', 'code.kimi.com', 'api.kimi.com', 'cdn.kimi.com']) expect(seen[host], host).not.toBe(403)
    expect(seen['telemetry-logs.kimi.com']).toBe(403)
  }, 60_000)
})
