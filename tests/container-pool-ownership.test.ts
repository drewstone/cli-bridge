import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ContainerPool } from '../src/executors/container-pool.js'
import { dockerCli, type DockerCli, type DockerCliResult } from '../src/executors/docker-cli.js'
import {
  defaultDockerNamePrefix,
  dockerResourceOwner,
  ensureOwnedDockerVolume,
  removeOwnedDockerResource,
} from '../src/executors/docker-resource-owner.js'

const OWNER = 'a'.repeat(64)

interface FakeDocker {
  cli: DockerCli
  failRunsFor: Set<string>
  removed: string[]
  delayLivenessMs: number
}

function fakeDocker(): FakeDocker {
  const objects = new Map<string, { id: string; name: string; owner: string }>()
  const failRunsFor = new Set<string>()
  const removed: string[] = []
  let sequence = 0
  const ok = (stdout = ''): DockerCliResult => ({ code: 0, stdout, stderr: '' })
  const missing = (name: string): DockerCliResult => ({
    code: 1, stdout: '', stderr: `Error: No such container: ${name}`,
  })
  const state: FakeDocker = {
    failRunsFor,
    removed,
    delayLivenessMs: 0,
    cli: async args => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args[args.length - 1]!
        const object = objects.get(name)
        return object ? ok(`${object.owner}\n`) : missing(name)
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]!
        if (failRunsFor.has(name)) return { code: 125, stdout: '', stderr: `run refused for ${name}` }
        const ownerLabel = args.find(value => value.startsWith('com.tangle.cli-bridge.owner='))
        const owner = ownerLabel?.slice(ownerLabel.indexOf('=') + 1) ?? ''
        const id = `container-${++sequence}`
        const object = { id, name, owner }
        objects.set(id, object)
        objects.set(name, object)
        return ok(`${id}\n`)
      }
      if (args[0] === 'rm') {
        const target = args[args.length - 1]!
        const object = objects.get(target)
        if (object) {
          objects.delete(object.id)
          objects.delete(object.name)
          removed.push(object.id)
        }
        return ok()
      }
      if (args[0] === 'inspect') {
        if (state.delayLivenessMs > 0) {
          await new Promise(resolve => setTimeout(resolve, state.delayLivenessMs))
        }
        const target = args[args.length - 1]!
        return objects.has(target) ? ok('true 2026-08-01T00:00:00Z\n') : missing(target)
      }
      if (args[0] === 'exec') return ok()
      return ok()
    },
  }
  return state
}

function options(cli: DockerCli, overrides: Partial<Parameters<typeof ContainerPool.create>[0]> = {}) {
  return {
    size: 1,
    image: 'runtime:test',
    namePrefix: 'cli-bridge-owner-test',
    resourceOwner: OWNER,
    oauthMode: 'share' as const,
    shareMounts: [],
    cli,
    acquireDeadlineMs: 100,
    slotMaxHoldMs: 60_000,
    ...overrides,
  }
}

