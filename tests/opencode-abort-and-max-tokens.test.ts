/**
 * The opencode output-cap contract, at the unit seam, plus the abort-window
 * regression that lives beside it (#136).
 *
 * max_tokens stopped being a blanket refusal (#138's position: opencode exposes
 * no cap) once the native runner's experimental output-token maximum was
 * verified on the wire (opencode 1.18.30: every provider request carries
 * `max_tokens = min(model.limit.output, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX)`,
 * invalid spellings silently ignored, default 32000). What must hold here:
 *
 * - a request value the runner would silently ignore (not a positive integer)
 *   is refused before spawn, because an ignored cap is #138 again;
 * - a profile's independent visible/reasoning ceilings cannot ride a request
 *   cap the runner cannot split — refused before spawn;
 * - a valid cap reaches the runner as its env flag and pins the session title
 *   (title generation is an extra model call whose billing prints no receipt);
 * - an uncapped turn carries neither the flag nor --title: unchanged;
 * - step receipts accrue on the turn, and a receipt that crosses the cap ends
 *   the turn truncated (`length`) with the runner terminated — never a `stop`
 *   success for spend above the caller's budget;
 * - a provider's own `length` step reason ends the turn `length`.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { OpencodeBackend, resolveOpencodeOutputTokenCap } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

const workspaces: string[] = []
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cap-'))
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

/** A spawner double that records the launch and plays scripted stdout lines. */
function recordingSpawner(script: string[] = []): {
  spawner: Spawner
  launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }>
  terminateCalls: number
  /** True when the scripted run closed on its own before any termination. */
  naturalExit: boolean
} {
  const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const state = { terminateCalls: 0, naturalExit: false }
  const spawner: Spawner = async (bin, args, opts): Promise<SpawnResult> => {
    launches.push({ args, env: opts.env ?? {} })
    const child = new SilentChild()
    let terminated = false
    const finish = (): void => {
      child.exitCode = 0
      child.stdout.end()
      child.stderr.end()
      child.emit('close')
    }
    const terminate = async (): Promise<void> => {
      if (terminated) return
      terminated = true
      state.terminateCalls += 1
      child.exitCode = null
      child.signalCode = 'SIGTERM'
      finish()
    }
    // Play the scripted stdout shortly after spawn, like a real runner would.
    setTimeout(() => {
      for (const line of script) child.stdout.write(`${line}\n`)
      if (!terminated) {
        state.naturalExit = true
        finish()
      }
    }, 5).unref?.()
    return { child: child as unknown as ChildProcess, terminate, release: () => {} }
  }
  spawner.executionEnvironment = 'test-double'
  return {
    spawner,
    launches,
    get terminateCalls(): number { return state.terminateCalls },
    /** True when the scripted run closed on its own before any termination. */
    get naturalExit(): boolean { return state.naturalExit },
  }
}

async function collect(backend: OpencodeBackend, request: ChatRequest): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = []
  for await (const delta of backend.chat(request, null, new AbortController().signal)) deltas.push(delta)
  return deltas
}

const FLAG = 'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX'

describe('opencode resolves an explicit output cap', () => {
  it('passes a valid request value to the runner flag', () => {
    const resolved = resolveOpencodeOutputTokenCap({ max_tokens: 16384 }, null)
    expect(resolved).toEqual({ cap: 16384, loweredBy: [] })
  })

  it('returns null for an uncapped request', () => {
    expect(resolveOpencodeOutputTokenCap({}, null)).toBeNull()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses max_tokens %s before spawn', (value) => {
    expect(() => resolveOpencodeOutputTokenCap({ max_tokens: value }, null)).toThrowError(
      /positive integer.*silently ignored/s,
    )
  })

  it('preserves a lower agent_profile.model.maxTotalOutputTokens and rejects an invalid one', () => {
    expect(resolveOpencodeOutputTokenCap({ max_tokens: 16384 }, { model: { maxTotalOutputTokens: 4096 } }))
      .toEqual({ cap: 4096, loweredBy: ['agent_profile'] })
    expect(resolveOpencodeOutputTokenCap({ max_tokens: 2048 }, { model: { maxTotalOutputTokens: 4096 } }))
      .toEqual({ cap: 2048, loweredBy: [] })
    expect(() => resolveOpencodeOutputTokenCap({ max_tokens: 10 }, { model: { maxTotalOutputTokens: 0 } })).toThrowError(
      /maxTotalOutputTokens 0.*positive safe integer/s,
    )
  })

  it('preserves a lower operator flag from the environment', () => {
    const saved = process.env[FLAG]
    process.env[FLAG] = '4096'
    try {
      expect(resolveOpencodeOutputTokenCap({ max_tokens: 16384 }, null)).toEqual({ cap: 4096, loweredBy: ['operator'] })
      expect(resolveOpencodeOutputTokenCap({ max_tokens: 2048 }, null)).toEqual({ cap: 2048, loweredBy: [] })
    } finally {
      if (saved === undefined) delete process.env[FLAG]
      else process.env[FLAG] = saved
    }
  })

  it('ignores an invalid operator flag exactly as the runner does', () => {
    const saved = process.env[FLAG]
    process.env[FLAG] = 'not-a-number'
    try {
      expect(resolveOpencodeOutputTokenCap({ max_tokens: 512 }, null)).toEqual({ cap: 512, loweredBy: [] })
    } finally {
      if (saved === undefined) delete process.env[FLAG]
      else process.env[FLAG] = saved
    }
  })

  it('refuses independent profile ceilings the runner cannot split', () => {
    expect(() => resolveOpencodeOutputTokenCap({ max_tokens: 512 }, { model: { maxVisibleOutputTokens: 256 } }))
      .toThrowError(/maxVisibleOutputTokens.*one total per-call output cap/s)
    expect(() => resolveOpencodeOutputTokenCap({ max_tokens: 512 }, { model: { maxReasoningTokens: 64 } }))
      .toThrowError(/maxReasoningTokens.*one total per-call output cap/s)
  })
})

