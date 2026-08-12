/**
 * SSE writer contract: ChatDelta.keepalive must surface as an SSE
 * comment (RFC: lines starting with `:` are dropped by every conforming
 * client) and MUST NOT appear in the OpenAI-visible delta stream.
 *
 * This guards against a regression class we hit in production: backends
 * synthesizing fake `tool_calls` to signal subprocess liveness, which
 * strict consumers (Vercel AI SDK in particular) reject because the
 * synthetic name isn't in the caller's tools registry.
 */
import { describe, expect, it } from 'vitest'
import type { ChatDelta } from '../src/backends/types.js'
import {
  collectNonStreaming,
  deltaToOpenAIChunk,
  deltaToSseComment,
  makeChunkMeta,
} from '../src/streaming/sse.js'

describe('deltaToSseComment', () => {
  it('renders keepalive deltas as SSE comments with source + elapsedMs', () => {
    const out = deltaToSseComment({ keepalive: { source: 'kimi', elapsedMs: 30000 } })
    expect(out).toBe(': keepalive source=kimi elapsed=30000\n\n')
  })

  it('returns null for non-keepalive deltas', () => {
    expect(deltaToSseComment({ content: 'hello' })).toBeNull()
    expect(deltaToSseComment({ tool_calls: [{ id: 'a', name: 'b', arguments: '{}' }] })).toBeNull()
    expect(deltaToSseComment({ finish_reason: 'stop' })).toBeNull()
  })
})

describe('deltaToOpenAIChunk', () => {
  const meta = makeChunkMeta('test-model')

  it('returns null for pure keepalive deltas so they never reach the OpenAI wire', () => {
    expect(deltaToOpenAIChunk({ keepalive: { source: 'kimi', elapsedMs: 30000 } }, meta)).toBeNull()
  })

  it('returns null for metadata-only deltas (internal_session_id) — bridge bookkeeping, not OpenAI surface', () => {
    expect(deltaToOpenAIChunk({ internal_session_id: 'sess-1' }, meta)).toBeNull()
  })

  it('emits a chat.completion.chunk for content deltas', () => {
    const out = deltaToOpenAIChunk({ content: 'hi' }, meta)
    expect(out).not.toBeNull()
    expect(out).toMatch(/^data: /)
    const payload = JSON.parse(out!.slice('data: '.length).replace(/\n\n$/, ''))
    expect(payload.choices[0].delta.content).toBe('hi')
  })

  it('emits a chat.completion.chunk for tool_calls deltas', () => {
    const out = deltaToOpenAIChunk(
      { tool_calls: [{ id: 'a', name: 'lookup', arguments: '{"q":"x"}' }] },
      meta,
    )
    expect(out).not.toBeNull()
    const payload = JSON.parse(out!.slice('data: '.length).replace(/\n\n$/, ''))
    expect(payload.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: 'a',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"x"}' },
    })
  })

  it('emits a usage-only delta as an OpenAI usage trailer (choices: []), preserving the estimated flag', () => {
    const out = deltaToOpenAIChunk({ usage: { input_tokens: 100, output_tokens: 13, estimated: true } }, meta)
    expect(out).not.toBeNull()
    const payload = JSON.parse(out!.slice('data: '.length).replace(/\n\n$/, ''))
    // Must be an empty choices array, NOT a fake empty choice, or strict clients
    // misparse the trailer as assistant output.
    expect(payload.choices).toEqual([])
    expect(payload.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 13,
      total_tokens: 113,
      cost_known: false,
      estimated: true,
    })
  })

  it('uses the observed provider identity and preserves its fingerprint', () => {
    const out = deltaToOpenAIChunk({
      model: 'deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402',
      system_fingerprint: 'fp_a18b46594c_prod0820_fp8_kvcache_20260402',
      content: 'identified',
    }, meta)
    const payload = JSON.parse(out!.slice('data: '.length).replace(/\n\n$/, ''))
    expect(payload.model).toBe('deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402')
    expect(payload.system_fingerprint).toBe('fp_a18b46594c_prod0820_fp8_kvcache_20260402')
  })
})

