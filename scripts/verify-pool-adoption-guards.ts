#!/usr/bin/env tsx
/** Real Linux IPv6 listener + Docker startup refusal proof. No models or mocks. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerCli } from '../src/executors/docker-cli.js'
import { PoolMaintenance } from '../src/runtime/pool-maintenance.js'
import { acquireDataDirectoryLock } from '../src/runtime/single-instance.js'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

const image = process.env.CLI_ROLL_IMAGE
if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('existing immutable CLI_ROLL_IMAGE required')
const prefix = `cli-bridge-guard-${randomBytes(5).toString('hex')}`
const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
const legacy = join(root, 'legacy', 'data'), workspace = join(root, 'legacy', 'workspace')
const data = join(root, 'owner'), badData = join(root, 'bad-startup')
for (const dir of [legacy, workspace, data, badData]) mkdirSync(dir, { recursive: true, mode: 0o700 })
let id = ''
let owner: PoolMaintenance | undefined
const listener = createServer()
try {
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({ host: '::1', port: 0, ipv6Only: true }, resolve)
  })
  const port = (listener.address() as { port: number }).port
  const result = await dockerCli(['run', '-d', '--name', `${prefix}-0`, '--mount',
    `type=bind,source=${workspace},target=${workspace}`, image, 'tail', '-f', '/dev/null'])
  assert.equal(result.code, 0); id = result.stdout.trim()
  owner = new PoolMaintenance(data)
  const manifest = { prefix, legacyDataDir: legacy, legacyPorts: [port], expectedImage: image,
    slots: [{ index: 0, id }] }
  await assert.rejects(owner.adopt(manifest), /legacy controller still listens/)
  const lock = acquireDataDirectoryLock(legacy); lock.release()
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  await owner.adopt(manifest)
  await owner.close(); owner = undefined

  writeFileSync(join(badData, 'pool-maintenance.json'), '{malformed', { mode: 0o600 })
  const startupPrefix = `${prefix}-startup`
  await assert.rejects(buildApp(loadConfig({ BRIDGE_BACKENDS: 'opencode', BRIDGE_BEARER: randomBytes(24).toString('hex'),
    BRIDGE_DATA_DIR: badData, OPENCODE_EXECUTOR: 'docker', OPENCODE_DOCKER_IMAGE: image,
    OPENCODE_DOCKER_POOL_SIZE: '2', OPENCODE_DOCKER_NAME_PREFIX: startupPrefix })), /maintenance journal needs operator reconciliation/)
  const containers = await dockerCli(['ps', '-aq', '--filter', `name=${startupPrefix}`])
  assert.equal(containers.code, 0); assert.equal(containers.stdout.trim(), '')
  console.log(JSON.stringify({ complete: true, ipv6_listener_refused: true, refused_adoption_lock_released: true,
    adoption_after_listener_close: true, malformed_journal_refused_before_docker_provision: true,
    configured_startup_containers_created: 0, image, no_model_calls: true }))
} finally {
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
  await owner?.close()
  if (id) await dockerCli(['rm', '-f', '-v', id])
  rmSync(root, { recursive: true, force: true })
}
