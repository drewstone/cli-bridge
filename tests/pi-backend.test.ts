import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import { PiBackend, piMcpAdapterAvailable } from '../src/backends/pi.js'
import { BackendError } from '../src/backends/types.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'

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

function pausingPiSpawner(lines: Array<Record<string, unknown>>): Spawner {
  return async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
    })
    return {
      child: child as never,
      async terminate() {
        if (child.exitCode !== null) return
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 143
        child.emit('close', 143)
      },
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
  it('keeps different Pi profile instructions request-local in one shared workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-isolation-'))
    const operatorInstructions = 'Persistent operator-authored workspace instructions.\n'
    const prompts: string[] = []
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
        },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, args) => {
        prompts.push(args.at(-1) ?? '')
      }),
    })
    const sharedResources = {
      skills: [{ kind: 'inline' as const, name: 'shared-proof', content: 'Use the shared proof skill.' }],
      commands: [{ kind: 'inline' as const, name: 'shared-command', content: 'Run the shared command.' }],
    }
    const alphaRequest: ChatRequest = {
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user' as const, content: 'alpha task' }],
      cwd,
      agent_profile: {
        prompt: {
          systemPrompt: 'ALPHA_SYSTEM',
          instructions: ['ALPHA_PROMPT_INSTRUCTION'],
        },
        resources: {
          ...sharedResources,
          instructions: 'ALPHA_RESOURCE_INSTRUCTION',
        },
      },
    }
    const betaRequest: ChatRequest = {
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user' as const, content: 'beta task' }],
      cwd,
      agent_profile: {
        prompt: {
          systemPrompt: 'BETA_SYSTEM',
          instructions: ['BETA_PROMPT_INSTRUCTION'],
        },
        resources: {
          ...sharedResources,
          instructions: {
            kind: 'inline' as const,
            name: 'beta-instructions',
            content: 'BETA_RESOURCE_INSTRUCTION',
          },
        },
      },
    }

    try {
      writeFileSync(join(cwd, 'AGENTS.md'), operatorInstructions)

      await Promise.all([
        collect(backend.chat(alphaRequest, null, new AbortController().signal)),
        collect(backend.chat(betaRequest, null, new AbortController().signal)),
      ])

      const alphaPrompt = prompts.find((prompt) => prompt.includes('ALPHA_SYSTEM'))
      const betaPrompt = prompts.find((prompt) => prompt.includes('BETA_SYSTEM'))
      expect(alphaPrompt).toContain('ALPHA_PROMPT_INSTRUCTION')
      expect(alphaPrompt).toContain('ALPHA_RESOURCE_INSTRUCTION')
      expect(alphaPrompt).not.toContain('BETA_PROMPT_INSTRUCTION')
      expect(alphaPrompt).not.toContain('BETA_RESOURCE_INSTRUCTION')
      expect(betaPrompt).toContain('BETA_PROMPT_INSTRUCTION')
      expect(betaPrompt).toContain('BETA_RESOURCE_INSTRUCTION')
      expect(betaPrompt).not.toContain('ALPHA_PROMPT_INSTRUCTION')
      expect(betaPrompt).not.toContain('ALPHA_RESOURCE_INSTRUCTION')

      expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe(operatorInstructions)
      expect(readFileSync(join(cwd, '.pi', 'skills', 'shared-proof', 'SKILL.md'), 'utf8'))
        .toContain('Use the shared proof skill.')
      expect(readFileSync(join(cwd, '.pi', 'prompts', 'shared-command.md'), 'utf8'))
        .toBe('Run the shared command.\n')
      expect(alphaRequest.profile_materialization_receipt?.files.map((file) => file.path))
        .toEqual(['.pi/prompts/shared-command.md', '.pi/skills/shared-proof/SKILL.md'])
      expect(betaRequest.profile_materialization_receipt?.files.map((file) => file.path))
        .toEqual(['.pi/prompts/shared-command.md', '.pi/skills/shared-proof/SKILL.md'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('still materializes an explicit caller resource targeting AGENTS.md', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-explicit-agents-resource-'))
    const prompts: string[] = []
    const request: ChatRequest = {
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user', content: 'work' }],
      cwd,
      agent_profile: {
        prompt: { instructions: ['REQUEST_SCOPED_INSTRUCTION'] },
        resources: {
          files: [{
            path: 'AGENTS.md',
            resource: {
              kind: 'inline',
              name: 'caller-agents',
              content: 'CALLER_OWNED_AGENTS_RESOURCE\n',
            },
          }],
        },
      },
    }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
        },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, args) => {
        prompts.push(args.at(-1) ?? '')
      }),
    })

    try {
      await collect(backend.chat(request, null, new AbortController().signal))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('REQUEST_SCOPED_INSTRUCTION')
      expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('CALLER_OWNED_AGENTS_RESOURCE\n')
      expect(request.profile_materialization_receipt?.files).toEqual([
        { path: 'AGENTS.md', mode: 0o644 },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps anonymous calls stateless, creates caller sessions, then resumes the mapped Pi session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-session-'))
    const sessions = new SessionStore(dataDir)
    const argv: string[][] = []
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'created-pi-session' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
        },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, args) => argv.push([...args])),
    })
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
    })
    const post = async (sessionId?: string): Promise<Response> => {
      return await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'pi/zai-coding-paas/glm-5.2',
          messages: [{ role: 'user', content: 'inspect the project' }],
          stream: false,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      })
    }

    try {
      expect((await post()).status).toBe(200)
      expect(argv[0]).toContain('--no-session')
      expect(sessions.list()).toEqual([])

      expect((await post('discovery-run')).status).toBe(200)
      expect(argv[1]).not.toContain('--no-session')
      expect(argv[1]).not.toContain('--session')
      expect(sessions.get('discovery-run', 'pi')).toMatchObject({
        internalId: 'created-pi-session',
        turns: 1,
      })

      expect((await post('discovery-run')).status).toBe(200)
      const sessionFlag = argv[2]?.indexOf('--session') ?? -1
      expect(argv[2]?.[sessionFlag + 1]).toBe('created-pi-session')
      expect(argv[2]).not.toContain('--no-session')
    } finally {
      sessions.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('emits only text deltas and preserves usage from turn_end.message.usage', async () => {
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
      { usage: { input_tokens: 8417, output_tokens: 30 } },
      { finish_reason: 'stop' },
    ])
  })

  it('emits every turn receipt once and does not double-count the agent_end aggregate', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'turn_end',
          message: { usage: { input: 100, output: 20 } },
        },
        {
          type: 'turn_end',
          message: { usage: { input: 240, output: 35 } },
        },
        {
          type: 'agent_end',
          usage: { input: 340, output: 55 },
          messages: [
            { role: 'assistant', usage: { input: 100, output: 20 } },
            { role: 'assistant', usage: { input: 240, output: 35 } },
          ],
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user', content: 'use tools twice' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { usage: { input_tokens: 100, output_tokens: 20 } },
      { usage: { input_tokens: 240, output_tokens: 35 } },
      { finish_reason: 'stop' },
    ])
  })

  it('accepts an agent_end aggregate only when no turn receipt was available', async () => {
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'agent_end',
          partial: { usage: { prompt_tokens: 19, completion_tokens: 7 } },
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/legacy-model',
      messages: [{ role: 'user', content: 'legacy event shape' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { usage: { input_tokens: 19, output_tokens: 7 } },
      { finish_reason: 'stop' },
    ])
  })

  it('preserves completed-turn usage when the outer run is aborted before agent_end', async () => {
    const controller = new AbortController()
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: pausingPiSpawner([
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
        },
        {
          type: 'turn_end',
          message: { usage: { input: 80, output: 12 } },
        },
      ]),
    })
    const iterator = backend.chat({
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user', content: 'keep working' }],
    }, null, controller.signal)[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value).toEqual({ content: 'partial' })
    const pending = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const deltas: ChatDelta[] = [first.value as ChatDelta]
    const second = await pending
    if (!second.done) deltas.push(second.value)
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      deltas.push(next.value)
    }

    expect(deltas).toEqual([
      { content: 'partial' },
      { usage: { input_tokens: 80, output_tokens: 12 } },
      { finish_reason: 'error' },
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
      { usage: { input_tokens: 20, output_tokens: 8 } },
      { finish_reason: 'tool_calls' },
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
      { usage: { input_tokens: 31, output_tokens: 12 } },
      { finish_reason: 'tool_calls' },
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
      { usage: { input_tokens: 10, output_tokens: 5 } },
      { finish_reason: 'tool_calls' },
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
      { usage: { input_tokens: 10, output_tokens: 5 } },
      { finish_reason: 'tool_calls' },
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

    expect(deltas.slice(-2)).toEqual([
      { usage: { input_tokens: 11, output_tokens: 7 } },
      { finish_reason: 'stop' },
    ])
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
      expect(deltas.slice(-2)).toEqual([
        { usage: { input_tokens: 5, output_tokens: 2 } },
        { finish_reason: 'stop' },
      ])
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

  it('detects the adapter installed via a local path in settings.json packages', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-agent-dir-'))
    const adapterDir = mkdtempSync(join(tmpdir(), 'pi-adapter-local-'))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const previousOverride = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      // Local-path install whose path does NOT contain "pi-mcp-adapter" —
      // detection must resolve the package.json name instead.
      writeFileSync(join(adapterDir, 'package.json'), JSON.stringify({ name: 'pi-mcp-adapter' }))
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [adapterDir] }))
      expect(piMcpAdapterAvailable()).toBe(true)

      // A local path whose package is something else is not the adapter.
      writeFileSync(join(adapterDir, 'package.json'), JSON.stringify({ name: 'some-other-ext' }))
      expect(piMcpAdapterAvailable()).toBe(false)

      // Relative specs resolve against the agent dir, not process cwd.
      mkdirSync(join(agentDir, 'exts', 'local-adapter'), { recursive: true })
      writeFileSync(
        join(agentDir, 'exts', 'local-adapter', 'package.json'),
        JSON.stringify({ name: 'pi-mcp-adapter' }),
      )
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['./exts/local-adapter'] }))
      expect(piMcpAdapterAvailable()).toBe(true)

      // Windows-style absolute specs are recognized as local paths (never
      // treated as npm names) and fail safe when unreadable on POSIX.
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['C:\\adapters\\mcp'] }))
      expect(piMcpAdapterAvailable()).toBe(false)
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [`file://${adapterDir}`] }))
      writeFileSync(join(adapterDir, 'package.json'), JSON.stringify({ name: 'pi-mcp-adapter' }))
      expect(piMcpAdapterAvailable()).toBe(true)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(adapterDir, { recursive: true, force: true })
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
      expect(deltas.slice(-2)).toEqual([
        { usage: { input_tokens: 3, output_tokens: 1 } },
        { finish_reason: 'stop' },
      ])
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
