import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { PiBackend } from '../src/backends/pi.js'
import type { ChatDelta } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

function piSpawner(lines: Array<Record<string, unknown>>): Spawner {
  return async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 0
        child.emit('close', 0)
      }, 10)
    })
    return {
      child: child as never,
      release() {},
      spawnError: () => null,
    }
  }
}

async function collect(deltas: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const delta of deltas) out.push(delta)
  return out
}

describe('PiBackend', () => {
  it('emits only text deltas and preserves final usage from turn_end.message.usage', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-1' },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            delta: 'hidden reasoning must not become assistant text',
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'pi' },
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '-ok' },
        },
        {
          type: 'turn_end',
          message: {
            usage: {
              input: 8417,
              output: 30,
            },
          },
        },
        { type: 'agent_end' },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/moonshot/kimi-k2.6',
      messages: [{ role: 'user', content: 'Reply with exactly: pi-ok' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { internal_session_id: 'pi-session-1' },
      { content: 'pi' },
      { content: '-ok' },
      { finish_reason: 'stop', usage: { input_tokens: 8417, output_tokens: 30 } },
    ])
  })

  it('throws on an empty exit-0 stream instead of a phantom finish_reason:stop', async () => {
    // Some provider/model paths (moonshot/kimi-k2-thinking, gemini-3-pro-preview)
    // return a 0-byte stream with exit 0. Treated as finish_reason:'stop' that is
    // a phantom empty success; it must surface as a typed upstream error so the
    // consumer retries / scores it honestly. (The #3 cli-bridge benchmark error.)
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([]), // exit 0, ZERO events emitted
    })
    await expect(collect(backend.chat({
      model: 'pi/moonshot/kimi-k2-thinking',
      messages: [{ role: 'user', content: 'x' }],
    }, null, new AbortController().signal))).rejects.toThrow(/no output|empty upstream/i)
  })

  it('a tool-only turn (events but no assistant text) is NOT treated as empty', async () => {
    // Guard the guard: an agent that only ran tools still emits session + turn_end
    // events, so sawAnyEvent is true and the turn completes normally (no false error).
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-tool-1' },
        { type: 'turn_end', message: { usage: { input: 3, output: 0 } } },
        { type: 'agent_end' },
      ]),
    })
    const deltas = await collect(backend.chat({
      model: 'pi/deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
    }, null, new AbortController().signal))
    expect(deltas.at(-1)).toEqual({ finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 0 } })
  })

  it('also accepts prompt_tokens/completion_tokens usage from partial.usage', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'done' },
        },
        {
          type: 'turn_end',
          partial: {
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
            },
          },
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/moonshot/kimi-k2.6',
      messages: [{ role: 'user', content: 'x' }],
    }, null, new AbortController().signal))

    expect(deltas.at(-1)).toEqual({
      finish_reason: 'stop',
      usage: { input_tokens: 11, output_tokens: 7 },
    })
  })
})
