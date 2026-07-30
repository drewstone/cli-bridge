import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

async function collect(deltas: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const delta of deltas) out.push(delta)
  return out
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('PiBackend', () => {
  it('isolates concurrent same-name profile resources and keeps their authority channels distinct', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-isolation-'))
    const operatorContext = 'OPERATOR_CONTEXT_MUST_NOT_BE_REPLACED\n'
    writeFileSync(join(cwd, 'AGENTS.md'), operatorContext)

    const captured: Array<{
      args: string[]
      root: string
      systemPrompt: string
      instructions: string
      skill: string
      promptTemplate: string
    }> = []
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, rawArgs) => {
        const args = [...rawArgs]
        const systemPromptPath = argValue(args, '--system-prompt')
        const instructionsPath = argValue(args, '--append-system-prompt')
        const skillPath = argValue(args, '--skill')
        const promptTemplatePath = argValue(args, '--prompt-template')
        if (!systemPromptPath || !instructionsPath || !skillPath || !promptTemplatePath) {
          throw new Error('missing native Pi profile flag')
        }
        captured.push({
          args,
          root: dirname(dirname(systemPromptPath)),
          systemPrompt: readFileSync(systemPromptPath, 'utf8'),
          instructions: readFileSync(instructionsPath, 'utf8'),
          skill: readFileSync(skillPath, 'utf8'),
          promptTemplate: readFileSync(promptTemplatePath, 'utf8'),
        })
      }),
    })

    const request = (label: 'ALPHA' | 'BETA'): ChatRequest => ({
      model: 'pi/zai-coding-paas/glm-5.2',
      messages: [{ role: 'user', content: `${label} task` }],
      cwd,
      agent_profile: {
        prompt: {
          systemPrompt: `${label}_SYSTEM`,
          instructions: [`${label}_INSTRUCTION`],
        },
        resources: {
          instructions: `${label}_RESOURCE_INSTRUCTION`,
          skills: [{
            kind: 'inline',
            name: 'method',
            content: `${label}_SKILL_CONTENT`,
          }],
          commands: [{
            kind: 'inline',
            name: 'review',
            content: `${label}_PROMPT_TEMPLATE`,
          }],
        },
      },
    })

    try {
      await Promise.all([
        collect(backend.chat(request('ALPHA'), null, new AbortController().signal)),
        collect(backend.chat(request('BETA'), null, new AbortController().signal)),
      ])

      expect(captured).toHaveLength(2)
      const alpha = captured.find((entry) => entry.systemPrompt === 'ALPHA_SYSTEM')
      const beta = captured.find((entry) => entry.systemPrompt === 'BETA_SYSTEM')
      expect(alpha?.root).not.toBe(beta?.root)
      expect(alpha?.instructions).toContain('ALPHA_INSTRUCTION')
      expect(alpha?.instructions).toContain('ALPHA_RESOURCE_INSTRUCTION')
      expect(alpha?.instructions).not.toContain('BETA_')
      expect(beta?.instructions).toContain('BETA_INSTRUCTION')
      expect(beta?.instructions).toContain('BETA_RESOURCE_INSTRUCTION')
      expect(beta?.instructions).not.toContain('ALPHA_')
      expect(alpha?.skill).toContain('ALPHA_SKILL_CONTENT')
      expect(alpha?.skill).not.toContain('BETA_SKILL_CONTENT')
      expect(beta?.skill).toContain('BETA_SKILL_CONTENT')
      expect(beta?.skill).not.toContain('ALPHA_SKILL_CONTENT')
      expect(alpha?.promptTemplate).toBe('ALPHA_PROMPT_TEMPLATE\n')
      expect(beta?.promptTemplate).toBe('BETA_PROMPT_TEMPLATE\n')

      for (const entry of captured) {
        expect(entry.args).toContain('--no-context-files')
        expect(entry.args).toContain('--no-skills')
        expect(entry.args).toContain('--no-prompt-templates')
        expect(entry.args.at(-1)).toMatch(/^User: (?:ALPHA|BETA) task$/u)
        expect(entry.args.at(-1)).not.toContain('_SYSTEM')
        expect(existsSync(entry.root)).toBe(false)
      }
      expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe(operatorContext)
      expect(existsSync(join(cwd, '.pi'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('passes 140k instructions by file path instead of overflowing argv', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-large-profile-'))
    const instructions = `LARGE_INSTRUCTION_START\n${'x'.repeat(140_000)}\nLARGE_INSTRUCTION_END`
    let instructionPath = ''
    let argvBytes = 0
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, args) => {
        instructionPath = argValue(args, '--append-system-prompt') ?? ''
        argvBytes = Buffer.byteLength(args.join('\0'))
        expect(readFileSync(instructionPath, 'utf8')).toContain(instructions)
        expect(args.join('\n')).not.toContain('LARGE_INSTRUCTION_START')
      }),
    })

    try {
      await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        agent_profile: {
          prompt: { instructions: [instructions] },
        },
      }, null, new AbortController().signal))

      expect(argvBytes).toBeLessThan(4096)
      expect(instructionPath).not.toBe('')
      expect(existsSync(dirname(instructionPath))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps anonymous calls stateless, creates caller sessions, then resumes the mapped Pi session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-session-'))
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-session-cwd-'))
    const sessions = new SessionStore(dataDir)
    const argv: string[][] = []
    const profilePrompts: Array<string | null> = []
    const profileRoots: string[] = []
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
      ], (_bin, args) => {
        argv.push([...args])
        const systemPromptPath = argValue(args, '--system-prompt')
        profilePrompts.push(systemPromptPath ? readFileSync(systemPromptPath, 'utf8') : null)
        if (systemPromptPath) profileRoots.push(dirname(dirname(systemPromptPath)))
      }),
    })
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
    })
    const post = async (
      sessionId?: string,
      agentProfile?: ChatRequest['agent_profile'],
    ): Promise<Response> => {
      return await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'pi/zai-coding-paas/glm-5.2',
          messages: [{ role: 'user', content: 'inspect the project' }],
          stream: false,
          cwd,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(agentProfile ? { agent_profile: agentProfile } : {}),
        }),
      })
    }

    try {
      expect((await post()).status).toBe(200)
      expect(argv[0]).toContain('--no-session')
      expect(sessions.list()).toEqual([])

      expect((await post('discovery-run', {
        prompt: { systemPrompt: 'PERSISTED_PROFILE_SYSTEM' },
      })).status).toBe(200)
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
      expect(profilePrompts).toEqual([
        null,
        'PERSISTED_PROFILE_SYSTEM',
        'PERSISTED_PROFILE_SYSTEM',
      ])
      for (const root of profileRoots) expect(existsSync(root)).toBe(false)
    } finally {
      sessions.close()
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

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

  it('loads an explicit Pi extension set without ambient extension discovery', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-extension-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-profile-agent-dir-'))
    const packageDir = join(agentDir, 'npm', 'node_modules', 'pi-zai-glm')
    const extensionDir = join(packageDir, 'extensions')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    let args: string[] = []
    try {
      mkdirSync(extensionDir, { recursive: true })
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'pi-zai-glm',
          pi: { extensions: ['./extensions'] },
        }),
      )
      writeFileSync(join(extensionDir, 'provider.ts'), 'export default () => undefined\n')
      process.env.PI_CODING_AGENT_DIR = agentDir

      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner([
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
          { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
        ], (_bin, rawArgs) => {
          args = [...rawArgs]
        }),
      })
      await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        agent_profile: {
          extensions: {
            pi: { load: ['pi-zai-glm'] },
          },
        },
      }, null, new AbortController().signal))

      expect(args).toContain('--no-extensions')
      expect(argValue(args, '--extension')).toBe(packageDir)
      expect(args.indexOf('--extension')).toBeLessThan(args.length - 1)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(cwd, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it('fails before spawn when Pi-specific extension controls are unknown', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-extension-unknown-'))
    let spawns = 0
    try {
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner([], () => {
          spawns += 1
        }),
      })
      const run = collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        agent_profile: {
          extensions: {
            pi: { unknownControl: true },
          },
        },
      }, null, new AbortController().signal))

      await expect(run).rejects.toThrow(/unsupported extensions\.pi controls.*unknownControl/u)
      expect(spawns).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects generic Pi workspace files instead of relocating them invisibly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-generic-file-'))
    let spawns = 0
    try {
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner([], () => {
          spawns += 1
        }),
      })
      const run = collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        agent_profile: {
          resources: {
            files: [{
              path: 'scripts/helper.ts',
              resource: {
                kind: 'inline',
                name: 'helper',
                content: 'export const value = 1\n',
              },
            }, {
              path: '.pi/skills/pretend/SKILL.md',
              resource: {
                kind: 'inline',
                name: 'pretend',
                content: 'must remain a task-relative generic file\n',
              },
            }],
          },
        },
      }, null, new AbortController().signal))

      await expect(run).rejects.toThrow(/no request-scoped Pi loader.*scripts\/helper\.ts/u)
      expect(spawns).toBe(0)
      expect(existsSync(join(cwd, 'scripts', 'helper.ts'))).toBe(false)
      expect(existsSync(join(cwd, '.pi', 'skills', 'pretend', 'SKILL.md'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('removes request-scoped profile files when Pi fails to spawn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-spawn-failure-'))
    let profileRoot = ''
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: async (_bin, args) => {
        const systemPromptPath = argValue(args, '--system-prompt')
        if (!systemPromptPath) throw new Error('missing system prompt')
        profileRoot = dirname(dirname(systemPromptPath))
        expect(existsSync(profileRoot)).toBe(true)
        throw new Error('synthetic spawn failure')
      },
    })

    try {
      const run = collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        agent_profile: {
          prompt: { systemPrompt: 'SPAWN_FAILURE_SYSTEM' },
        },
      }, null, new AbortController().signal))
      await expect(run).rejects.toThrow('synthetic spawn failure')
      expect(profileRoot).not.toBe('')
      expect(existsSync(profileRoot)).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
