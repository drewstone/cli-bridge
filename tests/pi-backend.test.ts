import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { defineAgentProfilePublicConfig as pub } from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import {
  DEFAULT_PI_TURN_ATTEMPTS,
  PiBackend,
  piMcpAdapterAvailable,
  piResponseIdentityFromEvent,
} from '../src/backends/pi.js'
import { BackendError } from '../src/backends/types.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { authSourcesFor } from '../src/jail/auth-preserve.js'
import { profileExecutionIdentity } from '../src/backends/profile-support.js'
import { testPiInferenceTransport } from './pi-inference-fixture.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

function piSpawner(
  lines: Array<Record<string, unknown>>,
  onSpawn?: (...spawnArgs: Parameters<Spawner>) => void,
): Spawner {
  const spawner: Spawner = async (...spawnArgs): Promise<SpawnResult> => {
    onSpawn?.(...spawnArgs)
    const child = new FakeChild()
    queueMicrotask(() => {
      const nativeSessionId = argValue(spawnArgs[1], '--session-id')
        ?? argValue(spawnArgs[1], '--session')
      for (const line of lines) {
        const output = line.type === 'session' && nativeSessionId
          ? { ...line, id: nativeSessionId }
          : line
        child.stdout.write(`${JSON.stringify(output)}\n`)
      }
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
  spawner.executionEnvironment = 'test-double'
  return spawner
}

function newTestPiBackend(options: ConstructorParameters<typeof PiBackend>[0]): PiBackend {
  if (options.spawner && options.spawner.executionEnvironment === undefined) {
    options.spawner.executionEnvironment = 'test-double'
  }
  return new PiBackend({
    ...options,
    transportResolver: options.transportResolver ?? testPiInferenceTransport(),
  })
}

function pausingPiSpawner(lines: Array<Record<string, unknown>>): Spawner {
  const spawner: Spawner = async (): Promise<SpawnResult> => {
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
  spawner.executionEnvironment = 'test-double'
  return spawner
}

async function collect(deltas: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const delta of deltas) out.push(delta)
  return out
}

/** A spawner whose first `failures` attempts die the way a transient upstream fault dies: nothing
 *  on stdout, a message on stderr, a non-zero exit. Later attempts stream `lines` and exit 0. */
function flakyPiSpawner(
  failures: number,
  lines: Array<Record<string, unknown>>,
  stderrText = 'stream closed by upstream',
  options: {
    readonly linesBeforeFailure?: Array<Record<string, unknown>>
    readonly onSpawn?: (args: readonly string[]) => void
  } = {},
): Spawner & { spawns: () => number } {
  let spawns = 0
  const spawner: Spawner = async (_bin, args): Promise<SpawnResult> => {
    options.onSpawn?.(args)
    const failing = spawns < failures
    spawns += 1
    const child = new FakeChild()
    queueMicrotask(() => {
      const emitted = failing ? (options.linesBeforeFailure ?? []) : lines
      for (const line of emitted) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      if (failing) child.stderr.write(stderrText)
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = failing ? 1 : 0
        child.emit('close', child.exitCode)
      }, 5)
    })
    return {
      child: child as never,
      release() {},
      spawnError: () => null,
    }
  }
  spawner.executionEnvironment = 'test-double'
  return Object.assign(spawner, { spawns: () => spawns })
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('PiBackend turn retry (#125)', () => {
  const successLines = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } },
    { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
  ]
  const request: ChatRequest = {
    model: 'pi/tangle-router/glm-5.2',
    messages: [{ role: 'user', content: 'TASK' }],
  }

  it('exposes only the protected gateway origin in the materialization receipt', async () => {
    const protectedBaseUrl = 'https://router.tangle.tools/v1/private-grant-route'
    const token = 'protected-token'
    const digest = `sha256:${createHash('sha256').update(token).digest('hex')}` as const
    const baseUrlDigest = `sha256:${createHash('sha256').update(protectedBaseUrl).digest('hex')}` as const
    const transport = testPiInferenceTransport()
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ]),
      transportResolver: async (selection, signal, credential) => {
        const resolved = await transport(selection, signal, credential)
        return {
          ...resolved,
          ...(credential === undefined
            ? {}
            : { upstreamBaseUrl: credential.baseUrl, requestScopedEndpoint: true }),
        }
      },
    })
    const protectedRequest: ChatRequest = {
      ...request,
      agent_profile: {
        name: 'protected-receipt',
        harness: 'pi',
        model: { provider: 'tangle-router', default: 'glm-5.2' },
      },
      protectedModelCredential: {
        token,
        digest,
        baseUrl: protectedBaseUrl,
        baseUrlDigest,
      },
    }

    await collect(backend.chat(protectedRequest, null, new AbortController().signal))

    expect(protectedRequest.profile_materialization_receipt?.inference?.effectiveEndpoint)
      .toBe('https://router.tangle.tools')
    expect(JSON.stringify(protectedRequest.profile_materialization_receipt))
      .not.toContain('/v1/private-grant-route')
  })

  it('retries a transient death that the caller never saw and delivers the recovered turn', async () => {
    // The measured shape: pi dies mid-stream before emitting anything. Four supervised runs ended
    // on exactly this, each sinking 0.2-2.9M input tokens, because one cut connection failed the
    // whole turn with no retry anywhere.
    const spawner = flakyPiSpawner(1, successLines)
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      turnRetryBackoffMs: 1,
    })
    const deltas = await collect(backend.chat(request, null, new AbortController().signal))

    expect(spawner.spawns()).toBe(2)
    // Exactly one copy of the answer: the failed attempt emitted nothing, so the caller's stream
    // never saw the death at all.
    expect(deltas.filter((d) => d.content).map((d) => d.content)).toEqual(['recovered'])
    expect(deltas.at(-1)?.finish_reason).toBe('stop')
  })

  it('retries a persistent first turn with the same reserved native session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-retry-session-cwd-'))
    const sourceSessionDir = mkdtempSync(join(tmpdir(), 'pi-retry-session-source-'))
    const argsBySpawn: string[][] = []
    const spawner = flakyPiSpawner(1, successLines, 'stream closed by upstream', {
      onSpawn: (args) => { argsBySpawn.push([...args]) },
    })
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      turnRetryBackoffMs: 0,
      transportResolver: testPiInferenceTransport({ sourceSessionDir }),
    })

    try {
      const deltas = await collect(backend.chat({
        ...request,
        cwd,
        session_id: 'persistent-retry-regression',
      }, null, new AbortController().signal))

      const firstId = argValue(argsBySpawn[0]!, '--session-id')
      expect(firstId).toBeTruthy()
      expect(argValue(argsBySpawn[1]!, '--session-id')).toBe(firstId)
      expect(argsBySpawn[1]).not.toContain('--session')
      expect(deltas.at(-1)?.finish_reason).toBe('stop')

      const sessionDir = argValue(argsBySpawn[0]!, '--session-dir')
      expect(sessionDir).toBe(argValue(argsBySpawn[1]!, '--session-dir'))
      expect(readdirSync(sessionDir!).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(sourceSessionDir, { recursive: true, force: true })
    }
  })

  it('never retries once the caller has already seen part of the stream', async () => {
    // A second attempt here would contradict a stream the caller is already reading — duplicated
    // content and a second usage record. The failure is raised, and the caller's driver-level
    // retry (which can resume the harness session) owns recovery from there.
    const spawner = flakyPiSpawner(1, successLines, 'died after content', {
      linesBeforeFailure: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } },
      ],
    })
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      turnRetryBackoffMs: 1,
    })
    await expect(
      collect(backend.chat(request, null, new AbortController().signal)),
    ).rejects.toThrow(/died after content/)
    expect(spawner.spawns()).toBe(1)
  })

  it('never retries a credential failure, which fails identically every time', async () => {
    const spawner = flakyPiSpawner(3, successLines, '401 Unauthorized: token expired')
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      turnRetryBackoffMs: 1,
    })
    const error = await collect(backend.chat(request, null, new AbortController().signal))
      .then(() => null)
      .catch((e: unknown) => e)

    expect(spawner.spawns()).toBe(1)
    expect(error).toBeInstanceOf(BackendError)
    expect((error as BackendError).code).toBe('not_configured')
  })

  it('raises the real failure once the attempts are spent', async () => {
    const spawner = flakyPiSpawner(5, successLines)
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      maxTurnAttempts: 3,
      turnRetryBackoffMs: 1,
    })
    await expect(
      collect(backend.chat(request, null, new AbortController().signal)),
    ).rejects.toThrow(/stream closed by upstream/)
    expect(spawner.spawns()).toBe(3)
  })

  it('honours maxTurnAttempts: 1 as the historical no-retry behavior', async () => {
    const spawner = flakyPiSpawner(1, successLines)
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      maxTurnAttempts: 1,
    })
    await expect(
      collect(backend.chat(request, null, new AbortController().signal)),
    ).rejects.toThrow(/stream closed by upstream/)
    expect(spawner.spawns()).toBe(1)
  })

  it('keeps a non-finite retry setting bounded at the default attempt count', async () => {
    const spawner = flakyPiSpawner(5, successLines)
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      maxTurnAttempts: Number.POSITIVE_INFINITY,
      turnRetryBackoffMs: 0,
    })

    await expect(
      collect(backend.chat(request, null, new AbortController().signal)),
    ).rejects.toThrow(/stream closed by upstream/)
    expect(spawner.spawns()).toBe(DEFAULT_PI_TURN_ATTEMPTS)
  })
})