describe('opencode caps a native run through the runner flag', () => {
  it('launches a capped turn with the flag and a pinned title, and cuts the run when receipts pass the cap', async () => {
    const cwd = workspace()
    const script = [
      JSON.stringify({ type: 'session.started', sessionID: 'ses_cap_1' }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_cap_1', part: { type: 'step_finish', reason: 'tool-calls', tokens: { input: 10, output: 200 } } }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_cap_1', part: { type: 'step_finish', reason: 'tool-calls', tokens: { input: 12, output: 150 } } }),
    ]
    const recorder = recordingSpawner(script)
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: recorder.spawner })

    const deltas = await collect(backend, {
      model: 'opencode/zai-coding-plan/glm-5.3',
      messages: [{ role: 'user', content: 'answer within the budget' }],
      cwd,
      max_tokens: 320,
    })

    expect(recorder.launches).toHaveLength(1)
    const launch = recorder.launches[0]!
    expect(launch.env[FLAG]).toBe('320')
    const titleIndex = launch.args.indexOf('--title')
    expect(titleIndex).toBeGreaterThan(-1)
    expect(launch.args[titleIndex + 1]).toBe('cli-bridge')

    const usage = deltas.filter((delta) => delta.usage?.model_call === true)
    expect(usage).toHaveLength(2)
    // 200 + 150 = 350 > 320: the turn ends truncated, not stopped.
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'length', internal_session_id: 'ses_cap_1' })
    expect(recorder.terminateCalls).toBe(1)
  })

  it('ends a turn length when the provider stopped the completion at the cap', async () => {
    const cwd = workspace()
    const script = [
      JSON.stringify({ type: 'session.started', sessionID: 'ses_cap_2' }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_cap_2', part: { type: 'text', text: 'partial answer' } }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_cap_2', part: { type: 'step_finish', reason: 'length', tokens: { input: 10, output: 40 } } }),
    ]
    const recorder = recordingSpawner(script)
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: recorder.spawner })

    const deltas = await collect(backend, {
      model: 'opencode/zai-coding-plan/glm-5.3',
      messages: [{ role: 'user', content: 'answer' }],
      cwd,
      max_tokens: 320,
    })

    expect(deltas.some((delta) => delta.content === 'partial answer')).toBe(true)
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'length', internal_session_id: 'ses_cap_2' })
    // The receipt stayed under the cap: the runner closed on its own.
    expect(recorder.naturalExit).toBe(true)
  })

  it('keeps an uncapped turn on today\'s launch: no flag, no pinned title, stop finish', async () => {
    const cwd = workspace()
    const script = [
      JSON.stringify({ type: 'session.started', sessionID: 'ses_uncapped' }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_uncapped', part: { type: 'text', text: 'full answer' } }),
      JSON.stringify({ type: 'message.updated', sessionID: 'ses_uncapped', part: { type: 'step_finish', reason: 'stop', tokens: { input: 10, output: 120000 } } }),
    ]
    const recorder = recordingSpawner(script)
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: recorder.spawner })

    const saved = process.env[FLAG]
    delete process.env[FLAG]
    let deltas: ChatDelta[]
    try {
      deltas = await collect(backend, {
        model: 'opencode/zai-coding-plan/glm-5.3',
        messages: [{ role: 'user', content: 'answer' }],
        cwd,
      })
    } finally {
      if (saved !== undefined) process.env[FLAG] = saved
    }

    const launch = recorder.launches[0]!
    expect(launch.env[FLAG]).toBeUndefined()
    expect(launch.args).not.toContain('--title')
    // No cap: a 120000-token step completes as a normal stop, exactly as before.
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'stop' })
  })

  it('refuses a request value the runner would ignore, before anything spawns', async () => {
    const cwd = workspace()
    const recorder = recordingSpawner()
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: recorder.spawner })

    await expect(async () => {
      for await (const _ of backend.chat({
        model: 'opencode/zai-coding-plan/glm-5.3',
        messages: [{ role: 'user', content: 'do the task' }],
        cwd,
        max_tokens: 1.5,
      }, null, new AbortController().signal)) void _
    }).rejects.toMatchObject({
      name: 'BackendError',
      code: 'parse_error',
      providerDispatch: 'not_started',
    })

    expect(recorder.launches).toHaveLength(0)
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
        child: child as unknown as ChildProcess,
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
