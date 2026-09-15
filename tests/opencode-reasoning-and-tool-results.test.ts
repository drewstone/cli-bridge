import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { deltaToOpenAIChunk, makeChunkMeta } from '../src/streaming/sse.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
}

function streamingSpawner(lines: Array<Record<string, unknown>>, seen: string[][]): Spawner {
  return async (_bin, args): Promise<SpawnResult> => {
    seen.push([...args])
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
    return { child: child as never, release() {}, spawnError: () => null }
  }
}

// The exact shapes `opencode run --format json --thinking` prints (opencode 1.18.30, run.ts):
// every event is `{ type, timestamp, sessionID, part }`, a tool part is printed only once its
// state is completed or error, and a reasoning part is printed only under `--thinking`.
const SESSION = 'ses_probe'
const EVENTS: Array<Record<string, unknown>> = [
  { type: 'step_start', timestamp: 1, sessionID: SESSION, part: { type: 'step-start', sessionID: SESSION } },
  {
    type: 'reasoning',
    timestamp: 2,
    sessionID: SESSION,
    part: { type: 'reasoning', sessionID: SESSION, text: 'The user wants the file; read it first.', time: { start: 1, end: 2 } },
  },
  {
    type: 'tool_use',
    timestamp: 3,
    sessionID: SESSION,
    part: {
      type: 'tool',
      sessionID: SESSION,
      id: 'prt_read1',
      callID: 'call_read1',
      tool: 'read',
      state: { status: 'completed', input: { filePath: '/tmp/probe.txt' }, output: 'PLATYPUS\n', title: '/tmp/probe.txt' },
    },
  },
  {
    type: 'tool_use',
    timestamp: 4,
    sessionID: SESSION,
    part: {
      type: 'tool',
      sessionID: SESSION,
      id: 'prt_bash1',
      callID: 'call_bash1',
      tool: 'bash',
      state: { status: 'error', input: { command: 'false' }, error: 'exit status 1' },
    },
  },
  { type: 'text', timestamp: 5, sessionID: SESSION, part: { type: 'text', sessionID: SESSION, text: 'The file says PLATYPUS.', time: { start: 4, end: 5 } } },
  {
    type: 'step_finish',
    timestamp: 6,
    sessionID: SESSION,
    part: { type: 'step-finish', sessionID: SESSION, tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 0, write: 0 } }, cost: 0 },
  },
]

async function drain(): Promise<{ deltas: ChatDelta[]; args: string[][] }> {
  const args: string[][] = []
  const backend = new OpencodeBackend({
    bin: 'opencode',
    timeoutMs: 0,
    spawner: streamingSpawner(EVENTS, args),
  } as unknown as ConstructorParameters<typeof OpencodeBackend>[0])
  const request = {
    model: 'opencode/zai-coding-plan/glm-5.3',
    messages: [{ role: 'user', content: 'read the probe file' }],
  } as unknown as ChatRequest
  const deltas: ChatDelta[] = []
  for await (const delta of backend.chat(request, null, new AbortController().signal)) deltas.push(delta)
  return { deltas, args }
}

describe('opencode reasoning and tool results reach the wire (cli-bridge#227)', () => {
  it('spawns opencode with --thinking, because the JSON printer drops reasoning without it', async () => {
    const { args } = await drain()
    const argv = args[0] ?? []
    expect(argv).toContain('--thinking')
    expect(argv.slice(0, 3)).toEqual(['run', '--format', 'json'])
  })

  it('forwards a reasoning part as delta.reasoning and never as content', async () => {
    const { deltas } = await drain()
    expect(deltas.map((d) => d.reasoning).filter(Boolean)).toEqual(['The user wants the file; read it first.'])
    const content = deltas.map((d) => d.content ?? '').join('')
    expect(content).toBe('The file says PLATYPUS.')
    expect(content).not.toContain('read it first')
  })

  it('forwards each finished tool part as a tool_result keyed like its tool_call', async () => {
    const { deltas } = await drain()
    const calls = deltas.flatMap((d) => d.tool_calls ?? [])
    const results = deltas.flatMap((d) => d.tool_results ?? [])
    expect(calls.map((c) => c.id)).toEqual(['prt_read1', 'prt_bash1'])
    expect(results).toEqual([
      { id: 'prt_read1', name: 'read', status: 'completed', output: 'PLATYPUS\n' },
      { id: 'prt_bash1', name: 'bash', status: 'error', error: 'exit status 1' },
    ])
  })

  it('serializes tool_results beside tool_calls on the OpenAI-shaped chunk', () => {
    const out = deltaToOpenAIChunk(
      {
        tool_calls: [{ id: 'prt_read1', name: 'read', arguments: '{"filePath":"/tmp/probe.txt"}' }],
        tool_results: [{ id: 'prt_read1', name: 'read', status: 'completed', output: 'PLATYPUS\n' }],
      },
      makeChunkMeta('opencode'),
    )
    expect(out).not.toBeNull()
    const payload = JSON.parse(out!.replace(/^data: /u, '')) as { choices: Array<{ delta: Record<string, unknown> }> }
    expect(payload.choices[0]?.delta.tool_results).toEqual([
      { id: 'prt_read1', name: 'read', status: 'completed', output: 'PLATYPUS\n' },
    ])
    expect(payload.choices[0]?.delta.tool_calls).toHaveLength(1)
  })

  it('a tool_results-only delta is a real chunk, not metadata', () => {
    const out = deltaToOpenAIChunk(
      { tool_results: [{ id: 'prt_bash1', name: 'bash', status: 'error', error: 'exit status 1' }] },
      makeChunkMeta('opencode'),
    )
    expect(out).not.toBeNull()
    const payload = JSON.parse(out!.replace(/^data: /u, '')) as { choices: unknown[] }
    expect(payload.choices).toHaveLength(1)
  })
})