describe('PiBackend', () => {
  it('preserves the provider response model and fingerprint in every emitted delta', async () => {
    const responseModel = 'deepseek-v4-flash@fp_a18b46594c_prod0820_fp8_kvcache_20260402'
    expect(piResponseIdentityFromEvent({
      type: 'message_start',
      message: {
        model: 'deepseek-v4-flash',
        responseModel,
      },
    })).toEqual({
      model: responseModel,
      systemFingerprint: 'fp_a18b46594c_prod0820_fp8_kvcache_20260402',
    })

    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'message_start',
          message: { model: 'deepseek-v4-flash', responseModel },
        },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'identified' } },
        {
          type: 'turn_end',
          message: {
            responseModel,
            usage: { input: 2, output: 1 },
          },
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/tangle-router/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'task' }],
      agent_profile: {
        harness: 'pi',
        model: { provider: 'tangle-router', default: 'deepseek-v4-flash' },
      },
    }, null, new AbortController().signal))

    expect(deltas.filter((delta) => delta.content)).toContainEqual({
      model: responseModel,
      system_fingerprint: 'fp_a18b46594c_prod0820_fp8_kvcache_20260402',
      content: 'identified',
    })
    expect(deltas.find((delta) => delta.usage)?.model).toBe(responseModel)
    expect(deltas.find((delta) => delta.profile_materialization)?.model).toBe(responseModel)
    expect(deltas.find((delta) => delta.profile_materialization)?.system_fingerprint)
      .toBe('fp_a18b46594c_prod0820_fp8_kvcache_20260402')
    expect(deltas.find((delta) => delta.finish_reason)?.model).toBe(responseModel)
  })

  it('accepts a profile default that already contains a nested provider model', () => {
    const request: ChatRequest = {
      model: 'pi/tangle-router/fireworks/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'task' }],
      agent_profile: {
        harness: 'pi',
        model: {
          provider: 'tangle-router',
          default: 'fireworks/deepseek-v4-flash',
          maxTotalOutputTokens: 131_072,
        },
      },
    }

    const identity = profileExecutionIdentity(request, null, 'pi', null)

    expect(identity).toMatchObject({
      provider: 'tangle-router',
      model: 'pi/tangle-router/fireworks/deepseek-v4-flash',
    })
    expect(request.agent_profile?.model?.maxTotalOutputTokens).toBe(131_072)
    expect(request.agent_profile?.model?.metadata).toBeUndefined()
    expect(Object.isFrozen(request.agent_profile)).toBe(true)
    expect(Object.isFrozen(request.agent_profile?.model)).toBe(true)
    expect(Object.isFrozen(request.agent_profile?.model?.metadata)).toBe(true)
  })

  it('applies one exact profile while leaving the task unchanged', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-exact-profile-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-exact-profile-agent-dir-'))
    const adapterDir = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    mkdirSync(adapterDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    const profile: NonNullable<ChatRequest['agent_profile']> = {
      prompt: { systemPrompt: 'SYSTEM_ONCE' },
      harness: 'pi',
      model: {
        provider: 'tangle-router',
        default: 'glm-5.2',
        reasoningEffort: 'ultracode',
      },
      mcp: {
        coordination: {
          transport: 'stdio',
          command: 'node',
          args: [pub('coordinator.mjs')],
          env: { RUN_ID: pub('exact-profile') },
        },
      },
    }
    let args: string[] = []
    let systemPrompt = ''
    let mcp: unknown
    let mcpConfigPath: string | undefined
    let directTools: string | undefined
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], (_bin, rawArgs, opts) => {
        args = [...rawArgs]
        const systemPromptPath = argValue(args, '--system-prompt')
        if (!systemPromptPath) throw new Error('missing native system prompt')
        systemPrompt = readFileSync(systemPromptPath, 'utf8')
        mcpConfigPath = argValue(args, '--mcp-config')
        if (!mcpConfigPath) throw new Error('missing request-scoped MCP config')
        mcp = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
        directTools = opts.env?.MCP_DIRECT_TOOLS
      }),
    })

    try {
      const request: ChatRequest = {
        model: 'pi/tangle-router/glm-5.2',
        messages: [{ role: 'user', content: 'TASK_UNCHANGED' }],
        cwd,
        agent_profile: profile,
      }
      await collect(backend.chat(request, null, new AbortController().signal))

      expect(args.filter((arg) => arg === '--system-prompt')).toHaveLength(1)
      expect(argValue(args, '--extension')).toBe(adapterDir)
      expect(args).toContain('--approve')
      expect(systemPrompt).toBe('SYSTEM_ONCE')
      expect(argValue(args, '--thinking')).toBe('xhigh')
      expect(profile.model?.reasoningEffort).toBe('ultracode')
      expect(args.at(-1)).toBe('TASK_UNCHANGED')
      expect(args.at(-1)).not.toContain('SYSTEM_ONCE')
      expect(directTools).toBe('coordination')
      expect(mcp).toEqual({
        mcpServers: {
          // Materialized servers carry `directTools: true` so pi registers their verbs as native
          // tools rather than hiding them behind the proxy's connect/describe discovery.
          coordination: {
            command: 'node',
            args: ['coordinator.mjs'],
            env: { RUN_ID: 'exact-profile' },
            directTools: true,
          },
        },
      })
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
      expect(mcpConfigPath && existsSync(mcpConfigPath)).toBe(false)
      expect(args).not.toContain('ultracode')
      expect(request.profile_materialization_receipt).toMatchObject({
        schema: 'cli-bridge.profile-materialization.v2',
        harness: 'pi',
        provider: 'tangle-router',
        model: 'pi/tangle-router/glm-5.2',
        reasoningEffort: { requested: 'ultracode', applied: 'xhigh' },
        inference: {
          effectiveEndpoint: 'http://127.0.0.1:9/v1',
          apiMode: 'openai-completions',
          transport: 'scoped-loopback',
        },
      })
      expect(request.profile_materialization_receipt?.effectiveProfileDigest)
        .toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'matching max_tokens', max_tokens: 16_384 },
    { name: 'older caller omission', max_tokens: undefined },
  ])('accepts a $name and records the profile cap once', async ({ max_tokens }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-max-tokens-equal-'))
    let resolves = 0
    let spawns = 0
    const transport = testPiInferenceTransport()
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      transportResolver: async (selection, signal) => {
        resolves += 1
        return transport(selection, signal)
      },
      spawner: piSpawner([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
        { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
      ], () => {
        spawns += 1
      }),
    })
    const request: ChatRequest = {
      model: 'pi/tangle-router/glm-5.2',
      messages: [{ role: 'user', content: 'task' }],
      ...(max_tokens === undefined ? {} : { max_tokens }),
      cwd,
      agent_profile: {
        harness: 'pi',
        model: {
          provider: 'tangle-router',
          default: 'glm-5.2',
          maxTotalOutputTokens: 16_384,
          metadata: { maxTokens: 16_384 },
        },
      },
    }

    try {
      await collect(backend.chat(request, null, new AbortController().signal))
      expect(resolves).toBe(1)
      expect(spawns).toBe(1)
      expect(request.profile_materialization_receipt?.inference).toMatchObject({
        appliedMaxTokens: 16_384,
      })
      expect(request.profile_materialization_receipt?.inference).not.toHaveProperty(
        'appliedMaxTotalOutputTokens',
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'lower request',
      max_tokens: 8_192,
      profile: {
        harness: 'pi' as const,
        model: {
          provider: 'tangle-router',
          default: 'glm-5.2',
          maxTotalOutputTokens: 16_384,
        },
      },
      code: 'parse_error' as const,
      error: /request max_tokens .*conflicts with agent_profile\.model\.maxTotalOutputTokens/u,
    },
    {
      name: 'higher request',
      max_tokens: 32_768,
      profile: {
        harness: 'pi' as const,
        model: {
          provider: 'tangle-router',
          default: 'glm-5.2',
          maxTotalOutputTokens: 16_384,
        },
      },
      code: 'parse_error' as const,
      error: /request max_tokens .*conflicts with agent_profile\.model\.maxTotalOutputTokens/u,
    },
    {
      name: 'profile total cap missing',
      max_tokens: 16_384,
      profile: {
        harness: 'pi' as const,
        model: { provider: 'tangle-router', default: 'glm-5.2' },
      },
      code: 'not_configured' as const,
      error: /agent_profile\.model\.maxTotalOutputTokens is absent/u,
    },
    {
      name: 'profile missing',
      max_tokens: 16_384,
      profile: undefined,
      code: 'not_configured' as const,
      error: /without an AgentProfile\.model\.maxTotalOutputTokens authority/u,
    },
  ])('refuses a $name before provider resolution or spawn', async ({
    max_tokens,
    profile,
    code,
    error,
  }) => {
    let resolves = 0
    let spawns = 0
    const transport = testPiInferenceTransport()
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      transportResolver: async (selection, signal) => {
        resolves += 1
        return transport(selection, signal)
      },
      spawner: piSpawner([], () => {
        spawns += 1
      }),
    })
    const request: ChatRequest = {
      model: 'pi/tangle-router/glm-5.2',
      messages: [{ role: 'user', content: 'task' }],
      max_tokens,
      ...(profile ? { agent_profile: profile } : {}),
    }

    const received = await collect(backend.chat(request, null, new AbortController().signal))
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(received).toBeInstanceOf(BackendError)
    expect((received as BackendError).code).toBe(code)
    expect(received).toMatchObject({ message: expect.stringMatching(error) })
    expect(resolves).toBe(0)
    expect(spawns).toBe(0)
  })

  it('refuses an incomplete Pi model id before resolving auth or spawning a child', async () => {
    let resolves = 0
    let spawns = 0
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      transportResolver: async () => {
        resolves += 1
        return await testPiInferenceTransport()(
          { provider: 'unused', model: 'unused' },
          new AbortController().signal,
        )
      },
      spawner: piSpawner([], () => { spawns += 1 }),
    })

    await expect(collect(backend.chat({
      model: 'pi/glm-5.2',
      messages: [{ role: 'user', content: 'task' }],
    }, null, new AbortController().signal))).rejects.toThrow(/explicit pi\/<provider>\/<model>/u)
    expect(resolves).toBe(0)
    expect(spawns).toBe(0)
  })

  it('refuses a failed isolated transport before spawning a Pi child', async () => {
    let spawns = 0
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      transportResolver: async () => {
        throw new BackendError('isolated transport unavailable', 'not_configured')
      },
      spawner: piSpawner([], () => { spawns += 1 }),
    })

    await expect(collect(backend.chat({
      model: 'pi/tangle-router/glm-5.2',
      messages: [{ role: 'user', content: 'task' }],
    }, null, new AbortController().signal))).rejects.toThrow(/isolated transport unavailable/u)
    expect(spawns).toBe(0)
  })

  it('refuses Docker before auth resolution instead of using mounted provider credentials', async () => {
    let resolves = 0
    let spawns = 0
    const spawner = piSpawner([], () => { spawns += 1 })
    spawner.executionEnvironment = 'docker'
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      transportResolver: async (selection, signal) => {
        resolves += 1
        return await testPiInferenceTransport()(selection, signal)
      },
      spawner,
    })

    await expect(collect(backend.chat({
      model: 'pi/tangle-router/glm-5.2',
      messages: [{ role: 'user', content: 'task' }],
    }, null, new AbortController().signal))).rejects.toThrow(/PI_EXECUTOR=host/u)
    expect(resolves).toBe(0)
    expect(spawns).toBe(0)
  })

  it('rejects a turn-level effort that conflicts with the exact profile', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-effort-conflict-'))
    let spawns = 0
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([], () => {
        spawns += 1
      }),
    })

    try {
      const run = collect(backend.chat({
        model: 'pi/tangle-router/glm-5.2',
        messages: [{ role: 'user', content: 'task' }],
        effort: 'low',
        cwd,
        agent_profile: { model: { reasoningEffort: 'high' } },
      }, null, new AbortController().signal))

      await expect(run).rejects.toThrow(/effort .* conflicts with agent_profile/u)
      expect(spawns).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'provider',
      model: 'pi/other-provider/glm-5.2',
      messages: [{ role: 'user' as const, content: 'task' }],
      profile: {
        harness: 'pi' as const,
        model: { provider: 'tangle-router', default: 'glm-5.2' },
      },
      error: /conflicts with agent_profile\.model/u,
    },
    {
      name: 'model',
      model: 'pi/tangle-router/other-model',
      messages: [{ role: 'user' as const, content: 'task' }],
      profile: {
        harness: 'pi' as const,
        model: { provider: 'tangle-router', default: 'glm-5.2' },
      },
      error: /conflicts with agent_profile\.model/u,
    },
    {
      name: 'harness',
      model: 'pi/tangle-router/glm-5.2',
      messages: [{ role: 'user' as const, content: 'task' }],
      profile: { harness: 'codex' as const },
      error: /agent_profile\.harness/u,
    },
    {
      name: 'system prompt overlay',
      model: 'pi/tangle-router/glm-5.2',
      messages: [
        { role: 'system' as const, content: 'second standing prompt' },
        { role: 'user' as const, content: 'task' },
      ],
      profile: { harness: 'pi' as const },
      error: /system-role messages cannot accompany agent_profile/u,
    },
  ])('refuses an exact-profile $name mismatch before spawn', async ({
    model,
    messages,
    profile,
    error,
  }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-identity-conflict-'))
    let spawns = 0
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([], () => { spawns += 1 }),
    })
    try {
      await expect(collect(backend.chat({
        model,
        messages,
        cwd,
        agent_profile: profile,
      }, null, new AbortController().signal))).rejects.toThrow(error)
      expect(spawns).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses request MCP beside an exact profile before spawn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-mcp-conflict-'))
    let spawns = 0
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([], () => { spawns += 1 }),
    })
    try {
      await expect(collect(backend.chat({
        model: 'pi/tangle-router/glm-5.2',
        messages: [{ role: 'user', content: 'task' }],
        cwd,
        agent_profile: { harness: 'pi' },
        mcp: {
          mcpServers: {
            bypass: { command: 'node', args: ['server.mjs'] },
          },
        },
      }, null, new AbortController().signal))).rejects.toThrow(
        /request mcp cannot accompany agent_profile/u,
      )
      expect(spawns).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

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
    const backend = newTestPiBackend({
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
        expect(entry.args).toContain('--approve')
        expect(entry.args).toContain('--no-context-files')
        expect(entry.args).toContain('--no-skills')
        expect(entry.args).toContain('--no-prompt-templates')
        expect(entry.args.at(-1)).toMatch(/^(?:ALPHA|BETA) task$/u)
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
    const backend = newTestPiBackend({
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
    const sourceSessionDir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-session-source-'))
    const sessions = new SessionStore(dataDir)
    const argv: string[][] = []
    const profilePrompts: Array<string | null> = []
    const profileRoots: string[] = []
    const backend = newTestPiBackend({
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
      transportResolver: testPiInferenceTransport({ sourceSessionDir }),
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
        model: {
          provider: 'zai-coding-paas',
          default: 'glm-5.2',
          maxTotalOutputTokens: 16_384,
          metadata: { maxTokens: 16_384 },
        },
      })).status).toBe(200)
      expect(argv[1]).not.toContain('--no-session')
      expect(argv[1]).not.toContain('--session')
      const createdSessionFlag = argv[1]?.indexOf('--session-id') ?? -1
      expect(createdSessionFlag).toBeGreaterThanOrEqual(0)
      expect(argv[1]?.[createdSessionFlag + 1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(sessions.get('discovery-run', 'pi')).toMatchObject({
        internalId: argValue(argv[1]!, '--session-id'),
        turns: 1,
        metadata: {
          agent_profile: {
            model: {
              maxTotalOutputTokens: 16_384,
              metadata: { maxTokens: 16_384 },
            },
          },
        },
      })

      expect((await post('discovery-run')).status).toBe(200)
      const sessionFlag = argv[2]?.indexOf('--session') ?? -1
      expect(argv[2]?.[sessionFlag + 1]).toBe(argValue(argv[1]!, '--session-id'))
      expect(argv[2]).not.toContain('--no-session')
      expect(profilePrompts).toEqual([
        null,
        'PERSISTED_PROFILE_SYSTEM',
        'PERSISTED_PROFILE_SYSTEM',
      ])

      expect((await post('rejected-profile', {
        model: {
          provider: 'zai-coding-paas',
          default: 'glm-5.2',
          metadata: { maxTokens: 16_384 },
        },
      })).status).toBe(501)
      expect(sessions.get('rejected-profile', 'pi')).toBeNull()

      const conflictingResume = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'pi/zai-coding-paas/glm-5-turbo',
          messages: [{ role: 'user', content: 'change the worker' }],
          stream: false,
          cwd,
          session_id: 'discovery-run',
          agent_profile: {
            prompt: { systemPrompt: 'DIFFERENT_PROFILE_SYSTEM' },
            model: { provider: 'zai-coding-paas', default: 'glm-5-turbo' },
          },
        }),
      })
      expect(conflictingResume.status).toBe(400)
      expect(argv).toHaveLength(3)
      expect(sessions.get('discovery-run', 'pi')?.metadata.agent_profile).toMatchObject({
        prompt: { systemPrompt: 'PERSISTED_PROFILE_SYSTEM' },
      })
      for (const root of profileRoots) expect(existsSync(root)).toBe(false)
    } finally {
      sessions.close()
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
      rmSync(sourceSessionDir, { recursive: true, force: true })
    }
  })

  it('keeps an interrupted first turn resumable with the exact Pi session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-interrupt-cwd-'))
    const sourceSessionDir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-interrupt-sessions-'))
    const argv: string[][] = []
    let resolveFirstSession: ((id: string) => void) | undefined
    const firstSession = new Promise<string>((resolve) => { resolveFirstSession = resolve })
    const spawner: Spawner = async (_bin, args): Promise<SpawnResult> => {
      argv.push([...args])
      const call = argv.length
      const child = new FakeChild()
      if (call === 1) {
        queueMicrotask(() => {
          const internalId = argValue(args, '--session-id')
          if (!internalId) throw new Error('first Pi call did not receive --session-id')
          child.stdout.write(`${JSON.stringify({ type: 'session', id: internalId })}\n`)

          // Native Pi appends the user message as soon as message_end fires.
          // The assistant message is deliberately absent because this turn is interrupted.
          const sessionDir = argValue(args, '--session-dir')
          if (!sessionDir) throw new Error('first Pi call did not receive --session-dir')
          const sessionFile = readdirSync(sessionDir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(sessionDir, name))
            .find((path) => readFileSync(path, 'utf8').includes(`"id":"${internalId}"`))
          if (!sessionFile) throw new Error('bridge did not reserve the Pi session before spawn')
          appendFileSync(sessionFile, `${JSON.stringify({
            type: 'message',
            id: 'first-user-entry',
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: args.at(-1),
              timestamp: Date.now(),
            },
          })}\n`)
          resolveFirstSession?.(internalId)
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

      const internalId = argValue(args, '--session')
      queueMicrotask(() => {
        if (!internalId) throw new Error('resume Pi call did not receive --session')
        child.stdout.write(`${JSON.stringify({ type: 'session', id: internalId })}\n`)
        child.stdout.write(`${JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'second instruction executed' },
        })}\n`)
        child.stdout.write(`${JSON.stringify({ type: 'turn_end', message: { usage: { input: 2, output: 1 } } })}\n`)
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0)
      })
      return {
        child: child as never,
        release() {},
        spawnError: () => null,
      }
    }
    spawner.executionEnvironment = 'test-double'
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner,
      transportResolver: testPiInferenceTransport({ sourceSessionDir }),
    })
    const firstRequest: ChatRequest = {
      model: 'pi/isolated-test/credential-check',
      messages: [{ role: 'user', content: 'first instruction must survive interruption' }],
      cwd,
      session_id: 'interrupt-resume-regression',
    }
    const controller = new AbortController()

    try {
      const firstRun = collect(backend.chat(firstRequest, null, controller.signal))
      const internalId = await firstSession
      controller.abort()
      const firstDeltas = await firstRun
      expect(firstDeltas.at(-1)?.finish_reason).toBe('error')

      const sessionDir = argValue(argv[0]!, '--session-dir')!
      const sessionFile = readdirSync(sessionDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => join(sessionDir, name))
        .find((path) => readFileSync(path, 'utf8').includes(`"id":"${internalId}"`))
      expect(sessionFile).toBeTruthy()
      const persisted = readFileSync(sessionFile!, 'utf8')
      expect(persisted).toContain(`"id":"${internalId}"`)
      expect(persisted).toContain('first instruction must survive interruption')
      expect(persisted).not.toContain('assistant')

      const resumed = await collect(backend.chat({
        ...firstRequest,
        messages: [{ role: 'user', content: 'second instruction' }],
      }, {
        externalId: 'interrupt-resume-regression',
        backend: 'pi',
        internalId,
        cwd,
        turns: 1,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        metadata: {},
      }, new AbortController().signal))

      expect(argValue(argv[1]!, '--session')).toBe(internalId)
      expect(resumed.find((delta) => delta.internal_session_id)?.internal_session_id).toBe(internalId)
      expect(resumed.some((delta) => delta.content === 'second instruction executed')).toBe(true)
      expect(resumed.at(-1)?.finish_reason).toBe('stop')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(sourceSessionDir, { recursive: true, force: true })
    }
  })

  it('does not change project-approval behavior for a call without an exact profile', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-no-profile-approval-'))
    let args: string[] = []
    try {
      const backend = newTestPiBackend({
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
      }, null, new AbortController().signal))

      expect(args).not.toContain('--approve')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('yields thinking as a reasoning delta before the text it produced, never as content', async () => {
    const backend = newTestPiBackend({
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
      { reasoning: 'hidden reasoning must not become assistant text' },
      { content: 'pi' },
      { content: '-ok' },
      { usage: { input_tokens: 8417, fresh_input_tokens: 8417, output_tokens: 30 } },
      { finish_reason: 'stop' },
    ])
  })

  it('coalesces thinking deltas and flushes before the next non-thinking yield', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-1' },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'first ' } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thought' } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'second thought' } },
        { type: 'turn_end', message: { usage: { input: 4, output: 2 } } },
        { type: 'agent_end' },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/moonshot/kimi-k2.6',
      messages: [{ role: 'user', content: 'work' }],
    }, null, new AbortController().signal))

    // One reasoning delta per buffered run, flushed before the next
    // non-thinking yield so ordering against content and usage is exact.
    expect(deltas).toEqual([
      { internal_session_id: 'pi-session-1' },
      { reasoning: 'first thought' },
      { content: 'answer' },
      { reasoning: 'second thought' },
      { usage: { input_tokens: 4, fresh_input_tokens: 4, output_tokens: 2 } },
      { finish_reason: 'stop' },
    ])
  })

  it('flushes buffered reasoning at the size bound instead of growing one giant delta', async () => {
    const chunk = 'r'.repeat(200)
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-1' },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: chunk } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: chunk } },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'tail' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
        { type: 'turn_end', message: { usage: { input: 4, output: 2 } } },
        { type: 'agent_end' },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/moonshot/kimi-k2.6',
      messages: [{ role: 'user', content: 'work' }],
    }, null, new AbortController().signal))

    // 200 + 200 chars crosses the 256-char bound and flushes as one delta;
    // the remainder flushes when the text delta arrives.
    expect(deltas).toEqual([
      { internal_session_id: 'pi-session-1' },
      { reasoning: chunk + chunk },
      { reasoning: 'tail' },
      { content: 'done' },
      { usage: { input_tokens: 4, fresh_input_tokens: 4, output_tokens: 2 } },
      { finish_reason: 'stop' },
    ])
  })

  it('streams every model call including cache traffic and reports complete nested cost once', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'turn_end',
          message: {
            usage: {
              input: 100,
              output: 20,
              cacheRead: 900,
              cacheWrite: 30,
              cost: { total: 0.003 },
            },
          },
        },
        {
          type: 'turn_end',
          message: {
            usage: {
              input: 240,
              output: 35,
              cacheRead: 1_700,
              cacheWrite: 50,
              cost: { total: 0.002 },
            },
          },
        },
        {
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              usage: {
                input: 100,
                output: 20,
                cacheRead: 900,
                cacheWrite: 30,
                cost: { total: 0.003 },
              },
            },
            {
              role: 'assistant',
              usage: {
                input: 240,
                output: 35,
                cacheRead: 1_700,
                cacheWrite: 50,
                cost: { total: 0.002 },
              },
            },
          ],
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'use a tool, then answer' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      {
        usage: {
          input_tokens: 1_030,
          fresh_input_tokens: 100,
          cache_read_input_tokens: 900,
          cache_write_input_tokens: 30,
          output_tokens: 20,
        },
      },
      {
        usage: {
          input_tokens: 1_990,
          fresh_input_tokens: 240,
          cache_read_input_tokens: 1_700,
          cache_write_input_tokens: 50,
          output_tokens: 35,
        },
      },
      {
        usage: {
          estimated_cost: 0.005,
          cost_known: false,
          cost_provenance: 'catalog-estimate',
          cost_scope: 'total',
        },
      },
      { finish_reason: 'stop' },
    ])
    // Pi's own dollar figure is a local catalog number. Neither Pi nor the proxy
    // reports billed dollars, so no delta may present one as a receipt.
    for (const delta of deltas) {
      expect(delta.usage?.cost_known).not.toBe(true)
      expect(delta.usage?.cost).toBeUndefined()
    }
  })

  it('streams agent_end messages as the legacy fallback when turn receipts are absent', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              usage: {
                input: 19,
                output: 7,
                cacheRead: 80,
                cacheWrite: 4,
                cost: { total: 0.001 },
              },
            },
            { role: 'toolResult', content: [] },
            {
              role: 'assistant',
              usage: {
                input: 23,
                output: 9,
                cacheRead: 100,
                cacheWrite: 5,
                cost: { total: 0.002 },
              },
            },
          ],
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'answer' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      {
        usage: {
          input_tokens: 103,
          fresh_input_tokens: 19,
          cache_read_input_tokens: 80,
          cache_write_input_tokens: 4,
          output_tokens: 7,
        },
      },
      {
        usage: {
          input_tokens: 128,
          fresh_input_tokens: 23,
          cache_read_input_tokens: 100,
          cache_write_input_tokens: 5,
          output_tokens: 9,
        },
      },
      {
        usage: {
          estimated_cost: 0.003,
          cost_known: false,
          cost_provenance: 'catalog-estimate',
          cost_scope: 'total',
        },
      },
      { finish_reason: 'stop' },
    ])
  })

  it('omits aggregate cost when any contributing model call has unknown cost', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'turn_end',
          message: { usage: { input: 10, output: 2, cost: { total: 0.001 } } },
        },
        {
          type: 'turn_end',
          message: { usage: { input: 20, output: 3 } },
        },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'answer twice' }],
    }, null, new AbortController().signal))

    expect(deltas).toEqual([
      { usage: { input_tokens: 10, fresh_input_tokens: 10, output_tokens: 2 } },
      { usage: { input_tokens: 20, fresh_input_tokens: 20, output_tokens: 3 } },
      { finish_reason: 'stop' },
    ])
  })

  it('accounts for Google countTokens separately from generation usage receipts', async () => {
    const upstreamPaths: string[] = []
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before responding so the proxy records a settled exchange.
      }
      upstreamPaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await listenTestServer(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

    const spawner: Spawner = async (_bin, _args, opts): Promise<SpawnResult> => {
      const child = new FakeChild()
      queueMicrotask(() => {
        void (async () => {
          try {
            const agentDir = opts.env?.PI_CODING_AGENT_DIR
            if (!agentDir) throw new Error('missing request Pi config')
            const config = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as {
              providers: Record<string, { baseUrl: string; apiKey: string }>
            }
            const provider = Object.values(config.providers)[0]
            if (!provider) throw new Error('missing request provider')
            for (const action of ['streamGenerateContent', 'countTokens']) {
              const response = await fetch(
                `${provider.baseUrl}/models/credential-check:${action}?key=${encodeURIComponent(provider.apiKey)}`,
                { method: 'POST', body: '{}' },
              )
              if (!response.ok) throw new Error(`proxy returned ${response.status}`)
            }
            child.stdout.write(`${JSON.stringify({
              type: 'turn_end',
              message: {
                usage: {
                  input: 10,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
              },
            })}\n`)
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0)
          } catch (error) {
            child.stderr.end(error instanceof Error ? error.message : String(error))
            child.stdout.end()
            child.exitCode = 1
            child.emit('close', 1)
          }
        })()
      })
      return {
        child: child as never,
        release() {},
        spawnError: () => null,
      }
    }
    spawner.executionEnvironment = 'test-double'

    try {
      const backend = newTestPiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner,
        transportResolver: testPiInferenceTransport({
          upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1beta`,
          apiMode: 'google-generative-ai',
          upstreamApiKey: 'google-upstream-key',
          providerConfig: { api: 'google-generative-ai' },
          modelConfig: {
            id: 'credential-check',
            api: 'google-generative-ai',
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        }),
      })
      const request: ChatRequest = {
        model: 'pi/google-test/credential-check',
        messages: [{ role: 'user', content: 'count, then answer' }],
        agent_profile: {
          harness: 'pi',
          model: { provider: 'google-test', default: 'credential-check' },
        },
      }
      const deltas = await collect(backend.chat(request, null, new AbortController().signal))

      expect(upstreamPaths).toEqual([
        '/v1beta/models/credential-check:streamGenerateContent?key=google-upstream-key',
        '/v1beta/models/credential-check:countTokens?key=google-upstream-key',
      ])
      expect(deltas).toContainEqual({ usage: { model_requests: 2, cost_known: false } })
      const completed = deltas.findLast(
        (delta) => delta.profile_materialization?.inference?.observation !== undefined,
      )?.profile_materialization
      expect(completed?.inference?.observation).toMatchObject({
        requests: 2,
        generationRequests: 1,
        auxiliaryRequests: 1,
        usageReceipts: 1,
        rejectedRequests: 0,
        failedRequests: 0,
        inFlightRequests: 0,
        accountingMatched: true,
      })
      expect(request.profile_materialization_receipt).toEqual(completed)
    } finally {
      await closeTestServer(upstream)
    }
  })

  it('preserves completed model-call usage when the outer run is cancelled', async () => {
    const controller = new AbortController()
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: pausingPiSpawner([
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
        },
        {
          type: 'turn_end',
          message: {
            usage: {
              input: 80,
              output: 12,
              cacheRead: 320,
              cacheWrite: 8,
              cost: { total: 0.004 },
            },
          },
        },
      ]),
    })
    const iterator = backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'keep working' }],
    }, null, controller.signal)[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value).toEqual({ content: 'partial' })
    const second = await iterator.next()
    expect(second.value).toEqual({
      usage: {
        input_tokens: 408,
        fresh_input_tokens: 80,
        cache_read_input_tokens: 320,
        cache_write_input_tokens: 8,
        output_tokens: 12,
      },
    })
    const pending = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const tail: ChatDelta[] = []
    const afterAbort = await pending
    if (!afterAbort.done) tail.push(afterAbort.value)
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      tail.push(next.value)
    }

    expect(tail).toEqual([
      {
        usage: {
          estimated_cost: 0.004,
          cost_known: false,
          cost_provenance: 'catalog-estimate',
          cost_scope: 'total',
        },
      },
      { finish_reason: 'error' },
    ])
  })

  it('rejects invalid Pi token counts instead of recording them as zero', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'turn_end',
          message: { usage: { input: -1, output: 2 } },
        },
      ]),
    })

    await expect(collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'answer' }],
    }, null, new AbortController().signal))).rejects.toThrow(
      'pi reported invalid input token count',
    )
  })

  // Captured from pi 0.83.0 against a provider that answers 401: pi exits 0, emits no
  // `error` event and no `error` field, and reports the failure only on the assistant
  // message. Read off the wire with:
  //   PI_CODING_AGENT_DIR=<dir> pi --print --mode json --provider probe --model probe-model \
  //     --no-session "say hi"
  const piProviderFailureTurnEnd = {
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'probe',
      model: 'probe-model',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'error',
      timestamp: 1785566141560,
      errorMessage: '401: {"message":"probe: invalid api key","type":"invalid_request_error"}',
    },
    toolResults: [],
  }

  it('fails the request when pi reports a provider failure on the assistant turn', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-err' },
        { type: 'agent_start' },
        { type: 'turn_start' },
        piProviderFailureTurnEnd,
        { type: 'agent_end' },
        { type: 'agent_settled' },
      ]),
    })

    const run = collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'say hi' }],
    }, null, new AbortController().signal))

    await expect(run).rejects.toThrowError(BackendError)
    await expect(run).rejects.toThrow(/pi assistant turn failed/u)
    await expect(run).rejects.toThrow(/invalid api key/u)
    // A 401 from the provider is a credential problem, not a transient upstream blip.
    await run.catch((err: BackendError) => {
      expect(err.code).toBe('not_configured')
    })
  })

  it('fails a truncated turn: partial text streamed before the provider failure is not success', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-trunc' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial ' },
        },
        {
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial ' }],
            usage: { input: 12, output: 3 },
            stopReason: 'error',
            errorMessage: '529 overloaded_error: Overloaded',
          },
        },
        { type: 'agent_end' },
      ]),
    })

    const run = collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'write an essay' }],
    }, null, new AbortController().signal))

    await expect(run).rejects.toThrow(/pi assistant turn failed.*Overloaded/su)
    await run.catch((err: BackendError) => {
      expect(err.code).toBe('upstream')
    })
  })

  it('fails on a bare errorMessage even when stopReason is absent', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        {
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [],
            usage: { input: 1, output: 0 },
            errorMessage: 'context_length_exceeded: request too large',
          },
        },
        { type: 'agent_end' },
      ]),
    })

    await expect(collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'answer' }],
    }, null, new AbortController().signal))).rejects.toThrow(/context_length_exceeded/u)
  })

  it('does not fail a run whose failed turn pi retried successfully', async () => {
    const backend = newTestPiBackend({
      bin: 'pi',
      timeoutMs: 1000,
      spawner: piSpawner([
        { type: 'session', id: 'pi-session-retry' },
        piProviderFailureTurnEnd,
        {
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          errorMessage: '401: transient',
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
        },
        {
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input: 10, output: 2 },
            stopReason: 'stop',
          },
        },
        { type: 'auto_retry_end', success: true, attempt: 1 },
        { type: 'agent_end' },
      ]),
    })

    const deltas = await collect(backend.chat({
      model: 'pi/tangle-router/gpt-5-mini',
      messages: [{ role: 'user', content: 'say hi' }],
    }, null, new AbortController().signal))

    expect(deltas).toContainEqual({ content: 'hi' })
    expect(deltas.at(-1)).toEqual({ finish_reason: 'stop' })
  })

  it('surfaces pi assistantMessageEvent tool_call_start as OpenAI tool_calls', async () => {
    const backend = newTestPiBackend({
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
      { usage: { input_tokens: 20, fresh_input_tokens: 20, output_tokens: 8 } },
      { finish_reason: 'tool_calls' },
    ])
  })

  it('surfaces real pi toolcall_end frames nested under assistantMessageEvent.partial.content', async () => {
    const backend = newTestPiBackend({
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
      { usage: { input_tokens: 31, fresh_input_tokens: 31, output_tokens: 12 } },
      { finish_reason: 'tool_calls' },
    ])
  })

  it('surfaces real pi tool_execution_start events as OpenAI tool_calls', async () => {
    const backend = newTestPiBackend({
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
      { usage: { input_tokens: 10, fresh_input_tokens: 10, output_tokens: 5 } },
      { finish_reason: 'tool_calls' },
    ])
  })

  it('surfaces pi nested tool_call_request events once', async () => {
    const backend = newTestPiBackend({
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
      { usage: { input_tokens: 10, fresh_input_tokens: 10, output_tokens: 5 } },
      { finish_reason: 'tool_calls' },
    ])
  })

  it('also accepts prompt_tokens/completion_tokens usage from partial.usage', async () => {
    const backend = newTestPiBackend({
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

  it('passes request MCP servers through a request-scoped --mcp-config file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-test-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-mcp-agent-dir-'))
    const adapterDir = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    mkdirSync(adapterDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      let argsAtSpawn: string[] = []
      let configAtSpawn: unknown = null
      let configPathAtSpawn: string | undefined
      let cwdAtSpawn: string | undefined
      let directToolsAtSpawn: string | undefined
      const backend = newTestPiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner(
          [
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
            { type: 'turn_end', message: { usage: { input: 5, output: 2 } } },
          ],
          (_bin, args, opts) => {
            argsAtSpawn = [...args]
            cwdAtSpawn = opts.cwd
            const flagIndex = args.indexOf('--mcp-config')
            expect(flagIndex).toBeGreaterThanOrEqual(0)
            configPathAtSpawn = args[flagIndex + 1]
            expect(configPathAtSpawn).toBeTruthy()
            configAtSpawn = JSON.parse(readFileSync(configPathAtSpawn!, 'utf-8'))
            directToolsAtSpawn = opts.env?.MCP_DIRECT_TOOLS
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

      // Pi keeps the shared task cwd while receiving private control config.
      expect(cwdAtSpawn).toBe(cwd)
      expect(argsAtSpawn).toContain('--no-extensions')
      expect(argValue(argsAtSpawn, '--extension')).toBe(adapterDir)
      expect(configPathAtSpawn?.startsWith(join(cwd, '.cli-bridge-pi-mcp-'))).toBe(true)
      expect(directToolsAtSpawn).toBe('legal-tools')
      expect(configAtSpawn).toEqual({
        mcpServers: {
          'legal-tools': {
            command: 'tsx',
            args: ['proposal-server.ts'],
            env: { CASE_ID: 'c-1' },
            directTools: true,
          },
        },
      })
      expect(deltas.slice(-2)).toEqual([
        { usage: { input_tokens: 5, fresh_input_tokens: 5, output_tokens: 2 } },
        { finish_reason: 'stop' },
      ])
      expect(configPathAtSpawn && existsSync(configPathAtSpawn)).toBe(false)
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(cwd, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it('runs two MCP-enabled Pi requests concurrently in one cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-overlap-'))
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-mcp-overlap-agent-dir-'))
    const adapterDir = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    mkdirSync(adapterDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    const configPaths: string[] = []
    const configs: unknown[] = []
    const children: FakeChild[] = []
    let bothConfigsExistedTogether = false
    const spawner: Spawner = async (_bin, args): Promise<SpawnResult> => {
      const configPath = argValue(args, '--mcp-config')
      if (!configPath) throw new Error('missing request-scoped MCP config')
      configPaths.push(configPath)
      configs.push(JSON.parse(readFileSync(configPath, 'utf8')))
      const child = new FakeChild()
      children.push(child)
      if (children.length === 2) {
        bothConfigsExistedTogether = configPaths.every((path) => existsSync(path))
        setTimeout(() => {
          for (const running of children) {
            running.stdout.write(`${JSON.stringify({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
            })}\n`)
            running.stdout.write(`${JSON.stringify({
              type: 'turn_end',
              message: { usage: { input: 2, output: 1 } },
            })}\n`)
            running.stdout.end()
            running.stderr.end()
            running.exitCode = 0
            running.emit('close', 0)
          }
        }, 0)
      }
      return {
        child: child as never,
        release() {},
        spawnError: () => null,
      }
    }
    const backend = newTestPiBackend({ bin: 'pi', timeoutMs: 1000, spawner })

    try {
      const request = (name: string): ChatRequest => ({
        model: 'pi/tangle-router/deepseek-v4-flash',
        messages: [{ role: 'user', content: `run ${name}` }],
        cwd,
        mcp: { mcpServers: { [name]: { command: `${name}-server` } } },
      })
      const [alpha, beta] = await Promise.all([
        collect(backend.chat(request('alpha'), null, new AbortController().signal)),
        collect(backend.chat(request('beta'), null, new AbortController().signal)),
      ])

      expect(alpha.at(-1)).toEqual({ finish_reason: 'stop' })
      expect(beta.at(-1)).toEqual({ finish_reason: 'stop' })
      expect(configPaths).toHaveLength(2)
      expect(new Set(configPaths).size).toBe(2)
      expect(bothConfigsExistedTogether).toBe(true)
      expect(configs).toEqual(expect.arrayContaining([
        { mcpServers: { alpha: { command: 'alpha-server', directTools: true } } },
        { mcpServers: { beta: { command: 'beta-server', directTools: true } } },
      ]))
      expect(configPaths.every((path) => !existsSync(path))).toBe(true)
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects MCP requests loudly when pi-mcp-adapter is not installed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-mcp-test-'))
    const previousOverride = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '0'
    try {
      let spawnCount = 0
      const backend = newTestPiBackend({
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
      let mcpConfigFlagAtSpawn: string | undefined
      const backend = newTestPiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner(
          [
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
            { type: 'turn_end', message: { usage: { input: 3, output: 1 } } },
          ],
          (_bin, args) => { mcpConfigFlagAtSpawn = argValue(args, '--mcp-config') },
        ),
      })

      const deltas = await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        cwd,
      }, null, new AbortController().signal))

      expect(mcpConfigFlagAtSpawn).toBeUndefined()
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
      expect(deltas.slice(-2)).toEqual([
        { usage: { input_tokens: 3, fresh_input_tokens: 3, output_tokens: 1 } },
        { finish_reason: 'stop' },
      ])
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = previousOverride
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('an EMPTY extension list means load nothing — the complete-isolation request', async () => {
    // This is the shape a paired experiment depends on, and the reason it has to be pinned:
    // an installed extension that persists memory across runs (pi-memory) carries arm A's state
    // into arm B, and nothing anywhere reports that it happened. `extensions.pi.load: []` is the
    // caller's declarative way to say "no ambient extensions", and it must keep meaning that.
    //
    // The regression it guards is silent by construction. Treating an empty list as "absent"
    // is the natural-looking simplification — `load?.length ? [...] : []` reads fine — and it
    // restores ambient extension discovery without failing a single request. Pinned alongside
    // the three isolation flags that materializing ANY profile already applies, because a caller
    // reasoning about run isolation needs all four to hold together.
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-extension-none-'))
    let args: string[] = []
    try {
      const backend = newTestPiBackend({
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
          name: 'isolated-worker',
          extensions: { pi: { load: [] } },
        },
      }, null, new AbortController().signal))

      expect(args).toContain('--no-extensions')
      expect(args).not.toContain('--extension')
      expect(args).toContain('--approve')
      expect(args).toContain('--no-context-files')
      expect(args).toContain('--no-skills')
      expect(args).toContain('--no-prompt-templates')
    } finally {
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

      const backend = newTestPiBackend({
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

  it('exposes an exact extension to a read-confined run without copying ambient Pi credentials', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-jailed-extension-'))
    const jailRoot = join(cwd, '.agent-home')
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-profile-custom-agent-dir-'))
    const packageDir = join(agentDir, 'npm', 'node_modules', 'pi-zai-glm')
    const extensionDir = join(packageDir, 'extensions')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    let args: string[] = []
    let jail: ChatRequest['jailSpec']
    let jailedSessionDir: string | undefined
    let spawnedSessionDir: string | undefined
    let spawnedAgentDir: string | undefined
    try {
      mkdirSync(extensionDir, { recursive: true })
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: 'pi-zai-glm', pi: { extensions: ['./extensions'] } }),
      )
      writeFileSync(join(extensionDir, 'provider.ts'), 'export default () => undefined\n')
      process.env.PI_CODING_AGENT_DIR = agentDir
      delete process.env.PI_CODING_AGENT_SESSION_DIR
      const authSources = authSourcesFor('pi')

      const backend = newTestPiBackend({
        bin: 'pi',
        timeoutMs: 1000,
        spawner: piSpawner([
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
          { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
        ], (_bin, rawArgs, opts) => {
          args = [...rawArgs]
          jail = opts.jail
          jailedSessionDir = opts.jail?.environment?.PI_CODING_AGENT_SESSION_DIR
          spawnedSessionDir = opts.env?.PI_CODING_AGENT_SESSION_DIR
          spawnedAgentDir = opts.env?.PI_CODING_AGENT_DIR
        }),
      })
      await collect(backend.chat({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'work' }],
        cwd,
        jailSpec: {
          root: jailRoot,
          projectDir: cwd,
          readConfine: true,
          authSources,
        },
        agent_profile: { extensions: { pi: { load: ['pi-zai-glm'] } } },
      }, null, new AbortController().signal))

      expect(argValue(args, '--extension')).toBe(packageDir)
      expect(jail?.authSources).toEqual([])
      expect(jail?.argumentRewrites).toBeUndefined()
      expect(jail?.extraReadablePaths).toContain(join(agentDir, 'npm', 'node_modules'))
      expect(jailedSessionDir).toBeUndefined()
      expect(spawnedSessionDir).toBeUndefined()
      expect(spawnedAgentDir).toBeTruthy()
      expect(argValue(args, '--session-dir')).toBe(join(spawnedAgentDir!, 'sessions'))
      expect(jail?.extraWritablePaths).toEqual(expect.arrayContaining([
        spawnedAgentDir,
        join(spawnedAgentDir!, 'sessions'),
      ]))
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
      rmSync(cwd, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  it('fails before spawn when Pi-specific extension controls are unknown', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-profile-extension-unknown-'))
    let spawns = 0
    try {
      const backend = newTestPiBackend({
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
      const backend = newTestPiBackend({
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
    const backend = newTestPiBackend({
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

async function listenTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
}

async function closeTestServer(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
}
