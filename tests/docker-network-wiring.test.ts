import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContainerPoolOptions } from '../src/executors/container-pool.js'
import type { DockerPreflightTarget } from '../src/executors/docker-preflight.js'

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  createSpawner: vi.fn(),
  preflightImage: vi.fn(async () => []),
  preflightSlot: vi.fn(async () => []),
}))

vi.mock('../src/executors/container-pool.js', () => ({
  ContainerPool: { create: mocks.createPool },
}))

vi.mock('../src/executors/docker.js', () => ({
  createDockerSpawner: mocks.createSpawner,
}))

// This test asserts wiring, not host coherence: the startup preflight probes a
// real Docker daemon by design, so the two probe functions are spies here and
// `docker-preflight.test.ts` covers the checks themselves. The spies still prove
// startup CALLS them — for every live slot — because a preflight that runs
// against one slot is evidence about one slot.
vi.mock('../src/executors/docker-preflight.js', async () => {
  const actual = await vi.importActual<typeof import('../src/executors/docker-preflight.js')>(
    '../src/executors/docker-preflight.js',
  )
  return { ...actual, preflightDockerImage: mocks.preflightImage, preflightDockerSlot: mocks.preflightSlot }
})

import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

describe('Docker server wiring', () => {
  const dataDirs: string[] = []

  afterEach(() => {
    mocks.createPool.mockReset()
    mocks.createSpawner.mockReset()
    mocks.preflightImage.mockReset()
    mocks.preflightImage.mockResolvedValue([])
    mocks.preflightSlot.mockReset()
    mocks.preflightSlot.mockResolvedValue([])
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fakePool(containerIds: string[]): { destroy: ReturnType<typeof vi.fn>; liveContainerIds: () => string[] } {
    return { destroy: vi.fn(async () => {}), liveContainerIds: () => containerIds }
  }

  it('carries OPENCODE_DOCKER_NETWORK from startup config into the container pool', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-network-wiring-'))
    dataDirs.push(dataDir)
    const pool = fakePool(['fake-slot-0'])
    mocks.createPool.mockResolvedValue(pool)
    mocks.createSpawner.mockReturnValue(async () => {
      throw new Error('not called while building the server')
    })

    const config = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      BRIDGE_DATA_DIR: dataDir,
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_NETWORK: 'r391-task-net',
    })
    const built = await buildApp(config)

    expect(mocks.createPool).toHaveBeenCalledOnce()
    const options = mocks.createPool.mock.calls[0]![0] as ContainerPoolOptions
    expect(options.network).toBe('r391-task-net')
    expect(mocks.createSpawner).toHaveBeenCalledWith(expect.objectContaining({ pool }))
    // Startup preflight is wired in, not merely available.
    expect(mocks.preflightImage).toHaveBeenCalledOnce()
    expect(mocks.preflightSlot).toHaveBeenCalled()

    for (const shutdown of built.extras.shutdownHooks) await shutdown()
    expect(pool.destroy).toHaveBeenCalledOnce()
    built.sessions.close()
  })

  it('probes EVERY live slot, each against its own per-slot credential volume', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-perslot-wiring-'))
    dataDirs.push(dataDir)
    const pool = fakePool(['fake-slot-0', 'fake-slot-1', 'fake-slot-2', 'fake-slot-3'])
    mocks.createPool.mockResolvedValue(pool)
    mocks.createSpawner.mockReturnValue(async () => {
      throw new Error('not called while building the server')
    })

    const config = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      BRIDGE_DATA_DIR: dataDir,
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_POOL_SIZE: '4',
      OPENCODE_DOCKER_OAUTH_MOUNT: 'per-slot',
      OPENCODE_DOCKER_NAME_PREFIX: 'cli-bridge-wiring',
    })
    const built = await buildApp(config)

    // Slots 1..N-1 have their OWN volumes. Probing slot 0 alone proved nothing
    // about them, and a pool with zero credentials still reported preflight ok.
    const probed = mocks.preflightSlot.mock.calls.map((call) => (call as unknown[])[1] as string)
    expect(probed).toEqual(['fake-slot-0', 'fake-slot-1', 'fake-slot-2', 'fake-slot-3'])
    const sources = mocks.preflightSlot.mock.calls.map(
      (call) => ((call as unknown[])[0] as DockerPreflightTarget).mounts.map((m) => m.source),
    )
    expect(sources[0]).toContain('cli-bridge-wiring-oauth-0')
    expect(sources[3]).toContain('cli-bridge-wiring-oauth-3')

    for (const shutdown of built.extras.shutdownHooks) await shutdown()
    built.sessions.close()
  })
})