describe('collectNonStreaming', () => {
  it('strips keepalive deltas from the non-streaming response body', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield { keepalive: { source: 'kimi', elapsedMs: 30000 } }
      yield { content: 'hello ' }
      yield { keepalive: { source: 'kimi', elapsedMs: 60000 } }
      yield { content: 'world' }
      yield { finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 2 } }
    }
    const body = (await collectNonStreaming(deltas(), 'test')) as {
      choices: Array<{ message: { content: string; tool_calls?: unknown[] } }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.choices[0]?.message.content).toBe('hello world')
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
    expect(body.usage?.prompt_tokens).toBe(3)
    expect(body.usage?.completion_tokens).toBe(2)
  })

  it('returns the observed provider identity instead of the requested model', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield {
        model: 'deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402',
        system_fingerprint: 'fp_a18b46594c_prod0820_fp8_kvcache_20260402',
        content: 'identified',
      }
      yield { finish_reason: 'stop' }
    }
    const body = await collectNonStreaming(deltas(), 'deepseek-v4-flash') as {
      model: string
      system_fingerprint?: string
    }
    expect(body.model).toBe('deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402')
    expect(body.system_fingerprint).toBe('fp_a18b46594c_prod0820_fp8_kvcache_20260402')
  })

  it('sums incremental usage records and a complete aggregate cost', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield { usage: { input_tokens: 100, output_tokens: 20 } }
      yield { usage: { input_tokens: 240, output_tokens: 35 } }
      yield {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost: 0.005,
          cost_known: true,
          cost_provenance: 'provider-receipt',
          cost_scope: 'total',
        },
      }
      yield { finish_reason: 'stop' }
    }
    const body = (await collectNonStreaming(deltas(), 'test')) as {
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        cost?: number
      }
    }

    expect(body.usage).toEqual({
      prompt_tokens: 340,
      completion_tokens: 55,
      total_tokens: 395,
      cost: 0.005,
      cost_known: true,
      cost_provenance: 'provider-receipt',
      cost_scope: 'total',
    })
  })

  it('omits a partial cost when any incremental usage record lacks cost', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield { usage: { input_tokens: 100, output_tokens: 20, cost: 0.003 } }
      yield { usage: { input_tokens: 240, output_tokens: 35 } }
      yield { finish_reason: 'stop' }
    }

    const body = (await collectNonStreaming(deltas(), 'test')) as {
      usage?: Record<string, unknown>
    }

    expect(body.usage).toEqual({
      prompt_tokens: 340,
      completion_tokens: 55,
      total_tokens: 395,
      cost_known: false,
      cost_scope: 'total',
    })
  })

  it('preserves cache dimensions and leaves a mixed present/missing split unknown', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield {
        usage: {
          input_tokens: 110,
          fresh_input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_write_input_tokens: 0,
          output_tokens: 4,
        },
      }
      yield { usage: { input_tokens: 20, output_tokens: 2 } }
      yield { finish_reason: 'stop' }
    }

    const body = await collectNonStreaming(deltas(), 'test') as {
      usage?: Record<string, unknown>
    }
    expect(body.usage).toMatchObject({
      prompt_tokens: 130,
      completion_tokens: 6,
      total_tokens: 136,
      cost_known: false,
    })
    expect(body.usage).not.toHaveProperty('fresh_input_tokens')
    expect(body.usage).not.toHaveProperty('cache_read_input_tokens')
    expect(body.usage).not.toHaveProperty('cache_write_input_tokens')
  })

  it('does not let a cost-only trailer make later complete token counts unknown', async () => {
    async function* deltas(): AsyncIterable<ChatDelta> {
      yield {
        usage: {
          cost: 0.005,
          cost_known: true,
          cost_provenance: 'provider-receipt',
          cost_scope: 'total',
        },
      }
      yield {
        usage: {
          input_tokens: 110,
          fresh_input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_write_input_tokens: 0,
          output_tokens: 4,
        },
      }
      yield { finish_reason: 'stop' }
    }

    const body = await collectNonStreaming(deltas(), 'test') as {
      usage?: Record<string, unknown>
    }
    expect(body.usage).toMatchObject({
      prompt_tokens: 110,
      fresh_input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_write_input_tokens: 0,
      completion_tokens: 4,
      total_tokens: 114,
      cost_known: false,
    })
  })

  it('keeps catalog dollars separate from a trusted provider receipt on the stream wire', () => {
    const catalog = deltaToOpenAIChunk({
      usage: {
        estimated_cost: 0,
        cost_known: false,
        cost_provenance: 'catalog-estimate',
        cost_scope: 'total',
      },
    }, makeChunkMeta('pi/tangle-router/deepseek-v4-flash'))
    const provider = deltaToOpenAIChunk({
      usage: {
        cost: 0.03,
        cost_known: true,
        cost_provenance: 'provider-receipt',
        cost_scope: 'total',
      },
    }, makeChunkMeta('trusted/model'))
    const catalogUsage = JSON.parse(catalog!.slice(6)).usage as Record<string, unknown>
    const providerUsage = JSON.parse(provider!.slice(6)).usage as Record<string, unknown>

    expect(catalogUsage).toMatchObject({
      estimated_cost: 0,
      cost_known: false,
      cost_provenance: 'catalog-estimate',
    })
    expect(catalogUsage).not.toHaveProperty('cost')
    expect(providerUsage).toMatchObject({
      cost: 0.03,
      cost_known: true,
      cost_provenance: 'provider-receipt',
    })
  })
})
