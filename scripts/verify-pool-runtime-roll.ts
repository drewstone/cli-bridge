#!/usr/bin/env tsx
/** Actual Docker + authenticated HTTP proof; no provider requests or customer data. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { ContainerPool } from '../src/executors/container-pool.js'
import { dockerCli } from '../src/executors/docker-cli.js'
import { dockerEngine, replaceRuntime, type RollReceipt } from '../src/executors/docker-runtime-roll.js'
import { acquireDataDirectoryLock } from '../src/runtime/single-instance.js'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

const image = process.env.CLI_ROLL_IMAGE
if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('CLI_ROLL_IMAGE immutable existing local image required')
const token = randomBytes(24).toString('hex')
const suffix = randomBytes(5).toString('hex')
const prefix = `cli-bridge-proof-${suffix}`
const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
const legacy = join(root, 'legacy', 'data')
const ws = join(root, 'legacy', 'ws')
const data = join(root, 'current')
for (const dir of [legacy, ws, data]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const owned = new Set<string>()
const volumes = new Set<string>()
const checks: string[] = []
let oldImage = ''
let nextImage = ''
let pool: ContainerPool | undefined
let appOwner: Awaited<ReturnType<typeof buildApp>> | undefined
let server: ReturnType<typeof serve> | undefined
let base = ''

async function command(args: string[]): Promise<string> {
  const result = await dockerCli(args, { timeoutMs: 120_000 })
  if (result.code) throw new Error(`fixture Docker command failed: ${args[0]}`)
  return result.stdout.trim()
}
async function api(path: string, body?: unknown, auth = true) {
  return await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function startApp() {
  appOwner = await buildApp(loadConfig({ BRIDGE_BACKENDS: 'codex', CODEX_EXECUTOR: 'host',
    BRIDGE_DATA_DIR: data, BRIDGE_BEARER: token, BRIDGE_HOST: '127.0.0.1' }))
  server = serve({ fetch: appOwner.app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server!.listening ? resolve() : server!.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function stopApp() {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()))
  if (appOwner) {
    for (const hook of appOwner.extras.shutdownHooks) await hook()
    appOwner.sessions.close()
  }
  server = undefined; appOwner = undefined
}

try {
  // Distinct immutable old image, sharing the existing runtime's layers. This
  // fixture proves replacement mechanics; actual Node22->24 belongs to live proof.
  const seed = await command(['create', '--name', `${prefix}-seed`, image])
  owned.add(seed)
  oldImage = await command(['commit', '--change', `LABEL cli-bridge.proof=${suffix}`, seed])
  nextImage = await command(['commit', '--change', `LABEL cli-bridge.proof-next=${suffix}`, seed])
  await command(['rm', '-v', seed]); owned.delete(seed)

  pool = await ContainerPool.create({ size: 2, image: oldImage, namePrefix: `${prefix}-leases`,
    oauthMode: 'share', workspaceRoot: ws, slotMaxHoldMs: 0 })
  for (const id of pool.liveContainerIds()) owned.add(id)
  const first = await pool.acquire()
  const worker = dockerCli(['exec', first.containerId, 'sleep', '2'])
  pool.drainSlot(first.slotIndex, first.containerId)
  let replacedBusy = false
  await assert.rejects(pool.rollSlot(first.slotIndex, first.containerId, image, async () => { replacedBusy = true; return '' }))
  assert.equal(replacedBusy, false)
  const other = await pool.acquire()
  assert.notEqual(other.slotIndex, first.slotIndex)
  other.release()
  assert.equal((await worker).code, 0)
  first.release()
  const next = await pool.acquire()
  assert.notEqual(next.slotIndex, first.slotIndex)
  next.release()
  checks.push('drain preserves real active exec and routes other work to another slot')
  let armed = false
  const receipt: RollReceipt = { oldId: first.containerId, imageId: image,
    name: `${prefix}-leases-${first.slotIndex}`, nonce: randomBytes(16).toString('hex'), phase: 'intent' }
  const replacement = await pool.rollSlot(first.slotIndex, first.containerId, image, async (_id, arm) =>
    await replaceRuntime(receipt, () => {}, async (id) => { await arm(id); armed = true }))
  owned.add(replacement)
  assert.equal(armed, true)
  assert.equal((await dockerEngine('GET', `/containers/${first.containerId}/json`)).State.Running, false)
  checks.push('drained idle slot promotes immutable image and retains stopped old container')
  await pool.destroy(); pool = undefined

  const slots = []
  for (let index = 0; index < 2; index++) {
    const volume = `${prefix}-auth-${index}`
    volumes.add(volume)
    const id = await command(['run', '-d', '--name', `${prefix}-${index}`, '--restart', 'on-failure:3',
      '--memory', '128m', '--cpus', '1', '--env', `PROOF_SECRET=${token}`, '--mount', `type=bind,source=${ws},target=${ws}`,
      '--mount', `type=volume,source=${volume},target=/root/.config/opencode`, oldImage, 'tail', '-f', '/dev/null'])
    owned.add(id); slots.push({ index, id })
    await command(['exec', id, 'sh', '-c', 'printf retained > /root/.config/opencode/proof-marker'])
  }
  await startApp()
  assert.equal((await api('/admin/pools/status', undefined, false)).status, 401)
  const manifest = { prefix, legacyDataDir: legacy, legacyPorts: [49171], expectedImage: oldImage, slots }
  // A real unexpected process blocks adoption; the failed attempt releases its
  // otherwise-unreferenced data-directory lock.
  const unexpected = dockerCli(['exec', slots[0]!.id, 'sleep', '3'])
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await api('/admin/pools/adopt', manifest)).status, 409)
  const lock = acquireDataDirectoryLock(legacy); lock.release()
  assert.equal((await unexpected).code, 0)
  assert.equal((await api('/admin/pools/adopt', manifest)).status, 200)
  assert.equal((await api('/admin/pools/adopt', manifest)).status, 409)
  checks.push('authenticated adoption refuses unexpected work and releases refused ownership lock')

  for (const slot of slots) {
    assert.equal((await api(`/admin/pools/${prefix}/slots/${slot.index}/drain`, { expectedId: slot.id })).status, 200)
    const response = await api(`/admin/pools/${prefix}/slots/${slot.index}/roll`, { expectedId: slot.id, imageId: image })
    if (response.status !== 200) throw new Error(`actual HTTP roll refused: ${JSON.stringify(await response.json())}`)
    const body = await response.json() as { receipt: RollReceipt }
    const id = body.receipt.candidateId!
    owned.add(id)
    const info = await dockerEngine('GET', `/containers/${id}/json`)
    assert.equal(info.Image, image)
    assert.ok(info.Config.Env.includes(`PROOF_SECRET=${token}`))
    assert.equal(info.HostConfig.Memory, 128 * 1024 * 1024)
    assert.equal(await command(['exec', id, 'cat', '/root/.config/opencode/proof-marker']), 'retained')
    assert.ok(info.Mounts.some((m: any) => m.Source === ws && m.Destination === ws && m.RW))
    assert.equal((await dockerEngine('GET', `/containers/${slot.id}/json`)).State.Running, false)
  }
  checks.push('two real HTTP rolls preserve credential volumes, bind mounts, private env and resources')
  await stopApp()
  await startApp()
  for (const slot of slots) {
    assert.equal((await api(`/admin/pools/${prefix}/slots/${slot.index}/roll`, { expectedId: slot.id, imageId: image })).status, 200)
  }
  const status = await (await api('/admin/pools/status')).json() as { pools: Array<{ slots: Array<{ draining: boolean }> }> }
  assert.ok(status.pools[0]!.slots.every((slot) => !slot.draining))
  assert.equal(readFileSync(join(data, 'pool-maintenance.json'), 'utf8').includes(token), false)
  checks.push('actual HTTP owner restart reconciles completed receipts and re-admits verified slots without secrets in journal')
  const firstRoll = JSON.parse(readFileSync(join(data, 'pool-maintenance.json'), 'utf8')).pools[0].rolls['0'] as RollReceipt
  const currentId = firstRoll.candidateId!
  assert.equal((await api(`/admin/pools/${prefix}/slots/0/drain`, { expectedId: currentId })).status, 200)
  const completedJournal = readFileSync(join(data, 'pool-maintenance.json'), 'utf8')
  assert.equal((await api(`/admin/pools/${prefix}/slots/0/roll`, { expectedId: currentId, imageId: `sha256:${'0'.repeat(64)}` })).status, 409)
  assert.equal(readFileSync(join(data, 'pool-maintenance.json'), 'utf8'), completedJournal)
  const secondResponse = await api(`/admin/pools/${prefix}/slots/0/roll`, { expectedId: currentId, imageId: nextImage })
  assert.equal(secondResponse.status, 200)
  const second = (await secondResponse.json() as { receipt: RollReceipt }).receipt
  owned.add(second.candidateId!)
  assert.notEqual(second.nonce, firstRoll.nonce)
  assert.equal(second.oldId, currentId)
  assert.equal((await dockerEngine('GET', `/containers/${currentId}/json`)).State.Running, false)
  assert.equal((await dockerEngine('GET', `/containers/${slots[0]!.id}/json`)).State.Running, false)
  assert.equal(await command(['exec', second.candidateId!, 'cat', '/root/.config/opencode/proof-marker']), 'retained')
  await stopApp()
  await startApp()
  assert.equal((await api(`/admin/pools/${prefix}/slots/0/roll`, { expectedId: currentId, imageId: nextImage })).status, 200)
  assert.equal((await api(`/admin/pools/${prefix}/slots/0/roll`, { expectedId: slots[0]!.id, imageId: image })).status, 409)
  const journal = JSON.parse(readFileSync(join(data, 'pool-maintenance.json'), 'utf8')).pools[0]
  assert.deepEqual(journal.slots, slots)
  assert.deepEqual(journal.history['0'], [firstRoll])
  assert.equal(journal.rolls['0'].candidateId, second.candidateId)
  const repeatedStatus = await (await api('/admin/pools/status')).json() as { pools: Array<{ slots: Array<{ containerId: string; draining: boolean }> }> }
  assert.equal(repeatedStatus.pools[0]!.slots[0]!.containerId, second.candidateId)
  assert.equal(repeatedStatus.pools[0]!.slots[0]!.draining, false)
  checks.push('second immutable artifact appends prior receipt, preserves original identities and volumes, rejects stale intent, and reconciles after owner restart')
  checks.push('missing second artifact refuses without changing completed journal')
  const result = { complete: true, checks, old_fixture_image: oldImage, candidate_image: image,
    second_candidate_image: nextImage,
    production_node_upgrade_proven: false, no_model_calls: true }
  const output = process.env.CLI_ROLL_PROOF_OUTPUT
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(result))
} finally {
  await stopApp()
  if (pool) await pool.destroy()
  // All names/IDs below were created by this invocation. No shared pruning.
  for (const id of owned) await dockerCli(['rm', '-f', '-v', id])
  for (const volume of volumes) await dockerCli(['volume', 'rm', volume])
  if (oldImage) await dockerCli(['image', 'rm', oldImage])
  if (nextImage) await dockerCli(['image', 'rm', nextImage])
  rmSync(root, { recursive: true, force: true })
}
