import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePrimeModelsJson,
  primeApiKeyEnv,
  PrimeBackend,
  primeProcessEnvironment,
  primeThinkingFlagForEffort,
} from '../src/backends/prime.js'
import { BackendError } from '../src/backends/types.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { loadConfig } from '../src/config.js'
import type { SessionRecord } from '../src/sessions/store.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

interface SpawnCapture {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string | undefined
  stdin: string
}

/** Scripted rpc-mode child: records the spawn, replays stdout lines, exits. */
function primeSpawner(
  lines: Array<Record<string, unknown>>,
  captures: SpawnCapture[],
  exitCode = 0,
  stderrText = '',
): Spawner {
  const spawner: Spawner = async (bin, args, opts): Promise<SpawnResult> => {
    const child = new FakeChild()
    const capture: SpawnCapture = {
      bin,
      args: [...args],
      env: { ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdin: '',
    }
    captures.push(capture)
    child.stdin.on('data', (chunk: Buffer) => { capture.stdin += chunk.toString() })
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      if (stderrText) child.stderr.write(stderrText)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = exitCode
        child.emit('close', exitCode)
      }, 10)
    })
    return {
      child: child as never,
      release() {},
      spawnError: () => null,
    }
  }
  spawner.executionEnvironment = 'test-double'
  return spawner
}

const HAPPY_STREAM: Array<Record<string, unknown>> = [
  { id: 'bridge-get-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 'prime-sess-1' } },
  { id: 'bridge-prompt', type: 'response', command: 'prompt', success: true },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } },
  {
    type: 'turn_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 11, cost: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.05, total: 0.5 } },
    },
    toolResults: [],
  },
  { type: 'agent_end', messages: [] },
]

function stdinCommands(capture: SpawnCapture): Array<Record<string, unknown>> {
  return capture.stdin
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function collect(deltas: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const delta of deltas) out.push(delta)
  return out
}

const cleanupDirs: string[] = []

function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-backend-state-'))
  cleanupDirs.push(dir)
  return dir
}

