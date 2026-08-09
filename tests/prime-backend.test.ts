import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  primeApiKeyEnv,
  PrimeBackend,
  primeProcessEnvironment,
} from '../src/backends/prime.js'
// The profile lowering itself is the shared implementation both prime
// executors run; these tests exercise it through this backend's own contract.
import {
  hasPrimeProfileMaterial,
  materializePrimeProfileControls,
  parsePrimeModelsJson,
  PRIME_AGENT_DIR_ENV_VARS,
  primeThinkingLevel,
  readPrimeProfileControls,
} from '@tangle-network/agent-profile-materialize'
import type { AgentProfile } from '@tangle-network/agent-interface'
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
  /** Contents of every argv-named file, read AT SPAWN — which is when the real
   *  process would read them, and before per-run dirs are cleaned up. */
  argFiles: Record<string, string>
  /** Relative paths under every argv-named directory, read at spawn. */
  argDirs: Record<string, string[]>
}

function snapshotArgPaths(args: string[]): Pick<SpawnCapture, 'argFiles' | 'argDirs'> {
  const argFiles: Record<string, string> = {}
  const argDirs: Record<string, string[]> = {}
  for (const value of args) {
    if (!value.startsWith('/') || !existsSync(value)) continue
    if (statSync(value).isDirectory()) {
      argDirs[value] = readdirSync(value, { recursive: true, encoding: 'utf8' }).sort()
    } else {
      argFiles[value] = readFileSync(value, 'utf8')
    }
  }
  return { argFiles, argDirs }
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
      ...snapshotArgPaths(args),
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
    expect(primeThinkingLevel('none')).toBe('off')
    expect(primeThinkingLevel('minimal')).toBe('minimal')
    expect(primeThinkingLevel('xhigh')).toBe('xhigh')
    // The fork adds `max` above upstream Pi's xhigh ceiling.
    expect(primeThinkingLevel('ultracode')).toBe('max')
    expect(primeThinkingLevel(undefined)).toBeUndefined()
    // An effort with no rung FAILS rather than dropping the flag: a silently
    // omitted --thinking runs at the default level while the caller believes
    // the requested effort is in force.
    expect(() => primeThinkingLevel('sideways')).toThrowError(/no --thinking rung/)
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
    ))).rejects.toThrowError(/cannot mount MCP servers.*coordination/)
  })

  it('rejects agent_profile.mcp instead of silently dropping it', async () => {
    const backend = newBackend(primeSpawner([], []))
    await expect(collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: {
          model: { provider: 'tangle', default: 'glm-5.2' },
          mcp: { linear: { transport: 'http', url: 'https://mcp.linear.app/mcp' } },
        },
      },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/cannot mount MCP servers.*linear/)
  })

  it('treats a fully disabled agent_profile.mcp map as no MCP request', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    const deltas = await collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: {
          model: { provider: 'tangle', default: 'glm-5.2' },
          mcp: { linear: { enabled: false } },
        },
      },
      null,
      new AbortController().signal,
    ))
    expect(captures).toHaveLength(1)
    expect(deltas.at(-1)).toEqual({ finish_reason: 'stop' })
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
    // Both intents ride FILES, not argv literals: the fork resolves a flag
    // value as a file when the path exists, so there is no argv size ceiling.
    const files = captures[0]!.argFiles
    expect(files[args[args.indexOf('--system-prompt') + 1]!]).toBe('REPLACED_SYSTEM')
    expect(files[args[args.indexOf('--append-system-prompt') + 1]!]).toContain('ADDED_SYSTEM')
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
    ))).rejects.toThrowError(/agent_profile\.harness is invalid: prime cannot run a profile pinned to harness "pi"/)
  })

  it('runs a profile pinned to harness "prime" (interface 0.45 enum)', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    const deltas = await collect(backend.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: {
          harness: 'prime',
          model: { provider: 'tangle', default: 'glm-5.2' },
          prompt: { appendSystemPrompt: 'PINNED_TO_PRIME' },
        },
      },
      null,
      new AbortController().signal,
    ))
    expect(captures).toHaveLength(1)
    const args = captures[0]!.args
    expect(captures[0]!.argFiles[args[args.indexOf('--append-system-prompt') + 1]!])
      .toContain('PINNED_TO_PRIME')
    expect(deltas.at(-1)).toEqual({ finish_reason: 'stop' })
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
    ))).rejects.toThrowError(
      /agent_profile\.model\.default is invalid: .*"tangle\/glm-5.2".*"tangle\/other-model".*does not name/s,
    )
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
    const appended = captures[0]!.argFiles[args[args.indexOf('--append-system-prompt') + 1]!]!
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

  it('forwards the operator kernel venv and never a harness-state redirect', () => {
    // The fork reads PRIME_AGENT_KERNEL_VENV, and dropping it re-bootstraps the
    // kernel venv through uv on every run under the isolated HOME. The RLM_*
    // vars go the other way: either would re-point the self-modifying store
    // outside the isolated agent dir.
    const env = primeProcessEnvironment(
      {
        PATH: '/usr/bin',
        PRIME_AGENT_KERNEL_VENV: '/opt/prime/kernel-venv',
        RLM_GLOBAL_HARNESS_STATE_DIR: '/shared/harness',
        RLM_HARNESS_STATE_DIR: '/shared/harness-local',
      },
      { RLM_HARNESS_STATE_DIR: '/attacker/harness' },
    )
    expect(env.PRIME_AGENT_KERNEL_VENV).toBe('/opt/prime/kernel-venv')
    expect(env.RLM_GLOBAL_HARNESS_STATE_DIR).toBeUndefined()
    expect(env.RLM_HARNESS_STATE_DIR).toBeUndefined()
  })

  it('pins the agent dir under every name the agent could resolve it from', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }], session_id: 'dir-pin' },
      null,
      new AbortController().signal,
    ))
    const env = captures[0]!.env
    // PRIME_BIN can resolve to upstream pi, which reads PI_CODING_AGENT_DIR and
    // would otherwise fall back to ONE shared config dir for every session.
    const pinned = new Set(PRIME_AGENT_DIR_ENV_VARS.map((name) => env[name]))
    expect(pinned.size).toBe(1)
    expect([...pinned][0]).toBe(env.PRIME_AGENT_CODING_AGENT_DIR)
  })

  it('writes the operator models.json atomically with an owner-only mode', async () => {
    const modelsDir = mkdtempSync(join(tmpdir(), 'prime-models-mode-'))
    cleanupDirs.push(modelsDir)
    const modelsJsonPath = join(modelsDir, 'models.json')
    writeFileSync(modelsJsonPath, JSON.stringify({ providers: { tangle: { apiKey: 'K' } } }))
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures), { modelsJsonPath })
    await collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }], session_id: 'models-mode' },
      null,
      new AbortController().signal,
    ))
    // The fork reloads models.json at model-resolution time, and this copy
    // holds the operator's real credential material.
    const materialized = join(captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!, 'models.json')
    expect(statSync(materialized).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!))
      .filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails a run whose IPython kernel died instead of reporting a generic turn failure', async () => {
    // The fork never re-provisions a crashed kernel headlessly, so the session
    // is unrecoverable rather than retryable and the caller must be told which.
    const stream = [
      HAPPY_STREAM[0]!,
      HAPPY_STREAM[1]!,
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'ipython',
        isError: true,
        result: 'Error: Kernel exited before resolving ports. stderr:\n(empty)',
      },
      HAPPY_STREAM.at(-2)!,
      HAPPY_STREAM.at(-1)!,
    ]
    const backend = newBackend(primeSpawner(stream, []))
    await expect(collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))).rejects.toThrowError(/IPython kernel died \("Kernel exited before resolving ports"\).*unrecoverable/s)
  })

  it('does not fail a run because the assistant quoted a kernel marker', async () => {
    // The model's own prose rides text_delta and is excluded from the scan;
    // failing on it would kill healthy runs that discuss the failure mode.
    const stream = [
      HAPPY_STREAM[0]!,
      HAPPY_STREAM[1]!,
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'If you see "Kernel has been shut down", restart the session.',
        },
      },
      HAPPY_STREAM.at(-2)!,
      HAPPY_STREAM.at(-1)!,
    ]
    const backend = newBackend(primeSpawner(stream, []))
    const deltas = await collect(backend.chat(
      { model: 'prime/tangle/glm-5.2', messages: [{ role: 'user', content: 'TASK' }] },
      null,
      new AbortController().signal,
    ))
    expect(deltas.at(-1)).toEqual({ finish_reason: 'stop' })
  })
})

