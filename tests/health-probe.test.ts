import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

import { probeCliVersion } from '../src/backends/health-probe.js'
import type { Spawner, SpawnResult } from '../src/executors/types.js'

/** A fake child: `hang:true` never closes (the wedge case); otherwise emits
 *  stdout then `close(code)`. pid=undefined so killTree is a safe no-op. */
function fakeChild(opts: { hang?: boolean; code?: number; stdout?: string }): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter
  ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
  ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
  ;(child as unknown as { pid: number | undefined }).pid = undefined
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  ;(child as unknown as { signalCode: string | null }).signalCode = null
  if (!opts.hang) {
    setImmediate(() => {
      if (opts.stdout) (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(opts.stdout))
      ;(child as EventEmitter).emit('close', opts.code ?? 0)
    })
  }
  return child
}

function spawnerFor(child: ChildProcess, release: () => void): Spawner {
  return async (): Promise<SpawnResult> => ({ child, release, spawnError: () => null })
}

describe('#529 — health probe self-limits, never leaks a host-executor slot', () => {
  // THE regression: before this, a health() whose --version child never closed
  // left its `finally release()` unreached → the slot leaked → bridge wedged at
  // in_flight=max → real tasks failed with `acquire timeout` (observed 10/13).
  it('a HUNG probe self-times-out AND releases the slot', async () => {
    const release = vi.fn()
    const h = await probeCliVersion({
      spawner: spawnerFor(fakeChild({ hang: true }), release),
      bin: 'claude', name: 'claude-code', timeoutMs: 50,
      onReady: (s) => ({ name: 'claude-code', state: 'ready', version: s }),
    })
    expect(h.state).toBe('error')
    expect(h.detail).toContain('self-timeout')
    expect(release).toHaveBeenCalledTimes(1) // slot freed even though the probe hung
  })

  it('a healthy probe reports ready and releases', async () => {
    const release = vi.fn()
    const h = await probeCliVersion({
      spawner: spawnerFor(fakeChild({ code: 0, stdout: '1.2.3\n' }), release),
      bin: 'claude', name: 'claude-code',
      onReady: (s) => ({ name: 'claude-code', state: 'ready', version: s.trim() }),
    })
    expect(h).toMatchObject({ state: 'ready', version: '1.2.3' })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a nonzero-exit probe reports error and releases', async () => {
    const release = vi.fn()
    const h = await probeCliVersion({
      spawner: spawnerFor(fakeChild({ code: 1 }), release),
      bin: 'x', name: 'x', onReady: () => ({ name: 'x', state: 'ready' }),
    })
    expect(h.state).toBe('error')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('N hung probes release N slots — no permanent leak under repeated polling', async () => {
    let live = 0
    let maxLive = 0
    for (let i = 0; i < 10; i++) {
      const release = () => { live -= 1 }
      live += 1; maxLive = Math.max(maxLive, live)
      await probeCliVersion({
        spawner: spawnerFor(fakeChild({ hang: true }), release),
        bin: 'claude', name: 'claude-code', timeoutMs: 20,
        onReady: () => ({ name: 'claude-code', state: 'ready' }),
      })
    }
    expect(live).toBe(0) // every slot freed — would be 10 (wedged) before the fix
  })
})
