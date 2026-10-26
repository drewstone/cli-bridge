/** Real request → OS filesystem confinement proof. No harness or model request. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'
import { hostSpawner } from '../src/executors/host.js'
import { selectJailBackend } from '../src/jail/index.js'
import { applyJail } from '../src/executors/jail-support.js'
import type { Backend, ChatRequest } from '../src/backends/types.js'

assert.ok(await selectJailBackend().isAvailable(), 'A real OS jail is required; this proof cannot skip')
const directory = await mkdtemp(join(tmpdir(), 'bridge-jail-snapshot-'))
const workspace = join(directory, 'workspace')
const secret = join(directory, 'outside', 'canary')
const readable = join(directory, 'readable')
const writable = join(directory, 'writable')
await Promise.all([workspace, join(directory, 'outside'), readable, writable].map((path) => mkdir(path)))
await Promise.all([
  writeFile(secret, 'outside-canary'),
  writeFile(join(workspace, 'allowed'), 'workspace-allowed'),
  writeFile(join(readable, 'allowed'), 'extra-allowed'),
])
// Deliberately conflicting ambient defaults must not replace the embedded snapshot.
process.env.BRIDGE_JAIL_MODE = 'off'
process.env.WORKER_FS_JAIL = ''
process.env.BRIDGE_JAIL_ROOT = '.agent-home/ambient'
process.env.BRIDGE_JAIL_RO_PATHS = join(directory, 'outside')
process.env.BRIDGE_JAIL_RW_PATHS = ''
process.env.BRIDGE_JAIL_FALLBACK = 'warn'
const config = loadConfig({ BRIDGE_BACKENDS: '', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_TRACE: 'off',
  BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_ROOT: '.agent-home/captured',
  BRIDGE_JAIL_RO_PATHS: readable, BRIDGE_JAIL_RW_PATHS: writable, BRIDGE_JAIL_FALLBACK: 'deny' })
const built = await buildApp(config)
let observed: ChatRequest['jailSpec']
const backend: Backend = {
  name: 'filesystem-probe', matches: (model) => model === 'filesystem-probe',
  health: async () => ({ name: 'filesystem-probe', state: 'ready' }),
  async *chat(request, _session, signal) {
    observed = request.jailSpec
    const program = `
      const fs = require('node:fs');
      const [secret, workspace, readable, writable, root] = process.argv.slice(1);
      const read = path => { try { return fs.readFileSync(path, 'utf8') } catch { return null } };
      fs.writeFileSync(writable + '/written', 'extra-writable');
      console.log(JSON.stringify({ outside: read(secret), workspace: read(workspace + '/allowed'),
        readable: read(readable + '/allowed'), root: process.env.HOME }));
    `
    const spawned = await hostSpawner(process.execPath, ['-e', program, secret, workspace, readable, writable], {
      cwd: workspace, env: { ...process.env }, jail: request.jailSpec ?? undefined, signal,
    })
    let stdout = '', stderr = ''
    spawned.child.stdout!.setEncoding('utf8').on('data', (text) => { stdout += text })
    spawned.child.stderr!.setEncoding('utf8').on('data', (text) => { stderr += text })
    try {
      const [code] = await once(spawned.child, 'close')
      assert.equal(code, 0, stderr)
      yield { content: stdout, finish_reason: 'stop' }
    } finally { await spawned.terminate(); spawned.release() }
  },
}
built.registry.register(backend)
const server = serve({ fetch: built.app.fetch, hostname: '127.0.0.1', port: 0 })
try {
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: backend.name, messages: [{ role: 'user', content: 'filesystem probe' }],
      cwd: workspace, execution: { kind: 'host', jail: { mode: 'off' } } }),
  })
  const body = await response.json() as { choices?: Array<{ message: { content: string } }> }
  assert.equal(response.status, 200, JSON.stringify(body))
  const result = JSON.parse(body.choices![0]!.message.content)
  assert.equal(result.outside, null, 'embedded fs-jail must deny the outside canary despite ambient off/RO defaults')
  assert.equal(result.workspace, 'workspace-allowed')
  assert.equal(result.readable, 'extra-allowed')
  assert.equal(result.root, join(workspace, '.agent-home/captured'))
  assert.equal(await readFile(join(writable, 'written'), 'utf8'), 'extra-writable')
  assert.equal(observed?.readConfine, true)
  assert.equal(observed?.root, result.root)
  assert.equal(loadConfig({ WORKER_FS_JAIL: '1' }).jailMode, 'fs-jail')
  await assert.rejects(applyJail('/bin/true', [], { jail: observed! }, selectJailBackend('win32')), /refusing to run unconfined/)
  console.log('PASS real HTTP snapshot mode/root/read paths/write paths/fallback and outside-read denial')
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  for (const close of built.extras.shutdownHooks) await close()
  built.sessions.close()
  await rm(directory, { recursive: true, force: true })
}
