import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, afterAll, afterEach, expect, it } from 'vitest'
import type { SessionRecord } from '../src/sessions/store.js'
import { CodexBackend } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

// Plain Router mode reads env at chat time; keep ambient operator settings out of every fixture.
const SAVED_ROUTER_URL = process.env.TANGLE_ROUTER_URL
const SAVED_API_KEY = process.env.TANGLE_API_KEY
delete process.env.TANGLE_ROUTER_URL
delete process.env.TANGLE_API_KEY
afterAll(() => {
  if (SAVED_ROUTER_URL === undefined) delete process.env.TANGLE_ROUTER_URL
  else process.env.TANGLE_ROUTER_URL = SAVED_ROUTER_URL
  if (SAVED_API_KEY === undefined) delete process.env.TANGLE_API_KEY
  else process.env.TANGLE_API_KEY = SAVED_API_KEY
})

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

// Captured native event shapes retained for the session/resume boundary checks.
// Real-process tool translation lives in harness-terminal.integration.test.ts.
const THREAD = { type: 'thread.started', thread_id: '019f3889-c05e-70c3-ae9f-3077da9454c4' }
const MESSAGE_ITEM = {
  type: 'item.completed',
  item: { id: 'item_4', type: 'agent_message', text: 'done' },
}
const TURN_DONE = {
  type: 'turn.completed',
  usage: { input_tokens: 45929, output_tokens: 103 },
}

describe('CodexBackend tool-call translation', () => {
  it('passes cancellation through a delayed spawn before any model start', async () => {
    const controller = new AbortController()
    let enterSpawn!: () => void
    let resumeSpawn!: () => void
    const entered = new Promise<void>((resolve) => { enterSpawn = resolve })
    const gate = new Promise<void>((resolve) => { resumeSpawn = resolve })
    let modelStarts = 0
    const spawner: Spawner = async (_bin, _args, opts) => {
      enterSpawn()
      await gate
      if (opts.signal?.aborted) throw new Error('cancelled before model start')
      modelStarts += 1
      return codexSpawner([TURN_DONE])(_bin, _args, opts)
    }
    const backend = new CodexBackend({ bin: 'codex', timeoutMs: 0, spawner })
    const run = collect(backend.chat(request(), null, controller.signal))
    await entered
    controller.abort()
    resumeSpawn()
    await expect(run).rejects.toThrow('cancelled before model start')
    expect(modelStarts).toBe(0)
  })

  it('kills a late child from a spawner that ignored cancellation and never reports stop', async () => {
    const controller = new AbortController()
    let enterSpawn!: () => void
    let resumeSpawn!: () => void
    const entered = new Promise<void>((resolve) => { enterSpawn = resolve })
    const gate = new Promise<void>((resolve) => { resumeSpawn = resolve })
    let terminations = 0
    let releases = 0
    const spawner: Spawner = async () => {
      enterSpawn()
      await gate
      return {
        child: new FakeChild() as never,
        release: () => { releases += 1 },
        terminate: async () => { terminations += 1 },
      }
    }
    const backend = new CodexBackend({ bin: 'codex', timeoutMs: 0, spawner })
    const received: ChatDelta[] = []
    const run = (async () => {
      for await (const delta of backend.chat(request(), null, controller.signal)) received.push(delta)
    })()
    await entered
    controller.abort()
    resumeSpawn()
    await expect(run).rejects.toMatchObject({ code: 'aborted' })
    expect(terminations).toBe(1)
    expect(releases).toBe(1)
    expect(received.some((delta) => delta.finish_reason === 'stop')).toBe(false)
  })

  it('keeps legacy no-MCP sessions on their original home and refuses a context-losing MCP migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-legacy-session-'))
    const observed: { args?: string[] } = {}
    let dispatches = 0
    const spawner: Spawner = async (bin, args, opts) => {
      dispatches++
      expect(opts.env?.CODEX_HOME).toBe(process.env.CODEX_HOME)
      return codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed)(bin, args, opts)
    }
    const backend = new CodexBackend({ bin: 'codex', timeoutMs: 0, stateDir: root, spawner })
    const session: SessionRecord = { externalId: 'legacy', backend: 'codex', internalId: THREAD.thread_id, cwd: null, turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} }
    try {
      await collect(backend.chat({ ...request(), session_id: 'legacy' }, session, new AbortController().signal))
      expect(observed.args).toContain('resume')
      const withMcp: ChatRequest = { ...request(), session_id: 'legacy', runtime_attachments: { mcp: { coordination: { url: 'http://127.0.0.1:1001/mcp' } } } }
      await expect(collect(backend.chat(withMcp, session, new AbortController().signal))).rejects.toThrow('no retained native home')
      expect(dispatches).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('maps the recorded cache split onto the usage receipt (issue #208)', async () => {
    // Captured shape from a sandbox child's turn.completed (2026-09-09):
    // 81% of the prompt served from cache; dropped before this fix, so every
    // bridge Codex turn reached Runtime with cacheBreakdownKnown: false and
    // the cached prefix was charged in full.
    const cachedTurn = {
      type: 'turn.completed',
      usage: {
        input_tokens: 317_069,
        cached_input_tokens: 257_024,
        cache_write_input_tokens: 0,
        output_tokens: 3_190,
        reasoning_output_tokens: 883,
      },
    }
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, cachedTurn]),
    })
    const deltas = await collect(backend.chat(request(), null, new AbortController().signal))
    const usage = deltas.find((d) => d.usage)?.usage
    expect(usage).toMatchObject({
      input_tokens: 317_069,
      fresh_input_tokens: 60_045,
      cache_read_input_tokens: 257_024,
      cache_write_input_tokens: 0,
      output_tokens: 3_190,
      reasoning_output_tokens: 883,
    })
  })

  it('emits no cache class codex did not report', async () => {
    const uncachedTurn = {
      type: 'turn.completed',
      usage: { input_tokens: 1_000, output_tokens: 50 },
    }
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, uncachedTurn]),
    })
    const deltas = await collect(backend.chat(request(), null, new AbortController().signal))
    const usage = deltas.find((d) => d.usage)?.usage
    expect(usage).toMatchObject({ input_tokens: 1_000, output_tokens: 50 })
    expect(usage).not.toHaveProperty('cache_read_input_tokens')
    expect(usage).not.toHaveProperty('fresh_input_tokens')
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

