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

/**
 * Convert a `ChatDelta` into an OpenAI-shaped chat.completion.chunk
 * `data: …` line. Returns `null` for deltas that carry only a
 * `keepalive` signal — those must be rendered as SSE comments by the
 * caller (see `deltaToSseComment`) so they don't appear in the
 * OpenAI-visible delta stream.
 */
export function deltaToOpenAIChunk(delta: ChatDelta, meta: ChunkMeta): string | null {
  const hasContent = delta.content !== undefined
  const hasToolCalls = !!delta.tool_calls && delta.tool_calls.length > 0
  const hasFinish = delta.finish_reason !== undefined
  const hasUsage = !!delta.usage
  const hasSessionId = !!delta.internal_session_id

  // Pure keepalive deltas don't go on the OpenAI wire — surface as SSE
  // comments via `deltaToSseComment` instead. `internal_session_id`-only
  // deltas are also non-OpenAI metadata (consumed by the session store)
  // and are intentionally skipped here.
  if (!hasContent && !hasToolCalls && !hasFinish && !hasUsage) {
    return null
  }
  // internal_session_id-only deltas: the session id is bookkeeping for
  // the bridge's own store, not OpenAI surface area. Skip to avoid
  // sending an empty `delta: {}` chunk which strict consumers (LiteLLM,
  // some agent harnesses) reject as malformed.
  if (hasSessionId && !hasContent && !hasToolCalls && !hasFinish && !hasUsage) {
    return null
  }

  const choiceDelta: Record<string, unknown> = {}
  if (hasContent) choiceDelta.content = delta.content
  if (hasToolCalls) {
    choiceDelta.tool_calls = delta.tool_calls!.map((tc, i) => ({
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

/**
 * Render a `keepalive` delta as a raw SSE comment (RFC: lines starting
 * with `:` are comments and silently dropped by every conforming SSE
 * client — OpenAI/AI SDK/LiteLLM included). Returns `null` for deltas
 * without a keepalive. The string includes the trailing `\n\n` framing.
 *
 * Comment lines also serve as transport heartbeats: they keep the TCP
 * connection alive across NAT/proxies and prevent client-side fetch
 * idle timeouts during long subprocess silences.
 */
export function deltaToSseComment(delta: ChatDelta): string | null {
  if (!delta.keepalive) return null
  const { source, elapsedMs } = delta.keepalive
  return `: keepalive source=${source} elapsed=${elapsedMs}\n\n`
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
    // Backend-liveness signals are transport-layer and have no place in
    // the non-streaming response body. Drop them silently.
    if (d.keepalive) continue
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