describe('PrimeBackend profile dimensions', () => {
  async function chatWithProfile(
    profile: AgentProfile,
    sessionId?: string,
    backend?: PrimeBackend,
    captures: SpawnCapture[] = [],
  ): Promise<{ backend: PrimeBackend; captures: SpawnCapture[] }> {
    const b = backend ?? newBackend(primeSpawner(HAPPY_STREAM, captures))
    await collect(b.chat(
      {
        model: 'prime/tangle/glm-5.2',
        messages: [{ role: 'user', content: 'TASK' }],
        agent_profile: profile,
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      null,
      new AbortController().signal,
    ))
    return { backend: b, captures }
  }

  it('rejects every profile control the fork verifiably cannot honor', async () => {
    const rejected: Array<[AgentProfile, RegExp]> = [
      [{ permissions: { bash: 'deny' } }, /agent_profile\.permissions is not supported by backend prime/],
      [{ tools: { ipython: false } }, /agent_profile\.tools is not supported by backend prime/],
      [{ hooks: { preToolUse: [{ command: 'echo hi' }] } }, /agent_profile\.hooks is not supported by backend prime/],
      [{ modes: { review: { prompt: 'review' } } }, /agent_profile\.modes is not supported by backend prime/],
      [
        { connections: [{ connectionId: 'c1', capabilities: ['gmail.read'] }] },
        /agent_profile\.connections is not supported by backend prime/,
      ],
      [{ confidential: {} }, /agent_profile\.confidential is not supported by backend prime/],
      [
        { resources: { files: [{ path: 'x.txt', resource: { kind: 'inline', name: 'x', content: 'hi' } }] } },
        /agent_profile\.resources: files is not supported by backend prime/,
      ],
      [
        { resources: { tools: [{ kind: 'inline', name: 'x', content: 'hi' }] } },
        /agent_profile\.resources: tools is not supported by backend prime/,
      ],
      [
        { resources: { agents: [{ kind: 'inline', name: 'x', content: 'hi' }] } },
        /agent_profile\.resources: agents is not supported by backend prime/,
      ],
      [
        { resources: { commands: [{ kind: 'inline', name: 'x', content: 'hi' }] } },
        /agent_profile\.resources: commands is not supported by backend prime/,
      ],
      [
        { resources: { skills: [{ kind: 'github', path: 'skills/foo' }] } },
        /agent_profile\.resources\.skills\[0\] is not supported by backend prime.*GitHub/,
      ],
      [
        { resources: { instructions: { kind: 'github', path: 'docs/AGENTS.md' } } },
        /agent_profile\.resources\.instructions is not supported by backend prime.*GitHub/,
      ],
      [
        { subagents: { helper: { prompt: 'do it', model: 'tangle/glm-5.2' } } },
        /agent_profile\.subagents\["helper"\] fields: model is not supported by backend prime/,
      ],
      [
        { subagents: { helper: { prompt: 'do it', maxSteps: 5 } } },
        /agent_profile\.subagents\["helper"\] fields: maxSteps is not supported by backend prime/,
      ],
      [
        { extensions: { prime: { magic: true } } },
        /agent_profile\.extensions\.prime is not supported by backend prime.*magic/,
      ],
    ]
    for (const [profile, pattern] of rejected) {
      await expect(chatWithProfile(profile), JSON.stringify(profile)).rejects.toThrowError(pattern)
    }
  })

  it('ignores other backends\' extension namespaces per the extensions contract', async () => {
    const { captures } = await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      extensions: { pi: { load: [] } },
    })
    expect(captures).toHaveLength(1)
  })

  it('refuses malformed skill and subagent declarations before provisioning anything', () => {
    expect(() => readPrimeProfileControls({
      resources: { skills: [{ kind: 'inline', name: 'Bad_Name', content: 'x' }] },
    })).toThrowError(/not a valid prime skill name/)
    expect(() => readPrimeProfileControls({
      resources: {
        skills: [
          { kind: 'inline', name: 'dupe', content: 'a' },
          { kind: 'inline', name: 'dupe', content: 'b' },
        ],
      },
    })).toThrowError(/declares "dupe" twice/)
    expect(() => readPrimeProfileControls({
      subagents: { helper: { metadata: { note: 'no behavior' } } },
    })).toThrowError(/declares no behavior/)
    expect(() => readPrimeProfileControls({
      subagents: { 'my agent': { prompt: 'a' }, my_agent: { prompt: 'b' } },
    })).toThrowError(/collides with subagent "my agent" on harness-state id "profile-my-agent"/)
  })

  it('surfaces a shared-lowering refusal as this backend\'s typed error', async () => {
    // The reason text is the shared fork evidence; only the framing and the
    // BackendError code belong to this backend.
    await expect(chatWithProfile({ hooks: {} }))
      .rejects.toMatchObject({
        name: 'BackendError',
        code: 'not_configured',
        message: expect.stringMatching(
          /agent_profile\.hooks is not supported by backend prime: .*no hook mechanism/s,
        ),
      })
    await expect(chatWithProfile({
      resources: { skills: [{ kind: 'inline', name: 'Bad_Name', content: 'x' }] },
    })).rejects.toMatchObject({ name: 'BackendError', code: 'parse_error' })
  })

  it('materializes instructions, inline skills, and subagents into the per-session agent dir', async () => {
    const captures: SpawnCapture[] = []
    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      prompt: { instructions: ['Always run the linter.', 'Prefer small diffs.'] },
      resources: {
        skills: [{
          kind: 'inline',
          name: 'release-check',
          content: '---\ndescription: Verify releases before shipping\n---\n\nRun the release checklist.',
        }],
        instructions: 'Repository conventions apply.',
      },
      subagents: {
        'code reviewer': { description: 'Reviews diffs.', prompt: 'Review the diff carefully.' },
      },
    }, 'profile-dims-run', undefined, captures)

    const agentDir = captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!
    // Instructions have no flag — the fork finds them BY the agent dir.
    expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe(
      'Always run the linter.\n\nPrefer small diffs.\n\nRepository conventions apply.\n',
    )

    // Skills are bound by an explicit --skill dir rather than left to the
    // fork's global auto-discovery, which a same-named project-scope skill
    // would shadow.
    const args = captures[0]!.args
    const skillsRoot = args[args.indexOf('--skill') + 1]!
    const skillMd = readFileSync(join(skillsRoot, 'release-check', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('name: release-check')
    expect(skillMd).toContain('Verify releases before shipping')
    expect(skillMd).toContain('Run the release checklist.')

    const state = JSON.parse(readFileSync(join(agentDir, 'harness', 'harness_state.json'), 'utf8')) as {
      schema: number
      entries: Record<string, Record<string, Record<string, unknown>>>
      refinements: unknown[]
    }
    expect(state.schema).toBe(1)
    expect(state.refinements).toEqual([])
    const entry = state.entries.subagent!['profile-code-reviewer']!
    expect(entry).toMatchObject({
      id: 'profile-code-reviewer',
      kind: 'subagent',
      title: 'code reviewer',
      content: 'Reviews diffs.\n\nReview the diff carefully.',
      path: 'profile',
      scope: 'global',
      source: 'profile',
      version: 1,
    })
    // The kernel loader drops entries without string title/content
    // (harness.py load); pin both are strings.
    expect(typeof entry.title).toBe('string')
    expect(typeof entry.content).toBe('string')
  })

  it('re-provisions a session dir: prunes stale bridge files, preserves agent-created state', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      resources: { skills: [{ kind: 'inline', name: 'alpha', content: 'first profile skill' }] },
      subagents: { helper: { prompt: 'Help with tasks.' } },
    }, 'profile-reprov', backend, captures)

    const agentDir = captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!
    const firstSkillsRoot = captures[0]!.args[captures[0]!.args.indexOf('--skill') + 1]!
    // Simulate the agent's own self-modification between turns: a skill it
    // wrote itself into the agent dir's auto-discovery tree, and a harness
    // entry it learned.
    mkdirSync(join(agentDir, 'skills', 'self-made'), { recursive: true })
    writeFileSync(
      join(agentDir, 'skills', 'self-made', 'SKILL.md'),
      '---\nname: self-made\ndescription: agent-authored\n---\nbody\n',
    )
    const statePath = join(agentDir, 'harness', 'harness_state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: { subagent: Record<string, Record<string, unknown>> }
    }
    state.entries.subagent.self_learned = {
      id: 'self_learned',
      kind: 'subagent',
      title: 'self learned',
      content: 'The agent made this one.',
      path: 'general',
      scope: 'global',
      source: 'agent',
      version: 1,
    }
    writeFileSync(statePath, JSON.stringify(state))

    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      resources: { skills: [{ kind: 'inline', name: 'beta', content: 'second profile skill' }] },
      subagents: { checker: { prompt: 'Check results.' } },
    }, 'profile-reprov', backend, captures)

    const secondSkillsRoot = captures[1]!.args[captures[1]!.args.indexOf('--skill') + 1]!
    expect(secondSkillsRoot).toBe(firstSkillsRoot)
    expect(existsSync(join(secondSkillsRoot, 'alpha'))).toBe(false)
    expect(existsSync(join(secondSkillsRoot, 'beta', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentDir, 'skills', 'self-made', 'SKILL.md'))).toBe(true)

    const next = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: { subagent: Record<string, Record<string, unknown>> }
    }
    expect(next.entries.subagent['profile-helper']).toBeUndefined()
    expect(next.entries.subagent['profile-checker']).toMatchObject({ source: 'profile' })
    expect(next.entries.subagent.self_learned).toMatchObject({ source: 'agent', title: 'self learned' })
  })

  it('adopts subagent entries a pre-shared build of this backend left behind', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      subagents: { helper: { prompt: 'Help.' } },
    }, 'profile-legacy', backend, captures)
    const statePath = join(
      captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!, 'harness', 'harness_state.json',
    )
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: { subagent: Record<string, Record<string, unknown>> }
    }
    // The id and source this backend wrote before the collapse. Each side's
    // prune matched only its OWN source, so without adoption these entries
    // would be unprunable and the roster would silently accumulate duplicates.
    state.entries.subagent.legacy_helper = {
      id: 'legacy_helper',
      kind: 'subagent',
      title: 'helper',
      content: 'Help.',
      path: 'general',
      scope: 'global',
      source: 'cli-bridge-profile',
      version: 1,
    }
    writeFileSync(statePath, JSON.stringify(state))

    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      subagents: { helper: { prompt: 'Help.' } },
    }, 'profile-legacy', backend, captures)

    const next = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: { subagent: Record<string, Record<string, unknown>> }
    }
    expect(Object.keys(next.entries.subagent)).toEqual(['profile-helper'])
  })

  it('refuses to overwrite a harness state file that no longer parses', async () => {
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures))
    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      subagents: { helper: { prompt: 'Help.' } },
    }, 'profile-corrupt', backend, captures)
    const agentDir = captures[0]!.env.PRIME_AGENT_CODING_AGENT_DIR!
    writeFileSync(join(agentDir, 'harness', 'harness_state.json'), 'not json {')
    await expect(chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      subagents: { helper: { prompt: 'Help.' } },
    }, 'profile-corrupt', backend, captures)).rejects.toThrowError(/harness state .*not valid JSON/)
  })

  it('refuses agent-dir-only profile material together with a persistent agent dir', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'prime-persistent-dims-'))
    cleanupDirs.push(agentDir)
    const backend = newBackend(primeSpawner(HAPPY_STREAM, []), { persistentAgentDir: agentDir })
    for (const profile of [
      { prompt: { instructions: ['standing rule'] } },
      { subagents: { helper: { prompt: 'Help.' } } },
    ] as AgentProfile[]) {
      await expect(chatWithProfile({
        model: { provider: 'tangle', default: 'glm-5.2' },
        ...profile,
      }, undefined, backend)).rejects.toThrowError(/operator-owned dir this backend must not rewrite/)
    }
  })

  it('binds flag-named profile material without writing into a persistent agent dir', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'prime-persistent-clean-'))
    cleanupDirs.push(agentDir)
    writeFileSync(join(agentDir, 'AGENTS.md'), 'operator instructions\n')
    const captures: SpawnCapture[] = []
    const backend = newBackend(primeSpawner(HAPPY_STREAM, captures), { persistentAgentDir: agentDir })
    await chatWithProfile({
      model: { provider: 'tangle', default: 'glm-5.2' },
      prompt: { appendSystemPrompt: 'ADDED' },
      resources: { skills: [{ kind: 'inline', name: 'alpha', content: 'skill body' }] },
    }, undefined, backend, captures)

    // The prompt file and the skills root are named by flags, so they live in
    // this run's own dir and the operator's files are untouched.
    const args = captures[0]!.args
    const appendPath = args[args.indexOf('--append-system-prompt') + 1]!
    const skillsRoot = args[args.indexOf('--skill') + 1]!
    expect(captures[0]!.argFiles[appendPath]).toBe('ADDED')
    expect(captures[0]!.argDirs[skillsRoot]).toContain(join('alpha', 'SKILL.md'))
    expect(appendPath.startsWith(agentDir)).toBe(false)
    expect(skillsRoot.startsWith(agentDir)).toBe(false)
    expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe('operator instructions\n')
    expect(existsSync(join(agentDir, 'harness', 'harness_state.json'))).toBe(false)
    expect(existsSync(join(agentDir, 'profile'))).toBe(false)
  })

  it('reports whether resolved controls need the agent dir itself', () => {
    expect(hasPrimeProfileMaterial(readPrimeProfileControls({}))).toBe(false)
    expect(hasPrimeProfileMaterial(readPrimeProfileControls({
      prompt: { instructions: ['x'] },
    }))).toBe(true)
    // A skill body without frontmatter still gains the loader-required
    // name/description frontmatter (a description-less SKILL.md is silently
    // dropped by the fork).
    const dir = mkdtempSync(join(tmpdir(), 'prime-skill-normalize-'))
    cleanupDirs.push(dir)
    const args = materializePrimeProfileControls(
      dir,
      readPrimeProfileControls({
        resources: { skills: [{ kind: 'inline', name: 'bare', content: 'Just a body.' }] },
      }),
    )
    const md = readFileSync(join(args[args.indexOf('--skill') + 1]!, 'bare', 'SKILL.md'), 'utf8')
    expect(md).toContain('name: bare')
    expect(md).toContain('description:')
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
