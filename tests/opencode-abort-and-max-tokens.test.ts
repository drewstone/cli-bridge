/**
 * Two opencode backend refusals that must happen before a process exists:
 *
 * - max_tokens (#138): opencode has no verified native output cap, so an
 *   accepted bound would look enforced to cost accounting while the run spends
 *   above it (measured 2026-08-10: admitted max 320 tokens, settled 1,068).
 * - abort during spawn (#136): the spawner await is a real window for an early
 *   cancel; the listener installed after it never fires for an already-aborted
 *   signal, and the child stays alive until the iterator closes (observed as
 *   >20s teardown acknowledgment in Braid's packed cancellation test).
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

const workspaces: string[] = []
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-refusal-'))
  workspaces.push(dir)
  return dir
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class SilentChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
}

describe('opencode refuses max_tokens it cannot enforce', () => {
  it('rejects before spawn with the not-started marker and writes nothing', async () => {
    const cwd = workspace()
    const calls: number[] = []
    const spawner: Spawner = async (): Promise<SpawnResult> => {
      calls.push(1)
      throw new Error('spawner reached: max_tokens was not refused')
    }
    spawner.executionEnvironment = 'test-double'
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner })

    const request: ChatRequest = {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'do the task' }],
      cwd,
      max_tokens: 320,
    }
    await expect(async () => {
      for await (const _ of backend.chat(request, null, new AbortController().signal)) void _
    }).rejects.toMatchObject({
      name: 'BackendError',
      code: 'not_configured',
      providerDispatch: 'not_started',
    })

    expect(calls).toHaveLength(0)
    expect(readdirSync(cwd)).toEqual([])
  })
})

describe('opencode binds cancellation across the spawn window', () => {
  it('terminates immediately when the spawner resolves after the signal aborted', async () => {
    const controller = new AbortController()
    const child = new SilentChild()
    let spawnedAt = 0
    let terminatedAt = 0
    let terminateCalls = 0

    const delayedSpawner: Spawner = async (): Promise<SpawnResult> => {
      await sleep(30)
      spawnedAt = performance.now()
      return {
        child,
        terminate: async () => {
          terminateCalls += 1
          terminatedAt = performance.now()
          // A real kill ends the pipes and emits 'close'; schedule it a few
          // ticks out so readProcessLines has attached to stdout first.
          setTimeout(() => {
            // A killed child carries its signal; waitForProcessClose reads
            // it instead of waiting for a 'close' that already fired.
            child.signalCode = 'SIGTERM'
            child.stdout.end()
            child.stderr.end()
            child.emit('close')
          }, 5).unref?.()
        },
        release: () => {},
      }
    }
    delayedSpawner.executionEnvironment = 'test-double'
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: delayedSpawner })

    const request: ChatRequest = {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'do the task' }],
    }
    // Abort while the spawner is still pending: the old code registered the
    // listener after this window and never fired it.
    setTimeout(() => controller.abort(), 5)

    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(request, null, controller.signal)) {
      deltas.push(delta)
    }

    // The aborted turn ends with a terminal error delta, and the executor's
    // workload was terminated exactly once, immediately after the spawner
    // resolved — not only when the iterator closed.
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'error' })
    expect(terminateCalls).toBe(1)
    expect(terminatedAt - spawnedAt).toBeLessThan(20)
  })
})
