import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { CodexBackend } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

function codexSpawner(lines: Array<Record<string, unknown>>): Spawner {
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
    model: 'codex',
    messages: [{ role: 'user', content: 'do the thing' }],
    mode: 'byob',
  } as ChatRequest
}

// Event lines captured from a real `codex exec --json` run; the tool-call
// items exercise every branch of extractToolCall.
const THREAD = { type: 'thread.started', thread_id: '019f3889-c05e-70c3-ae9f-3077da9454c4' }
const COMMAND_ITEM = {
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'command_execution',
    command: "/bin/bash -lc 'echo bridge-probe-42'",
    aggregated_output: 'bridge-probe-42\n',
    exit_code: 0,
    status: 'completed',
  },
}
const MCP_ITEM = {
  type: 'item.completed',
  item: {
    id: 'item_2',
    type: 'mcp_tool_call',
    server: 'tangle-search',
    tool: 'web_search',
    arguments: { query: 'vercel ai sdk v5 streamText' },
    status: 'completed',
  },
}
const WEBSEARCH_ITEM = {
  type: 'item.completed',
  item: { id: 'item_3', type: 'web_search', query: 'hono v4 middleware' },
}
const MESSAGE_ITEM = {
  type: 'item.completed',
  item: { id: 'item_4', type: 'agent_message', text: 'done' },
}
const TURN_DONE = {
  type: 'turn.completed',
  usage: { input_tokens: 45929, output_tokens: 103 },
}

describe('CodexBackend tool-call translation', () => {
  it('surfaces command/mcp/web_search items as tool_calls deltas', async () => {
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, COMMAND_ITEM, MCP_ITEM, WEBSEARCH_ITEM, MESSAGE_ITEM, TURN_DONE]),
    })
    const deltas = await collect(backend.chat(request(), null, new AbortController().signal))

    const toolCalls = deltas.flatMap((d) => d.tool_calls ?? [])
    expect(toolCalls.map((t) => t.name)).toEqual(['bash', 'tangle-search_web_search', 'websearch'])
    expect(JSON.parse(toolCalls[0]!.arguments)).toEqual({ command: "/bin/bash -lc 'echo bridge-probe-42'" })
    expect(JSON.parse(toolCalls[1]!.arguments)).toEqual({ query: 'vercel ai sdk v5 streamText' })
    expect(toolCalls.map((t) => t.id)).toEqual(['item_1', 'item_2', 'item_3'])

    const finish = deltas.find((d) => d.finish_reason)
    expect(finish?.finish_reason).toBe('tool_calls')
    expect(finish?.usage).toEqual({ input_tokens: 45929, output_tokens: 103 })

    // Assistant text still flows.
    expect(deltas.some((d) => d.content === 'done')).toBe(true)
  })

  it('reports finish_reason stop when no tool item appears', async () => {
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE]),
    })
    const deltas = await collect(backend.chat(request(), null, new AbortController().signal))
    expect(deltas.flatMap((d) => d.tool_calls ?? [])).toEqual([])
    expect(deltas.find((d) => d.finish_reason)?.finish_reason).toBe('stop')
  })

  it('never emits a tool call for non-tool items', async () => {
    const reasoning = { type: 'item.completed', item: { id: 'item_9', type: 'reasoning', text: 'thinking' } }
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, reasoning, TURN_DONE]),
    })
    const deltas = await collect(backend.chat(request(), null, new AbortController().signal))
    expect(deltas.flatMap((d) => d.tool_calls ?? [])).toEqual([])
    // Reasoning text still surfaces through the permissive extractor.
    expect(deltas.some((d) => d.content === 'thinking')).toBe(true)
  })
})
