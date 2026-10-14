/**
 * A CLI killed by a signal never reports how its turn ended. Every stream reader
 * used to skip a `null` exit status beside `0`, so a killed process finished as
 * `stop`. Measured 2026-10-14 in a Braid proof run: a 23-minute Claude Code turn
 * ended on an unanswered tool_use with no `result` event, the bridge reported a
 * clean stop, and Braid recorded the run as completed.
 *
 * Each backend below streams part of a turn, then its process dies by SIGKILL.
 * The turn must fail and name the signal, never finish as a success.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import { CodexBackend } from '../src/backends/codex.js'
import { FactoryBackend } from '../src/backends/factory.js'
import { GeminiBackend } from '../src/backends/gemini.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { PiBackend } from '../src/backends/pi.js'
import { BackendError, type Backend, type ChatDelta } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { testPiInferenceTransport } from './pi-inference-fixture.js'

/**
 * How a child ends. `drain-first` is the order the Braid run hit: stdout drains,
 * the reader finishes, then the reaped process reports `exitCode: null`.
 * `close-first` reports the death before the reader has finished draining.
 */
interface Ending {
  code: number | null
  signal: NodeJS.Signals | null
  order: 'drain-first' | 'close-first'
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private ended = false

  /** End the way Node reports it: `exitCode` stays null after a signal death. */
  end({ code, signal, order }: Ending): void {
    if (this.ended) return
    this.ended = true
    this.stdout.end()
    this.stderr.end()
    const reap = (): void => {
      this.exitCode = code
      this.signalCode = signal
      this.emit('exit', code, signal)
      this.emit('close', code, signal)
    }
    if (order === 'close-first') reap()
    else setTimeout(reap, 10)
  }
}

/** Streams `lines`, then ends the child with `ending`; `terminate` kills it with SIGTERM. */
function endingSpawner(lines: string[], ending: Ending | 'never'): Spawner {
  const spawner: Spawner = async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${line}\n`)
      if (ending !== 'never') setTimeout(() => child.end(ending), 10)
    })
    return {
      child: child as never,
      terminate: async () => { child.end({ code: null, signal: 'SIGTERM', order: 'drain-first' }) },
      release() {},
      spawnError: () => null,
    }
  }
  spawner.executionEnvironment = 'test-double'
  return spawner
}

const KILLED: Ending = { code: null, signal: 'SIGKILL', order: 'drain-first' }
const line = (value: Record<string, unknown>): string => JSON.stringify(value)

/** Each backend's own partial turn: output it would stream before its terminal event. */
const cases: Array<{ name: string; model: string; lines: string[]; make: (spawner: Spawner) => Backend }> = [
  {
    name: 'claude',
    model: 'claude-code/anthropic/sonnet',
    lines: [
      line({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } }] },
      }),
    ],
    make: (spawner) => new ClaudeBackend({ bin: 'claude', harness: 'claude-code', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'codex',
    model: 'codex/gpt-5',
    lines: [
      line({ type: 'thread.started', thread_id: 'codex-thread' }),
      line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'partial' } }),
    ],
    make: (spawner) => new CodexBackend({ bin: 'codex', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'opencode',
    model: 'opencode/test/model',
    lines: [line({ type: 'message', text: 'partial' })],
    make: (spawner) => new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    lines: [line({ role: 'assistant', content: [{ type: 'text', text: 'partial' }] })],
    make: (spawner) => new KimiBackend({ bin: 'kimi', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'gemini',
    model: 'gemini/gemini-2.5-pro',
    lines: ['partial'],
    make: (spawner) => new GeminiBackend({ bin: 'gemini', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'factory',
    model: 'factory',
    lines: [line({ type: 'message', role: 'assistant', text: 'partial' })],
    make: (spawner) => new FactoryBackend({ bin: 'droid', timeoutMs: 5_000, spawner }),
  },
  {
    name: 'pi',
    model: 'pi/openai/gpt-5',
    lines: [
      line({ type: 'session', id: 'pi-session' }),
      line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }),
    ],
    make: (spawner) => new PiBackend({
      bin: 'pi',
      timeoutMs: 5_000,
      spawner,
      transportResolver: testPiInferenceTransport(),
    }),
  },
]

async function run(backend: Backend, model: string): Promise<{ deltas: ChatDelta[]; error: unknown }> {
  const deltas: ChatDelta[] = []
  const signal = new AbortController().signal
  try {
    for await (const delta of backend.chat({ model, messages: [{ role: 'user', content: 'work' }] }, null, signal)) {
      deltas.push(delta)
    }
    return { deltas, error: undefined }
  } catch (error) {
    return { deltas, error }
  }
}

const successfulFinish = (deltas: ChatDelta[]): boolean =>
  deltas.some((delta) => delta.finish_reason === 'stop' || delta.finish_reason === 'tool_calls')

describe('a CLI killed by a signal before its terminal event', () => {
  for (const { name, model, lines, make } of cases) {
    it(`${name} fails the turn and names the signal instead of finishing as a success`, async () => {
      const { deltas, error } = await run(make(endingSpawner(lines, KILLED)), model)

      expect(error).toBeInstanceOf(BackendError)
      expect((error as Error).message).toContain('SIGKILL')
      expect(successfulFinish(deltas)).toBe(false)
    })
  }
})

describe('claude turn endings without a result event', () => {
  const claude = cases.find((entry) => entry.name === 'claude')!

  it('fails a turn whose death is reported before the reader finishes draining', async () => {
    const ending: Ending = { ...KILLED, order: 'close-first' }
    const { deltas, error } = await run(claude.make(endingSpawner(claude.lines, ending)), claude.model)

    expect(error).toBeInstanceOf(BackendError)
    expect((error as Error).message).toContain('claude was killed by SIGKILL')
    expect(successfulFinish(deltas)).toBe(false)
  })

  it('fails a turn that exits 0 without a result event', async () => {
    const ending: Ending = { code: 0, signal: null, order: 'drain-first' }
    const { deltas, error } = await run(claude.make(endingSpawner(claude.lines, ending)), claude.model)

    expect(error).toBeInstanceOf(BackendError)
    expect((error as Error).message).toContain('claude exited 0 without its result event')
    expect(deltas[0]).toEqual({ internal_session_id: 'claude-session' })
    expect(successfulFinish(deltas)).toBe(false)
  })

  it('still finishes an aborted turn with finish_reason error after its process dies by SIGTERM', async () => {
    const controller = new AbortController()
    const backend = claude.make(endingSpawner(claude.lines, 'never'))
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(
      { model: claude.model, messages: [{ role: 'user', content: 'work' }] },
      null,
      controller.signal,
    )) {
      deltas.push(delta)
      if (delta.tool_calls) controller.abort()
    }

    expect(deltas.at(-1)).toEqual({ finish_reason: 'error', internal_session_id: 'claude-session' })
    expect(successfulFinish(deltas)).toBe(false)
  })
})
