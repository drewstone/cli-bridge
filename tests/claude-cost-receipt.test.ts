import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { deltaToOpenAIChunk, makeChunkMeta } from '../src/streaming/sse.js'
import { addUsage } from '../src/usage.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
}

function claudeSpawner(lines: Array<Record<string, unknown>>): Spawner {
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
  for await (const d of deltas) out.push(d)
  return out
}

function request(): ChatRequest {
  return {
    model: 'claude-code/anthropic/sonnet',
    messages: [{ role: 'user', content: 'do the thing' }],
    mode: 'byob',
  } as ChatRequest
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1' }
const ASSISTANT = {
  type: 'assistant',
  message: { id: 'msg-1', content: [{ type: 'text', text: 'done' }] },
}

function chatWith(lines: Array<Record<string, unknown>>): AsyncIterable<ChatDelta> {
  const backend = new ClaudeBackend({
    bin: 'claude',
    harness: 'claude-code',
    timeoutMs: 5_000,
    spawner: claudeSpawner(lines),
  })
  return backend.chat(request(), null, new AbortController().signal)
}

describe('claude dollar receipt', () => {
  it('normalizes Claude Code cache classes into a complete provider receipt', async () => {
    const deltas = await collect(
      chatWith([
        INIT,
        ASSISTANT,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 10_753,
            cache_read_input_tokens: 15_269,
            output_tokens: 4,
          },
          total_cost_usd: 0.0470478,
        },
      ]),
    )

    const final = deltas.at(-1)
    expect(final?.usage).toEqual({
      input_tokens: 26_024,
      fresh_input_tokens: 2,
      cache_read_input_tokens: 15_269,
      cache_write_input_tokens: 10_753,
      output_tokens: 4,
      cost: 0.0470478,
      cost_known: true,
      cost_provenance: 'provider-receipt',
      cost_scope: 'total',
    })
  })

  it('reports an unknown dollar cost when the run declares no total_cost_usd', async () => {
    const deltas = await collect(
      chatWith([
        INIT,
        ASSISTANT,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          usage: { input_tokens: 90, output_tokens: 12 },
        },
      ]),
    )

    const final = deltas.at(-1)
    expect(final?.usage).toEqual({
      fresh_input_tokens: 90,
      output_tokens: 12,
      cost_known: false,
    })
    expect(final?.usage?.cost).toBeUndefined()
  })

  it('does not turn omitted, invalid, or overflowing cache classes into a prompt total', async () => {
    const cases = [
      {
        usage: { input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 12 },
        expected: {
          fresh_input_tokens: 90,
          cache_write_input_tokens: 0,
          output_tokens: 12,
          cost_known: false,
        },
      },
      {
        usage: {
          input_tokens: 90,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: -1,
          output_tokens: 12,
        },
        expected: {
          fresh_input_tokens: 90,
          cache_write_input_tokens: 0,
          output_tokens: 12,
          cost_known: false,
        },
      },
      {
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1,
          output_tokens: 0,
        },
        expected: {
          fresh_input_tokens: Number.MAX_SAFE_INTEGER,
          cache_read_input_tokens: 1,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          cost_known: false,
        },
      },
    ]

    for (const { usage, expected } of cases) {
      const deltas = await collect(
        chatWith([
          INIT,
          ASSISTANT,
          { type: 'result', subtype: 'success', session_id: 'sess-1', usage },
        ]),
      )

      expect(deltas.at(-1)?.usage).toEqual(expected)
    }
  })

  it('refuses a negative or non-finite figure rather than billing it', async () => {
    for (const total_cost_usd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const deltas = await collect(
        chatWith([
          INIT,
          ASSISTANT,
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-1',
            usage: { input_tokens: 5, output_tokens: 5 },
            total_cost_usd,
          },
        ]),
      )
      const final = deltas.at(-1)
      expect(final?.usage?.cost_known).toBe(false)
      expect(final?.usage?.cost).toBeUndefined()
    }
  })

  it('puts the receipt on the wire with its provenance so a consumer may debit a budget', async () => {
    const deltas = await collect(
      chatWith([
        INIT,
        ASSISTANT,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          usage: {
            input_tokens: 1_200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 340,
          },
          total_cost_usd: 0.0412,
        },
      ]),
    )
    const final = deltas.at(-1)
    const chunk = deltaToOpenAIChunk(final as ChatDelta, makeChunkMeta('claude-code/anthropic/sonnet'))
    const wire = JSON.parse((chunk as string).replace(/^data: /, '')) as {
      usage: Record<string, unknown>
    }

    expect(wire.usage).toMatchObject({
      cost: 0.0412,
      cost_known: true,
      cost_provenance: 'provider-receipt',
      cost_scope: 'total',
    })

    const collected = addUsage(undefined, final!.usage!)
    expect(collected.cost).toBe(0.0412)
    expect(collected.costComplete).toBe(true)
    expect(collected.costProvenance).toBe('provider-receipt')
  })

  it('keeps a catalog estimate out of the receipt lane', () => {
    // The shape pi emits: no provider or proxy reports billed dollars, so the
    // dollar figure stays an estimate on the wire and in the collected total.
    const estimate: NonNullable<ChatDelta['usage']> = {
      estimated_cost: 0.005,
      cost_known: false,
      cost_provenance: 'catalog-estimate',
      cost_scope: 'total',
    }
    const chunk = deltaToOpenAIChunk({ usage: estimate }, makeChunkMeta('pi/gpt-5-mini'))
    const wire = JSON.parse((chunk as string).replace(/^data: /, '')) as {
      usage: Record<string, unknown>
    }

    expect(wire.usage.cost).toBeUndefined()
    expect(wire.usage.cost_known).toBe(false)
    expect(wire.usage.estimated_cost).toBe(0.005)
    expect(wire.usage.cost_provenance).toBe('catalog-estimate')

    const collected = addUsage(undefined, estimate)
    expect(collected.cost).toBe(0)
    expect(collected.costComplete).toBe(false)
    expect(collected.costProvenance).toBeUndefined()
    expect(collected.estimatedCost).toBe(0.005)
  })
})
