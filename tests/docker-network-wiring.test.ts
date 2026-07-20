import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContainerPoolOptions } from '../src/executors/container-pool.js'

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  createSpawner: vi.fn(),
}))

vi.mock('../src/executors/container-pool.js', () => ({
  ContainerPool: { create: mocks.createPool },
}))

vi.mock('../src/executors/docker.js', () => ({
  createDockerSpawner: mocks.createSpawner,
}))

import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

describe('Docker network server wiring', () => {
  const dataDirs: string[] = []

  afterEach(() => {
    mocks.createPool.mockReset()
    mocks.createSpawner.mockReset()
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('carries OPENCODE_DOCKER_NETWORK from startup config into the container pool', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-network-wiring-'))
    dataDirs.push(dataDir)
    const destroy = vi.fn(async () => {})
    const pool = { destroy }
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

    for (const shutdown of built.extras.shutdownHooks) await shutdown()
    expect(destroy).toHaveBeenCalledOnce()
    built.sessions.close()
  })
})