function newBackend(
  spawner: Spawner,
  overrides: Partial<ConstructorParameters<typeof PrimeBackend>[0]> = {},
): PrimeBackend {
  return new PrimeBackend({
    bin: 'prime-agent',
    timeoutMs: 1000,
    stateDir: newStateDir(),
    spawner,
    ...overrides,
  })
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('PrimeBackend', () => {
  it('matches prime model ids and nothing else', () => {
    const backend = newBackend(primeSpawner([], []))
    expect(backend.matches('prime')).toBe(true)
    expect(backend.matches('prime/zai/glm-5.2')).toBe(true)
    expect(backend.matches('PRIME/zai/glm-5.2')).toBe(true)
    expect(backend.matches('pi/zai/glm-5.2')).toBe(false)
    expect(backend.matches('primer/x')).toBe(false)
  })

  it('rejects a model id without an explicit provider and model', async () => {
    const backend = newBackend(primeSpawner([], []))
    for (const model of ['prime', 'prime/glm-5.2']) {
      await expect(collect(backend.chat(
        { model, messages: [{ role: 'user', content: 'hi' }] },
        null,
        new AbortController().signal,
      ))).rejects.toThrowError(/prime\/<provider>\/<model>/)
    }
  })

  it('maps the canonical reasoning ladder onto the fork\'s --thinking rungs', () => {
    expect(primeThinkingFlagForEffort('none')).toBe('off')
    expect(primeThinkingFlagForEffort('minimal')).toBe('minimal')
    expect(primeThinkingFlagForEffort('xhigh')).toBe('xhigh')
    // The fork adds `max` above upstream Pi's xhigh ceiling.
    expect(primeThinkingFlagForEffort('ultracode')).toBe('max')
    expect(primeThinkingFlagForEffort(undefined)).toBeNull()
    expect(primeThinkingFlagForEffort('sideways')).toBeNull()
  })

  it('spawns rpc mode with an isolated HOME and a daemon-proof arg/env contract', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    const previousKey = process.env.OPENAI_API_KEY
    const previousKernel = process.env.PRIME_AGENT_KERNEL_PYTHON
    process.env.OPENAI_API_KEY = 'ambient-secret'
    process.env.PRIME_AGENT_KERNEL_PYTHON = '/opt/kernel/bin/python'
    try {
      await collect(backend.chat(
        { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }], effort: 'ultracode' },
        null,
        new AbortController().signal,
      ))
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousKernel === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON
      else process.env.PRIME_AGENT_KERNEL_PYTHON = previousKernel
    }

    const [capture] = captures
    expect(capture).toBeDefined()
    const args = capture!.args
    expect(args.slice(0, 2)).toEqual(['--mode', 'rpc'])
    expect(args).toContain('--provider')
    expect(args[args.indexOf('--provider') + 1]).toBe('tangle')
    expect(args[args.indexOf('--model') + 1]).toBe('glm-5.2')
    expect(args[args.indexOf('--thinking') + 1]).toBe('max')
    expect(args).toContain('--no-session')
    expect(args).not.toContain('--continue')
    const socketPath = args[args.indexOf('--daemon-socket') + 1]
    expect(socketPath).toMatch(/prime-sock-.*d\.sock$/)

    const env = capture!.env
    expect(env.HOME).toMatch(/ephemeral-/)
    expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(join(env.HOME!, '.prime', 'agent'))
    expect(env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND).toBe('1')
    expect(env.XDG_DATA_HOME).toBe(join(env.HOME!, '.local', 'share'))
    expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME!, '.config'))
    expect(env.PRIME_AGENT_KERNEL_PYTHON).toBe('/opt/kernel/bin/python')
    expect(env.OPENAI_API_KEY).toBeUndefined()

    const commands = stdinCommands(capture!)
    expect(commands.map((c) => c.type)).toEqual(['get_state', 'prompt'])
    expect(commands[1]).toMatchObject({ id: 'bridge-prompt', message: 'TASK' })
    expect(commands[1]!.images).toBeUndefined()
  })

  it('removes the ephemeral HOME after an anonymous run', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))
    expect(existsSync(captures[0]!.env.HOME!)).toBe(false)
  })

  it('materializes the operator models.json and forwards exactly the apiKey env vars it names', async () => {
    const modelsDir = mkdtempSync(join(tmpdir(), 'prime-models-'))
    cleanupDirs.push(modelsDir)
    const modelsJsonPath = join(modelsDir, 'models.json')
    writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        tangle: {
          baseUrl: 'https://router.example/v1',
          api: 'openai-completions',
          apiKey: 'PRIME_TEST_ROUTER_KEY',
          models: [{ id: 'glm-5.2' }],
        },
      },
    }))
    const previous = process.env.PRIME_TEST_ROUTER_KEY
    process.env.PRIME_TEST_ROUTER_KEY = 'sk-router-123'
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures), { modelsJsonPath })
    try {
      await collect(backend.chat(
        { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }], session_id: 'models-run' },
        null,
        new AbortController().signal,
      ))
    } finally {
      if (previous === undefined) delete process.env.PRIME_TEST_ROUTER_KEY
      else process.env.PRIME_TEST_ROUTER_KEY = previous
    }
    const env = captures[0]!.env
    const materialized = join(env.PRIME_AGENT_CODING_AGENT_DIR!, 'models.json')
    expect(existsSync(materialized)).toBe(true)
    expect(JSON.parse(readFileSync(materialized, 'utf8'))).toMatchObject({
      providers: { tangle: { apiKey: 'PRIME_TEST_ROUTER_KEY' } },
    })
    expect(env.PRIME_TEST_ROUTER_KEY).toBe('sk-router-123')
  })

  it('sends request images through the rpc prompt command instead of dropping them', async () => {
    const pixel = Buffer.from('89504e470d0a1a0a', 'hex')
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pixel.toString('base64')}` } },
          ],
        }],
      },
      null,
      new AbortController().signal,
    ))
    const commands = stdinCommands(captures[0]!)
    const prompt = commands[1]!
    expect(prompt.images).toEqual([
      { type: 'image', data: pixel.toString('base64'), mimeType: 'image/png' },
    ])
    expect(String(prompt.message)).toContain('what is in this image?')
  })

  it('translates the rpc stream into session id, content, tool calls, usage, and cost', async () => {
    const stream: Array<Record<string, unknown>> = [
      ...HAPPY_STREAM.slice(0, 6),
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 1,
          toolCall: { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        },
      },
      ...HAPPY_STREAM.slice(6),
    ]
    const backend = newBackend(primeSpawner(stream, []))
    const deltas = await collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))

    expect(deltas[0]).toEqual({ internal_session_id: 'prime-sess-1' })
    expect(deltas.filter((d) => d.content).map((d) => d.content)).toEqual(['Hel', 'lo'])
    expect(deltas.find((d) => d.tool_calls)?.tool_calls).toEqual([
      { id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    ])
    const tokenUsage = deltas.find((d) => d.usage?.output_tokens !== undefined)?.usage
    expect(tokenUsage).toMatchObject({
      input_tokens: 8,
      fresh_input_tokens: 5,
      cache_read_input_tokens: 2,
      cache_write_input_tokens: 1,
      output_tokens: 3,
      model_requests: 1,
      cost_known: false,
    })
    const costUsage = deltas.find((d) => d.usage?.estimated_cost !== undefined)?.usage
    expect(costUsage).toMatchObject({
      estimated_cost: 0.5,
      cost_known: false,
      cost_provenance: 'catalog-estimate',
      cost_scope: 'total',
    })
    expect(deltas.at(-1)).toEqual({ finish_reason: 'tool_calls' })
  })

  it('fails loudly when the rpc prompt command is rejected', async () => {
    const backend = newBackend(primeSpawner([
      { id: 'bridge-get-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } },
      { id: 'bridge-prompt', type: 'response', command: 'prompt', success: false, error: 'No models available' },
    ], []))
    await expect(collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/prime prompt rejected: No models available/)
  })

  it('refuses to report a failed assistant turn as success even when text streamed', async () => {
    const backend = newBackend(primeSpawner([
      { id: 'bridge-get-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } },
      { id: 'bridge-prompt', type: 'response', command: 'prompt', success: true },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial answ' } },
      {
        type: 'turn_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'kernel connection lost', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        toolResults: [],
      },
      { type: 'agent_end', messages: [] },
    ], []))
    await expect(collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/prime assistant turn failed: kernel connection lost/)
  })

  it('surfaces a non-zero exit with stderr context', async () => {
    const backend = newBackend(primeSpawner([], [], 1, 'Error: uv is required for the kernel venv'))
    await expect(collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/prime exit 1: .*uv is required/)
  })

  it('keeps one stable HOME per bridge session and resumes with --continue', async () => {
    const captures: SpawnCapture[] = []
    const stateDir = newStateDir()
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures), { stateDir })

    const first: ChatRequest = {
      model: 'prime/tangle/glm-5.2',
      messages: [{ role: 'user', content: 'turn one' }],
      session_id: 'sess-abc',
    }
    await collect(backend.chat(first, null, new AbortController().signal))

    const resumed: SessionRecord = {
      externalId: 'sess-abc',
      backend: 'prime',
      internalId: 'prime-sess-1',
      cwd: null,
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SessionRecord
    await collect(backend.chat(
      { ...first, messages: [{ role: 'user', content: 'turn two' }] },
      resumed,
      new AbortController().signal,
    ))

    const [a, b] = captures
    expect(a!.env.HOME).toBe(b!.env.HOME)
    expect(a!.env.HOME).toContain(join(stateDir, 'sessions'))
    expect(a!.args).toContain('--session-dir')
    expect(a!.args).not.toContain('--no-session')
    expect(a!.args).not.toContain('--continue')
    expect(b!.args).toContain('--continue')
    expect(b!.args[b!.args.indexOf('--session-dir') + 1]).toBe(a!.args[a!.args.indexOf('--session-dir') + 1])
  })

  it('rejects request-scoped MCP servers instead of silently dropping them', async () => {
    const backend = newBackend(primeSpawner([], []))
    await expect(collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        mcp: { mcpServers: { coordination: { command: 'node', args: ['c.mjs'] } } },
      },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/cannot mount request-scoped MCP servers.*coordination/)
  })

  it('binds profile prompt intents to --system-prompt / --append-system-prompt', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: {
          prompt: { systemPrompt: 'REPLACED_SYSTEM', appendSystemPrompt: 'ADDED_SYSTEM' },
          model: { provider: 'tangle', default: 'glm-5.2' },
        },
      },
      null,
      new AbortController().signal,
    ))
    const args = captures[0]!.args
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('REPLACED_SYSTEM')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('ADDED_SYSTEM')
    // The task prompt stays the sole stdin message.
    expect(stdinCommands(captures[0]!)[1]).toMatchObject({ message: 'TASK' })
  })

  it('refuses a profile pinned to another harness', async () => {
    const backend = newBackend(primeSpawner([], []))
    await expect(collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: { harness: 'pi', prompt: { appendSystemPrompt: 'ADDED' } },
      },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/agent_profile\.harness "pi" conflicts with backend prime/)
  })

  it('refuses a profile whose model disagrees with the wire model', async () => {
    const backend = newBackend(primeSpawner([], []))
    await expect(collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: { model: { provider: 'tangle', default: 'other-model' } },
      },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/conflicts with agent_profile\.model "tangle\/other-model"/)
  })

  it('folds caller system messages into one --append-system-prompt', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [
          { role: 'system', content: 'You are a security auditor.' },
          { role: 'user', content: 'audit this' },
        ],
        responseFormat: { type: 'json_object' },
      },
      null,
      new AbortController().signal,
    ))
    const args = captures[0]!.args
    const appended = args[args.indexOf('--append-system-prompt') + 1]!
    expect(args.filter((value) => value === '--append-system-prompt')).toHaveLength(1)
    expect(appended).toContain('You are a security auditor.')
    expect(appended.indexOf('security auditor')).toBeLessThan(appended.indexOf('ONLY a single JSON object'))
    expect(stdinCommands(captures[0]!)[1]).toMatchObject({ message: 'audit this' })
  })

  it('forwards apiKey env vars named by a persistent agent dir\'s own models.json', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'prime-persistent-'))
    cleanupDirs.push(agentDir)
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { tangle: { baseUrl: 'https://r/v1', api: 'openai-completions', apiKey: 'PRIME_PERSIST_KEY' } },
    }))
    const previous = process.env.PRIME_PERSIST_KEY
    process.env.PRIME_PERSIST_KEY = 'sk-persist-1'
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures), { persistentAgentDir: agentDir })
    try {
      await collect(backend.chat(
        { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
        null,
        new AbortController().signal,
      ))
    } finally {
      if (previous === undefined) delete process.env.PRIME_PERSIST_KEY
      else process.env.PRIME_PERSIST_KEY = previous
    }
    const env = captures[0]!.env
    expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir)
    expect(env.PRIME_PERSIST_KEY).toBe('sk-persist-1')
    // The shared dir's models.json is the operator's file — never rewritten.
    expect(JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))).toMatchObject({
      providers: { tangle: { apiKey: 'PRIME_PERSIST_KEY' } },
    })
  })

  it('refuses conflicting isolation options at construction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-agent-dir-'))
    cleanupDirs.push(dir)
    const modelsJsonPath = join(dir, 'models.json')
    writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }))
    expect(() => new PrimeBackend({
      bin: 'prime-agent',
      timeoutMs: 0,
      stateDir: newStateDir(),
      modelsJsonPath,
      persistentAgentDir: dir,
    })).toThrowError(/cannot take both/)
  })

  it('rejects a malformed operator models.json at construction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-models-bad-'))
    cleanupDirs.push(dir)
    const modelsJsonPath = join(dir, 'models.json')
    writeFileSync(modelsJsonPath, JSON.stringify({ notProviders: {} }))
    expect(() => new PrimeBackend({
      bin: 'prime-agent',
      timeoutMs: 0,
      stateDir: newStateDir(),
      modelsJsonPath,
    })).toThrowError(/"providers" object/)
  })

  it('parses the fork\'s comment-and-trailing-comma models.json dialect', () => {
    const parsed = parsePrimeModelsJson(
      '{\n  // custom router\n  "providers": {\n    "tangle": { "baseUrl": "https://r/v1", },\n  },\n}',
      'models.json',
    )
    expect(parsed).toEqual({ providers: { tangle: { baseUrl: 'https://r/v1' } } })
  })

  it('forwards only env-shaped apiKey names that are actually set', () => {
    const config = {
      providers: {
        a: { apiKey: 'SET_VAR' },
        b: { apiKey: 'UNSET_VAR' },
        c: { apiKey: 'literal-secret-value' },
        d: { apiKey: '!op read secret' },
      },
    }
    expect(primeApiKeyEnv(config, { SET_VAR: 'v' } as NodeJS.ProcessEnv)).toEqual({ SET_VAR: 'v' })
  })

  it('builds the child environment from the allowlist only', () => {
    const env = primeProcessEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/real/home',
        OPENAI_API_KEY: 'ambient',
        XDG_DATA_HOME: '/real/xdg',
        PRIME_AGENT_INSTALL_UV: '1',
      },
      { HOME: '/isolated/home' },
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.PRIME_AGENT_INSTALL_UV).toBe('1')
    expect(env.HOME).toBe('/isolated/home')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.XDG_DATA_HOME).toBeUndefined()
  })
})

describe('prime config validation', () => {
  it('refuses PRIME_MODELS_JSON together with PRIME_PERSISTENT_AGENT_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'))
    cleanupDirs.push(dir)
    const modelsJson = join(dir, 'models.json')
    writeFileSync(modelsJson, JSON.stringify({ providers: {} }))
    expect(() => loadConfig({
      BRIDGE_BACKENDS: 'prime',
      PRIME_MODELS_JSON: modelsJson,
      PRIME_PERSISTENT_AGENT_DIR: dir,
    })).toThrowError(/both set/)
  })

  it('refuses a prime setting when the prime backend is not enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'))
    cleanupDirs.push(dir)
    const modelsJson = join(dir, 'models.json')
    writeFileSync(modelsJson, JSON.stringify({ providers: {} }))
    expect(() => loadConfig({
      BRIDGE_BACKENDS: 'claude',
      PRIME_MODELS_JSON: modelsJson,
    })).toThrowError(/not in BRIDGE_BACKENDS/)
  })

  it('refuses a PRIME_MODELS_JSON path that does not exist', () => {
    expect(() => loadConfig({
      BRIDGE_BACKENDS: 'prime',
      PRIME_MODELS_JSON: '/nonexistent/models.json',
    })).toThrowError(/does not exist/)
  })

  it('resolves valid prime settings into the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'))
    cleanupDirs.push(dir)
    const modelsJson = join(dir, 'models.json')
    writeFileSync(modelsJson, JSON.stringify({ providers: {} }))
    const config = loadConfig({ BRIDGE_BACKENDS: 'prime', PRIME_MODELS_JSON: modelsJson })
    expect(config.primeModelsJson).toBe(modelsJson)
    expect(config.primePersistentAgentDir).toBeNull()
    expect(config.primeBin).toBe('prime-agent')
  })
})

// Real-binary smoke, gated on an installed prime-agent: verifies the version
// probe the health check runs. Skipped where the fork is not installed.
const primeInstalled = ((): boolean => {
  try {
    execFileSync('prime-agent', ['--version'], { stdio: 'ignore', timeout: 15_000 })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!primeInstalled)('PrimeBackend integration (requires prime-agent)', () => {
  it('reports ready from the real binary', async () => {
    const backend = new PrimeBackend({ bin: 'prime-agent', timeoutMs: 0, stateDir: newStateDir() })
    const health = await backend.health()
    expect(health.state).toBe('ready')
    expect(health.version).toBeTruthy()
  })
})