describe('ContainerPool resource ownership and recovery', () => {
  it('removes successful slots when another parallel slot fails initial provisioning', async () => {
    const docker = fakeDocker()
    docker.failRunsFor.add('cli-bridge-owner-test-1')
    await expect(ContainerPool.create(options(docker.cli, { size: 2 }))).rejects.toThrow(/slot 1/u)
    expect(docker.removed).toEqual(['container-1'])
  })

  it('removes a new container when post-create HOME normalization fails', async () => {
    const docker = fakeDocker()
    const cli: DockerCli = async (args, opts) => args[0] === 'exec'
      ? { code: 1, stdout: '', stderr: 'chown refused' }
      : await docker.cli(args, opts)
    await expect(ContainerPool.create(options(cli, {
      containerUser: '1001:1001',
      containerHome: '/home/worker',
    }))).rejects.toThrow(/destroyed unused.*chown refused/su)
    expect(docker.removed).toEqual(['container-1'])
  })

  it('does not leak a busy slot when a queued acquire times out during its liveness check', async () => {
    const docker = fakeDocker()
    const pool = await ContainerPool.create(options(docker.cli, {
      acquireDeadlineMs: 20,
      livenessTtlMs: 0,
    }))
    try {
      const holder = await pool.acquire()
      const queued = pool.acquire()
      docker.delayLivenessMs = 60
      holder.release()
      await expect(queued).rejects.toThrow(/acquire timeout/u)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(pool.snapshot().in_flight).toBe(0)
      docker.delayLivenessMs = 0
      const next = await pool.acquire()
      next.release()
    } finally {
      await pool.destroy()
    }
  })

  it('removes a cancelled waiter before a released slot can dispatch it', async () => {
    const docker = fakeDocker()
    const pool = await ContainerPool.create(options(docker.cli))
    try {
      const holder = await pool.acquire()
      const controller = new AbortController()
      const queued = pool.acquire(undefined, controller.signal)
      expect(pool.snapshot().queued).toBe(1)

      controller.abort(new Error('caller disconnected'))
      await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
      expect(pool.snapshot().queued).toBe(0)

      holder.release()
      expect(pool.snapshot().in_flight).toBe(0)
      const next = await pool.acquire()
      next.release()
    } finally {
      await pool.destroy()
    }
  })

  it('preserves original slot indexes after an earlier slot dies', async () => {
    const docker = fakeDocker()
    const pool = await ContainerPool.create(options(docker.cli, {
      size: 2,
      maxConsecutiveFailures: 1,
      reprovisionBackoffMs: 5,
    }))
    try {
      const first = pool.liveContainerIds().find(slot => slot.slotIndex === 0)!
      docker.failRunsFor.add('cli-bridge-owner-test-0')
      await expect(pool.reportContainerUnusable(first.containerId)).rejects.toThrow(/run refused/u)
      expect(pool.liveContainerIds()).toEqual([
        expect.objectContaining({ slotIndex: 1 }),
      ])
    } finally {
      await pool.destroy()
    }
  })

  it('retries a transient reprovision failure and marks dead only at the configured threshold', async () => {
    const docker = fakeDocker()
    const pool = await ContainerPool.create(options(docker.cli, {
      maxConsecutiveFailures: 3,
      reprovisionBackoffMs: 5,
    }))
    try {
      const first = pool.liveContainerIds()[0]!
      docker.failRunsFor.add('cli-bridge-owner-test-0')
      await expect(pool.reportContainerUnusable(first.containerId)).rejects.toThrow(/run refused/u)
      expect(pool.snapshot()).toMatchObject({ dead: 0, recovering: 1 })
      docker.failRunsFor.delete('cli-bridge-owner-test-0')
      const deadline = Date.now() + 500
      while (pool.snapshot().recovering > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(pool.snapshot()).toMatchObject({ dead: 0, recovering: 0 })
      const recovered = await pool.acquire()
      expect(recovered.containerId).not.toBe(first.containerId)
      recovered.release()
    } finally {
      await pool.destroy()
    }
  })
})

describe('Docker owner identities', () => {
  it('derives different stable defaults for two bridge data directories', () => {
    const first = dockerResourceOwner('/srv/bridge-a/data')
    const second = dockerResourceOwner('/srv/bridge-b/data')
    expect(first).not.toBe(second)
    expect(dockerResourceOwner('/srv/bridge-a/data')).toBe(first)
    expect(defaultDockerNamePrefix('pi', first)).not.toBe(defaultDockerNamePrefix('pi', second))
  })

  const dockerAvailable = spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 3_000 }).status === 0
  it.skipIf(!dockerAvailable)('refuses cross-owner volume removal against the real Docker daemon', async () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'cli-bridge-owner-a-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'cli-bridge-owner-b-'))
    const ownerA = dockerResourceOwner(firstDir)
    const ownerB = dockerResourceOwner(secondDir)
    const volume = `cli-bridge-owner-proof-${process.pid}-${randomBytes(5).toString('hex')}`
    try {
      await ensureOwnedDockerVolume(dockerCli, volume, ownerA)
      await expect(ensureOwnedDockerVolume(dockerCli, volume, ownerB)).rejects.toThrow(/belongs to bridge owner/u)
      await expect(removeOwnedDockerResource(dockerCli, 'volume', volume, ownerB)).rejects.toThrow(/refusing to remove/u)
      await removeOwnedDockerResource(dockerCli, 'volume', volume, ownerA)
    } finally {
      await removeOwnedDockerResource(dockerCli, 'volume', volume, ownerA).catch(() => {})
      rmSync(firstDir, { recursive: true, force: true })
      rmSync(secondDir, { recursive: true, force: true })
    }
  }, 30_000)
})
