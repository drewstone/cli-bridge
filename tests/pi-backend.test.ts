import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiBackend } from '../src/backends/pi.js'
import { BackendError } from '../src/backends/types.js'
import type { ChatDelta } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

function piSpawner(
  lines: Array<Record<string, unknown>>,
  onSpawn?: (...spawnArgs: Parameters<Spawner>) => void,
): Spawner {
  return async (...spawnArgs): Promise<SpawnResult> => {
    onSpawn?.(...spawnArgs)
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

  it('surfaces pi assistantMessageEvent tool_call_start as OpenAI tool_calls', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-tools-1' },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'tool_call_start',
            id: 'call_read_1',
            name: 'read',
            input: { path: 'src/lib.rs' },
            contentIndex: 0,
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'tool_call_args_delta',
            id: 'call_read_1',
            name: 'read',
            delta: '{"path":"src/lib.rs"}',
            contentIndex: 0,
          },
        },
        { type: 'turn_end', message: { usage: { input: 20, output: 8 } } },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/moonshot/kimi-k2.6',
      messages: [{ role: 'user', content: 'inspect the file' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { internal_session_id: 'pi-tools-1' },
      { tool_calls: [{ id: 'call_read_1', name: 'read', arguments: '{"path":"src/lib.rs"}' }] },
      { finish_reason: 'tool_calls', usage: { input_tokens: 20, output_tokens: 8 } },
    ])
  })

  it('surfaces real pi toolcall_end frames nested under assistantMessageEvent.partial.content', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-real-tools-1' },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_start',
            contentIndex: 1,
            partial: {
              content: [
                { type: 'text', text: '' },
                {
                  type: 'toolCall',
                  id: 'call_read_1',
                  name: 'read',
                  arguments: {},
                  partialArgs: '',
                  streamIndex: 0,
                },
              ],
            },
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_delta',
            contentIndex: 1,
            delta: '',
            partial: {
              content: [
                { type: 'text', text: '' },
                {
                  type: 'toolCall',
                  id: 'call_read_1',
                  name: 'read',
                  arguments: {},
                  partialArgs: '',
                  streamIndex: 0,
                },
              ],
            },
          },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: {
              type: 'toolCall',
              id: 'call_read_1',
              name: 'read',
              arguments: { path: '/tmp/secret.txt' },
            },
          },
        },
        { type: 'turn_end', message: { usage: { input: 31, output: 12 } } },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read the file' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { internal_session_id: 'pi-real-tools-1' },
      { tool_calls: [{ id: 'call_read_1', name: 'read', arguments: '{"path":"/tmp/secret.txt"}' }] },
      { finish_reason: 'tool_calls', usage: { input_tokens: 31, output_tokens: 12 } },
    ])
  })

  it('surfaces real pi tool_execution_start events as OpenAI tool_calls', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'tool_execution_start',
          toolCallId: 'call_bash_1',
          toolName: 'bash',
          args: { command: 'pnpm test' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call_bash_1',
          toolName: 'bash',
          result: 'ok',
          isError: false,
        },
        { type: 'turn_end', message: { usage: { input: 10, output: 5 } } },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'run tests' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { tool_calls: [{ id: 'call_bash_1', name: 'bash', arguments: '{"command":"pnpm test"}' }] },
      { finish_reason: 'tool_calls', usage: { input_tokens: 10, output_tokens: 5 } },
    ])
  })

  it('surfaces pi nested tool_call_request events once', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'tool_call_request',
          toolCall: {
            id: 'call_bash_1',
            name: 'bash',
            arguments: { command: 'pnpm test' },
          },
        },
        {
          type: 'tool_call_response',
          toolCall: {
            id: 'call_bash_1',
            name: 'bash',
          },
        },
        { type: 'turn_end', message: { usage: { input: 10, output: 5 } } },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'run tests' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { tool_calls: [{ id: 'call_bash_1', name: 'bash', arguments: '{"command":"pnpm test"}' }] },
      { finish_reason: 'tool_calls', usage: { input_tokens: 10, output_tokens: 5 } },
    ])
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

  it('mounts request MCP servers as <cwd>/.pi/mcp.json for the run and cleans up after', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-test-'))
    const previousOverride = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '1'
    try {
      let configAtSpawn: unknown = null
      let cwdAtSpawn: string | undefined
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner(
          [
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
            { type: 'turn_end', message: { usage: { input: 5, output: 2 } } },
          ],
          (_bin, _args, opts) => {
            cwdAtSpawn = opts.cwd
            configAtSpawn = JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json'), 'utf-8'))
          },
        ),
      })

      const deltas = await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'submit the proposal' }],
        cwd,
        mcp: {
          mcpServers: {
            'legal-tools': { command: 'tsx', args: ['proposal-server.ts'], env: { CASE_ID: 'c-1' } },
          },
        },
      }, null, new AbortController().signal))

      // The pi subprocess must see the config in ITS cwd before it starts.
      expect(cwdAtSpawn).toBe(cwd)
      expect(configAtSpawn).toEqual({
        mcpServers: {
          'legal-tools': { command: 'tsx', args: ['proposal-server.ts'], env: { CASE_ID: 'c-1' } },
        },
      })
      expect(deltas.at(-1)).toEqual({
        finish_reason: 'stop',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      // Run-scoped mount: the workspace is restored after the subprocess exits.
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects MCP requests loudly when pi-mcp-adapter is not installed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-test-'))
    const previousOverride = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '0'
    try {
      let spawnCount = 0
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner([], () => { spawnCount += 1 }),
      })

      const run = collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'submit the proposal' }],
        cwd,
        mcp: { mcpServers: { 'legal-tools': { command: 'tsx', args: ['proposal-server.ts'] } } },
      }, null, new AbortController().signal))

      await expect(run).rejects.toThrowError(BackendError)
      await expect(run).rejects.toThrowError(/pi-mcp-adapter/)
      await expect(run).rejects.toThrowError(/legal-tools/)
      await run.catch((err: BackendError) => {
        expect(err.code).toBe('not_configured')
      })
      // Fail-loud means fail BEFORE spawning a tool-less run.
      expect(spawnCount).toBe(0)
      expect(existsSync(join(cwd, '.pi'))).toBe(false)
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs without any MCP mount when the request carries no MCP servers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-test-'))
    const previousOverride = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    // Adapter absent — must NOT matter when no MCP was requested.
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '0'
    try {
      let piConfigExistedAtSpawn: boolean | null = null
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner(
          [
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
            { type: 'turn_end', message: { usage: { input: 3, output: 1 } } },
          ],
          () => { piConfigExistedAtSpawn = existsSync(join(cwd, '.pi', 'mcp.json')) },
        ),
      })

      const deltas = await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        cwd,
      }, null, new AbortController().signal))

      expect(piConfigExistedAtSpawn).toBe(false)
      expect(deltas.at(-1)).toEqual({
        finish_reason: 'stop',
        usage: { input_tokens: 3, output_tokens: 1 },
      })
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