describe('CodexBackend jailed MCP visibility', () => {
  it('registers the synthetic CODEX_HOME as a writable access-only seed so a confined codex reads its MCP config', async () => {
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
    const sourceHome = mkdtempSync(join(tmpdir(), 'codex-jail-auth-source-'))
    const previousHome = process.env.CODEX_HOME
    const previousAccess = process.env.CODEX_ACCESS_TOKEN
    const previousApiKey = process.env.CODEX_API_KEY
    const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`
    writeFileSync(join(sourceHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { account_id: 'fixture-account', id_token: 'fixture-id', access_token: accessToken, refresh_token: 'fixture-refresh' },
      last_refresh: new Date().toISOString(),
      OPENAI_API_KEY: 'fixture-extra-secret',
    }), { mode: 0o600 })
    process.env.CODEX_HOME = sourceHome
    delete process.env.CODEX_ACCESS_TOKEN
    delete process.env.CODEX_API_KEY
    let seededConfig: string | null = null
    let seededAuth: Record<string, unknown> | null = null
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    const inner = codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE])
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: async (bin, args, opts) => {
        spawnedEnv = opts.env
        const source = (jailSpec.authSources ?? []).find((s) => s.envVar === 'CODEX_HOME')?.source
        if (source) {
          seededConfig = readFileSync(join(source, 'config.toml'), 'utf8')
          seededAuth = JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8')) as Record<string, unknown>
        }
        return inner(bin, args, opts)
      },
    })
    try {
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
      expect(seededAuth).toMatchObject({ auth_mode: 'chatgpt', tokens: { account_id: 'fixture-account', refresh_token: '' } })
      expect(seededAuth).not.toHaveProperty('OPENAI_API_KEY')
      expect(spawnedEnv?.CODEX_ACCESS_TOKEN).toBeUndefined()
      expect(spawnedEnv?.CODEX_API_KEY).toBeUndefined()
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousHome
      if (previousAccess === undefined) delete process.env.CODEX_ACCESS_TOKEN
      else process.env.CODEX_ACCESS_TOKEN = previousAccess
      if (previousApiKey === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = previousApiKey
      rmSync(sourceHome, { recursive: true, force: true })
    }
  })
})

describe('CodexBackend plain Router mode', () => {
  afterEach(() => {
    delete process.env.TANGLE_ROUTER_URL
    delete process.env.TANGLE_API_KEY
  })

  it('carries the Router provider table for a provider-qualified model', async () => {
    process.env.TANGLE_ROUTER_URL = 'http://127.0.0.9:9/v1'
    process.env.TANGLE_API_KEY = 'dummy'
    const observed: { args?: string[] } = {}
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    const inner = codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed)
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: async (bin, args, opts) => {
        spawnedEnv = opts.env
        return inner(bin, args, opts)
      },
    })
    const deltas = await collect(backend.chat({ ...request(), model: 'codex/zai/glm-5.3' }, null, new AbortController().signal))
    expect(deltas.find((d) => d.finish_reason)?.finish_reason).toBe('stop')
    expect(observed.args).toContain(
      'model_providers.zai = { name = "Tangle Router", base_url = "http://127.0.0.9:9/v1", env_key = "TANGLE_API_KEY", wire_api = "chat", requires_openai_auth = false }',
    )
    expect(observed.args).toContain('model_provider = "zai"')
    // The Router authorizes the full slug; a bare id answers 400 model_not_allowed.
    expect(observed.args).toContain('model = "zai/glm-5.3"')
    expect(observed.args).not.toContain('model = "glm-5.3"')
    // codex reads the key itself through the table's env_key, so the spawn env must carry it.
    expect(spawnedEnv?.TANGLE_API_KEY).toBe('dummy')
  })

  it('splits the wire provider segment into model_provider + model config without a Router URL', async () => {
    delete process.env.TANGLE_ROUTER_URL
    delete process.env.TANGLE_API_KEY
    const observed: { args?: string[] } = {}
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed),
    })
    await collect(backend.chat({ ...request(), model: 'codex/zai/glm-5.3' }, null, new AbortController().signal))
    expect(observed.args).toContain('model_provider="zai"')
    expect(observed.args).toContain('model="glm-5.3"')
    expect(observed.args?.some((arg) => arg.startsWith('model_providers.'))).toBe(false)
  })

  it('stays on the bare split when only the API key is set', async () => {
    delete process.env.TANGLE_ROUTER_URL
    process.env.TANGLE_API_KEY = 'dummy'
    const observed: { args?: string[] } = {}
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed),
    })
    await collect(backend.chat({ ...request(), model: 'codex/zai/glm-5.3' }, null, new AbortController().signal))
    expect(observed.args).toContain('model_provider="zai"')
    expect(observed.args).toContain('model="glm-5.3"')
    expect(observed.args?.some((arg) => arg.startsWith('model_providers.'))).toBe(false)
  })

  it('refuses a malformed Router URL before any spawn', async () => {
    process.env.TANGLE_ROUTER_URL = 'http://user:secret@127.0.0.9:9/v1#frag'
    process.env.TANGLE_API_KEY = 'dummy'
    const observed: { args?: string[] } = {}
    let dispatches = 0
    const inner = codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE], observed)
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: async (bin, args, opts) => {
        dispatches += 1
        return inner(bin, args, opts)
      },
    })
    await expect(collect(backend.chat({ ...request(), model: 'codex/zai/glm-5.3' }, null, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'not_configured' })
    process.env.TANGLE_ROUTER_URL = 'not-a-url'
    await expect(collect(backend.chat({ ...request(), model: 'codex/zai/glm-5.3' }, null, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'not_configured' })
    expect(dispatches).toBe(0)
  })

  it('refuses a model without a wire provider segment, including the harness prefix', async () => {
    process.env.TANGLE_ROUTER_URL = 'http://127.0.0.9:9/v1'
    process.env.TANGLE_API_KEY = 'dummy'
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 5_000,
      spawner: codexSpawner([THREAD, MESSAGE_ITEM, TURN_DONE]),
    })
    // No '/' after the harness prefix: the Router would see a bare model id.
    await expect(collect(backend.chat({ ...request(), model: 'codex/glm-5.3' }, null, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'not_configured' })
    await expect(collect(backend.chat(request(), null, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'not_configured' })
    // A leading `codex` segment names the harness (issue #161), never a provider.
    await expect(collect(backend.chat({ ...request(), model: 'codex/codex/gpt-5.1' }, null, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'not_configured' })
  })
})
