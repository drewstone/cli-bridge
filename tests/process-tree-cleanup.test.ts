import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeSpawned,
  pendingCleanupRetries,
} from '../src/executors/process-tree.js'
import { createHostSpawner, hostExecutorSnapshot, hostSpawner } from '../src/executors/host.js'
import type { SpawnResult } from '../src/executors/types.js'
import { versionHealth } from '../src/backends/health.js'
import { boundedProbe } from '../src/routes/health.js'
import type { Backend } from '../src/backends/types.js'

describe('finalizeSpawned cleanup recovery', () => {
  it('returns terminated capacity immediately and retries a failed path rollback', async () => {
    let releases = 0
    let cleanupCalls = 0
    const child = new EventEmitter() as ChildProcess
    const spawned: SpawnResult = {
      child,
      terminate: async () => {},
      release: () => { releases += 1 },
    }
    const cleanup = async (): Promise<void> => {
      cleanupCalls += 1
      if (cleanupCalls === 1) throw new Error('temporary path replacement')
    }

    await expect(finalizeSpawned(spawned, [cleanup])).rejects.toThrow(/temporary path replacement/u)
    expect(releases).toBe(1)
    expect(pendingCleanupRetries()).toBe(1)

    const deadline = Date.now() + 1_000
    while (pendingCleanupRetries() > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(cleanupCalls).toBe(2)
    expect(pendingCleanupRetries()).toBe(0)
    expect(releases).toBe(1)
  })
})

describe('host capacity cancellation', () => {
  it('does not let one cancelled waiter abort a shared readiness probe', async () => {
    let starts = 0
    let aborts = 0
    let finish!: (health: Awaited<ReturnType<Backend['health']>>) => void
    const backend = {
      name: 'shared-probe',
      matches: () => true,
      health: async (signal?: AbortSignal) => await new Promise<Awaited<ReturnType<Backend['health']>>>(resolve => {
        starts += 1
        finish = resolve
        signal?.addEventListener('abort', () => {
          aborts += 1
          resolve({ name: 'shared-probe', state: 'unavailable', detail: 'cancelled' })
        }, { once: true })
      }),
      chat: async function* () { throw new Error('not used') },
    } satisfies Backend
    const controller = new AbortController()
    const cancelled = boundedProbe(backend, 1_000, controller.signal)
    const waiting = boundedProbe(backend, 1_000)
    await Promise.resolve()
    expect(starts).toBe(1)

    controller.abort(new Error('caller disconnected'))
    await expect(cancelled).resolves.toMatchObject({
      state: 'error',
      detail: 'health probe aborted by caller',
    })
    expect(aborts).toBe(0)

    finish({ name: 'shared-probe', state: 'ready' })
    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
    expect({ starts, aborts }).toEqual({ starts: 1, aborts: 0 })
  })

  it('retries full ownership cleanup before returning a host allocation', async () => {
    const child = new EventEmitter() as ChildProcess
    ;(child as unknown as { exitCode: number | null }).exitCode = null
    ;(child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null
    let cleanupCalls = 0
    let releases = 0
    const spawner = createHostSpawner({
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => child) as never,
      applyJailFn: async (bin, args, opts) => ({
        bin,
        args,
        env: opts.env,
        cleanup: async () => {
          cleanupCalls += 1
          if (cleanupCalls === 1) throw new Error('transient jail cleanup failure')
        },
      }),
      killTreeFn: async () => {},
    })
    const owned = await spawner('ignored', [], { stdio: ['ignore', 'pipe', 'pipe'] })

    await expect(owned.terminate?.()).rejects.toThrow(/transient jail cleanup failure/u)
    expect(releases).toBe(0)
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(cleanupCalls).toBe(2)
    expect(releases).toBe(1)
  })

  it('terminates a timed-out real CLI probe before returning host capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-health-cancel-'))
    const executable = join(root, 'slow-version')
    const marker = join(root, 'pid')
    writeFileSync(executable, `#!/bin/sh\necho $$ > ${JSON.stringify(marker)}\nwhile :; do sleep 1; done\n`)
    chmodSync(executable, 0o755)
    const backend = {
      name: 'slow-probe',
      matches: () => true,
      health: async (signal?: AbortSignal) => await versionHealth('slow-probe', executable, hostSpawner, undefined, signal),
      chat: async function* () { throw new Error('not used') },
    } satisfies Backend
    try {
      const result = await boundedProbe(backend, 200)
      expect(result).toMatchObject({ name: 'slow-probe', state: 'error' })

      const deadline = Date.now() + 2_000
      while (hostExecutorSnapshot().in_flight > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(hostExecutorSnapshot().in_flight).toBe(0)
      const pid = Number(readFileSync(marker, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a cancelled queued spawn before it can consume a permit', async () => {
    const holders: SpawnResult[] = []
    try {
      const max = hostExecutorSnapshot().max
      for (let index = 0; index < max; index += 1) {
        holders.push(await hostSpawner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }))
      }
      expect(hostExecutorSnapshot()).toMatchObject({ in_flight: max, queued: 0 })

      const controller = new AbortController()
      const queued = hostSpawner(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
      })
      const deadline = Date.now() + 1_000
      while (hostExecutorSnapshot().queued === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(hostExecutorSnapshot().queued).toBe(1)

      controller.abort(new Error('caller disconnected'))
      await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
      expect(hostExecutorSnapshot()).toMatchObject({ in_flight: max, queued: 0 })
    } finally {
      await Promise.allSettled(holders.map(async holder => await finalizeSpawned(holder)))
    }
    expect(hostExecutorSnapshot()).toMatchObject({ in_flight: 0, queued: 0 })
  })
})
