import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Spawner } from '../src/executors/types.js'

/**
 * pi refuses every turn on a host executor unless an enforced Linux fs-jail is available.
 * /health must say so. It used to run only `pi --version`, which succeeds on any platform, so
 * a macOS bridge reported `pi -> ready` while every request returned 501 not_configured.
 *
 * The version probe is replaced with a sentinel so each test observes exactly one thing: whether
 * health() stopped at the jail gate or fell through to the probe. That keeps these tests free of
 * the probe's process handling and of its module-level ready cache, which other test files share.
 */
const jail = vi.hoisted(() => ({ name: 'seatbelt', available: true }))
const probe = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../src/jail/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/jail/index.js')>()
  return {
    ...actual,
    selectJailBackend: () => ({ name: jail.name, isAvailable: async () => jail.available }),
  }
})

vi.mock('../src/backends/health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backends/health.js')>()
  return {
    ...actual,
    versionHealth: async (name: string) => {
      probe.calls += 1
      return { name, state: 'ready', detail: 'version probe reached' }
    },
  }
})

const { PiBackend } = await import('../src/backends/pi.js')

function spawnerFor(environment: 'host' | 'test-double'): Spawner {
  const spawner = (async () => {
    throw new Error('health() must not spawn directly; the version probe is stubbed')
  }) as unknown as Spawner
  spawner.executionEnvironment = environment
  return spawner
}

const backendFor = (environment: 'host' | 'test-double') =>
  new PiBackend({ bin: 'pi', timeoutMs: 0, spawner: spawnerFor(environment) } as never)

describe('pi health reports the jail precondition chat() enforces', () => {
  afterEach(() => {
    jail.name = 'seatbelt'
    jail.available = true
    probe.calls = 0
  })

  it('reports unavailable on a host executor whose only jail is the macOS write-only seatbelt', async () => {
    jail.name = 'seatbelt'
    const health = await backendFor('host').health()
    expect(health.state).toBe('unavailable')
    expect(health.detail).toContain('bubblewrap')
    expect(health.detail).toContain('seatbelt')
    expect(probe.calls).toBe(0)
  })

  it('reports unavailable when bubblewrap is the backend but is not installed', async () => {
    jail.name = 'bwrap'
    jail.available = false
    const health = await backendFor('host').health()
    expect(health.state).toBe('unavailable')
    expect(probe.calls).toBe(0)
  })

  it('falls through to the version probe on a host with an available bubblewrap', async () => {
    jail.name = 'bwrap'
    jail.available = true
    const health = await backendFor('host').health()
    expect(health.detail).toBe('version probe reached')
    expect(probe.calls).toBe(1)
  })

  it('does not gate a non-host executor on the host jail', async () => {
    jail.name = 'seatbelt'
    const health = await backendFor('test-double').health()
    expect(health.detail).toBe('version probe reached')
    expect(probe.calls).toBe(1)
  })
})
