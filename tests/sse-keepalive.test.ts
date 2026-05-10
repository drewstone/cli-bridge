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
})
