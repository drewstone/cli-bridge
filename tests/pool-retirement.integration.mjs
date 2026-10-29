import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
import { retirePools } from '../bin/retire-pools.mjs'

const execute = promisify(execFile)
const docker = async (...args) => (await execute('docker', ['--host', process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock', ...args], { timeout: 30_000, maxBuffer: 1_048_576 })).stdout.trim()

test('retirement refuses ownership, listeners, identity mismatch and real active work; stops exact idle slots with durable replay', {
  skip: process.env.CLI_BRIDGE_POOL_RETIRE_TESTS !== '1', timeout: 180_000,
}, async (context) => {
  await docker('version', '--format', '{{.Server.Version}}')
  const root = await mkdtemp(join(tmpdir(), 'bridge-retire-integration-'))
  const prefix = `cli-bridge-proof-${randomBytes(5).toString('hex')}`
  let id, fixtureImage
  context.after(async () => {
    try { if (id) await docker('rm', '-f', id) }
    finally {
      try { if (fixtureImage) await docker('image', 'rm', fixtureImage) }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  let image = process.env.CLI_BRIDGE_RETIRE_TEST_IMAGE
  if (!image) {
    const policy = await readFile(new URL('../docker/Dockerfile', import.meta.url), 'utf8')
    const base = /^FROM\s+(\S+)/m.exec(policy)?.[1]
    assert.ok(base, 'packaging Dockerfile must declare its base image')
    await docker('image', 'inspect', '--format', '{{.Id}}', base)
    await writeFile(join(root, 'Dockerfile'), `FROM ${base}
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["dumb-init", "--"]
CMD ["tail", "-f", "/dev/null"]
`)
    image = `${prefix}:retirement`
    await execute('docker', ['--host', process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
      'build', '--pull=false', '-t', image, root], { timeout: 120_000, maxBuffer: 2_097_152 })
    fixtureImage = image
  }
  image = await docker('image', 'inspect', '--format', '{{.Id}}', image)
  const legacy = join(root, 'legacy')
  await mkdir(legacy, { mode: 0o700 })
  const nonce = randomBytes(16).toString('hex')
  const oldId = randomBytes(32).toString('hex')
  id = await docker('run', '-d', '--name', `${prefix}-0`, '--restart', 'always',
    '--label', `cli-bridge.maintenance.nonce=${nonce}`, '--label', `cli-bridge.maintenance.old-id=${oldId}`,
    '--mount', `type=bind,src=${legacy},dst=/proof`, image, 'tail', '-f', '/dev/null')
  const listener = createServer()
  context.after(async () => { if (listener.listening) await new Promise((resolve) => listener.close(resolve)) })
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  const journal = { schema: 1, pools: [{ prefix, image, legacyDataDir: legacy, legacyPorts: [port],
    slots: [{ index: 0, id: oldId }], rolls: { 0: { oldId, candidateId: id, imageId: image,
      name: `${prefix}-0`, nonce, phase: 'promoted' } } }] }
  const path = join(root, 'pool-maintenance.json')
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 })
  await assert.rejects(retirePools(root), /listener still exists/)
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  const { acquireDataDirectoryLock } = await tsImport('../src/runtime/single-instance.ts', import.meta.url)
  const ownership = acquireDataDirectoryLock(legacy)
  try { await assert.rejects(retirePools(root), /already owned/) } finally { ownership.release() }
  journal.pools[0].rolls[0].nonce = 'f'.repeat(32)
  await writeFile(path, JSON.stringify(journal))
  await assert.rejects(retirePools(root), /identity or idle configuration differs/)
  journal.pools[0].rolls[0].nonce = nonce
  await writeFile(path, JSON.stringify(journal))
  const worker = spawn('docker', ['--host', process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock', 'exec', id, 'sleep', '30'], { stdio: 'ignore' })
  const workerExit = once(worker, 'exit')
  try {
    const deadline = Date.now() + 5000
    while (!(JSON.parse(await docker('inspect', id))[0].ExecIDs ?? []).length) {
      if (Date.now() > deadline) throw new Error('real worker did not begin')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await assert.rejects(retirePools(root), /identity or idle configuration differs|active work/)
    assert.equal(await docker('inspect', '--format', '{{.State.Running}}', id), 'true')
  } finally {
    await docker('exec', id, 'node', '-e', "const fs=require('node:fs');for(const p of fs.readdirSync('/proc')){if(/^\\d+$/.test(p)){try{if(fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='sleep')process.kill(Number(p),'SIGTERM')}catch{}}}")
    await workerExit
  }
  const before = JSON.parse(await docker('inspect', id))[0]
  const original = await readFile(path, 'utf8')
  const receipt = await retirePools(root)
  assert.equal(receipt.slots[id].phase, 'stopped')
  const after = JSON.parse(await docker('inspect', id))[0]
  assert.equal(after.State.Running, false)
  assert.equal(after.HostConfig.RestartPolicy.Name, 'no')
  assert.deepEqual(after.Config, before.Config)
  assert.deepEqual(after.Mounts, before.Mounts)
  assert.equal(after.Image, before.Image)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await retirePools(root)).slots[id].phase, 'stopped')
  const persisted = JSON.parse(await readFile(join(root, 'pool-retirement.json'), 'utf8'))
  assert.equal(persisted.slots[id].phase, 'stopped')
})
