/**
 * SSE helpers — convert a stream of ChatDelta into OpenAI-shaped
 * chat.completion.chunk events, and write them to a Response body.
 *
 * Matches the shape OpenAI / LiteLLM / tangle-router clients expect:
 *   data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}
 *   data: [DONE]
 */

import type { ChatDelta } from '../backends/types.js'

export interface ChunkMeta {
  id: string
  model: string
  created: number
}

export function deltaToOpenAIChunk(delta: ChatDelta, meta: ChunkMeta): string {
  const choiceDelta: Record<string, unknown> = {}
  if (delta.content !== undefined) choiceDelta.content = delta.content
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    choiceDelta.tool_calls = delta.tool_calls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }

  const payload = {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta: choiceDelta,
        finish_reason: delta.finish_reason ?? null,
      },
    ],
    ...(delta.usage ? { usage: { prompt_tokens: delta.usage.input_tokens, completion_tokens: delta.usage.output_tokens } } : {}),
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function sseDone(): string {
  return 'data: [DONE]\n\n'
}

export function makeChunkMeta(model: string): ChunkMeta {
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model,
    created: Math.floor(Date.now() / 1000),
  }
}

/**
 * Collect a full delta stream into a single non-streaming chat completion
 * response (for clients that don't want SSE).
 */
export async function collectNonStreaming(
  iter: AsyncIterable<ChatDelta>,
  model: string,
): Promise<unknown> {
  let content = ''
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let finishReason: string | null = null
  let usage: ChatDelta['usage']

  for await (const d of iter) {
    if (d.content) content += d.content
    if (d.tool_calls) toolCalls.push(...d.tool_calls)
    if (d.finish_reason) finishReason = d.finish_reason
    if (d.usage) usage = d.usage
  }

  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          } : {}),
        },
        finish_reason: finishReason ?? 'stop',
      },
    ],
    ...(usage ? {
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      },
    } : {}),
  }
}
