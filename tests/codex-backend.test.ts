import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { CodexBackend, splitCodexModel } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

function codexSpawner(
  lines: Array<Record<string, unknown>>,
  observed?: { args?: string[] },
): Spawner {
  return async (_bin, args): Promise<SpawnResult> => {
    if (observed) observed.args = [...args]
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

describe('CodexBackend model translation', () => {
  // The canonical wire id is `codex/<provider>/<model>` (agent-runtime's
  // profileBridgeWireModel). Passing the provider-qualified remainder
  // verbatim as `-c model=` was rejected by the API as a nonexistent model
  // ("The 'openai/codex' model is not supported"), killing every
  // profile-declared codex lead under supervise.
  it('splits the wire provider segment into model_provider + model config', async () => {
    const observed: { args?: string[] } = {}
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed),
    })
    await collect(backend.chat(
      { ...request(), model: 'codex/openai/gpt-5.1-codex' },
      null,
      new AbortController().signal,
    ))
    expect(observed.args).toContain('model_provider="openai"')
    expect(observed.args).toContain('model="gpt-5.1-codex"')
  })

  it('leaves a bare model remainder on the account default provider', async () => {
    const observed: { args?: string[] } = {}
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed),
    })
    await collect(backend.chat(
      { ...request(), model: 'codex/gpt-5.1-codex' },
      null,
      new AbortController().signal,
    ))
    expect(observed.args!.some((a) => a.startsWith('model_provider='))).toBe(false)
    expect(observed.args).toContain('model="gpt-5.1-codex"')
  })

  it('accepts an honest unqualified default route', async () => {
    const observed: { args?: string[] } = {}
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed),
    })

    await collect(backend.chat(
      {
        ...request(),
        model: 'codex/default',
        agent_profile: {
          harness: 'codex',
          model: { default: 'default' },
        },
      },
      null,
      new AbortController().signal,
    ))

    expect(observed.args!.some((arg) => arg.startsWith('model_provider='))).toBe(false)
    expect(observed.args!.some((arg) => arg.startsWith('model='))).toBe(false)
  })

  it('rejects a harness name presented as the model provider', async () => {
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], {}),
    })

    await expect(collect(backend.chat(
      {
        ...request(),
        model: 'codex/default',
        agent_profile: {
          harness: 'codex',
          model: { provider: 'codex', default: 'default' },
        },
      },
      null,
      new AbortController().signal,
    ))).rejects.toThrow(/conflicts with agent_profile\.model/u)
  })

  it('splitCodexModel covers the alias/bare/qualified shapes', () => {
    expect(splitCodexModel(null)).toEqual({ provider: null, model: null })
    expect(splitCodexModel('gpt-5.1-codex')).toEqual({ provider: null, model: 'gpt-5.1-codex' })
    expect(splitCodexModel('openai/gpt-5.1-codex')).toEqual({ provider: 'openai', model: 'gpt-5.1-codex' })
    // OSS models qualify with a colon, never a slash — the split must not eat them.
    expect(splitCodexModel('ollama/gpt-oss:20b')).toEqual({ provider: 'ollama', model: 'gpt-oss:20b' })
  })
})

describe('CodexBackend jailed MCP visibility', () => {
  it('registers the synthetic CODEX_HOME as a writable seed so a confined codex reads its MCP config', async () => {
    // The MCP stanzas live in the synthetic CODEX_HOME's config.toml. Under
    // an fs-jail that home must arrive INSIDE the jail (seed-writable, the
    // jail copies it to <root>/.codex and redirects CODEX_HOME) — the host
    // path itself is not mounted there.
    const jailSpec = {
      root: '/ws/.agent-home',
      projectDir: '/ws',
      readConfine: true,
    } as NonNullable<ChatRequest['jailSpec']>
    // The synthetic home is removed in chat()'s finally, so its config must
    // be captured while the subprocess is (fake-)running — exactly when the
    // real jail would seed it.
    let seededConfig: string | null = null
    const inner = codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE])
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: async (bin, args, opts) => {
        const source = (jailSpec.authSources ?? []).find((s) => s.envVar === 'CODEX_HOME')?.source
        if (source) seededConfig = readFileSync(join(source, 'config.toml'), 'utf8')
        return inner(bin, args, opts)
      },
    })
    await collect(backend.chat(
      {
        ...request(),
        mcp: { mcpServers: { coordination: { command: '/bin/true' } } },
        jailSpec,
      },
      null,
      new AbortController().signal,
    ))
    const codexSources = (jailSpec.authSources ?? []).filter((s) => s.envVar === 'CODEX_HOME')
    expect(codexSources).toHaveLength(1)
    expect(codexSources[0]).toMatchObject({ jailRel: '.codex', mode: 'seed-writable' })
    expect(seededConfig).toContain('[mcp_servers.coordination]')
    expect(seededConfig).toContain('command = "/bin/true"')
  })
})
