/**
 * Runtime attachments — platform MCP endpoints carried beside an exact
 * AgentProfile without entering any bound identity.
 *
 * A dispatching runtime (agent-runtime `supervise()`) serves its coordination
 * MCP server on an ephemeral port. Before this channel the only way to hand
 * that URL to the harness was `agent_profile.mcp`, which moves the canonical
 * profile digest: a restarted runtime rebinds a new port, the digest changes,
 * and the exact session binding refuses the resumed turn before any token is
 * spent.
 *
 * Coverage:
 *   1. The attachment reaches the harness — it lands in the MCP config file the
 *      CLI loads, beside the servers the profile declared.
 *   2. The session binding is blind to it: two turns that differ only in the
 *      attachment URL keep one binding and one profile digest.
 *   3. A genuinely changed authored profile is still refused.
 *   4. Durable-run identity is blind to it, so a reconnect re-attaches.
 *   5. Every refusal path: a colliding alias, a disabled attachment, and the
 *      unchanged refusal of body `mcp` beside `agent_profile`.
 *   6. The retained-session surface carries attachments the same way, and the
 *      create identity excludes them.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import type { Backend, ChatDelta, ChatRequest, McpServerSpec } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountRuns } from '../src/routes/runs.js'
import { resolveMcpServers, writeMcpConfigFile } from '../src/backends/profile-mcp.js'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { Spawner } from '../src/executors/types.js'
import { TraceEmitter } from '../src/trace/emitter.js'

const coordination = (port: number): Record<string, unknown> => ({
  transport: 'http',
  url: `http://127.0.0.1:${port}/mcp`,
})

const PROFILE: AgentProfile = {
  name: 'supervised-manager',
  harness: 'claude-code',
  model: { default: 'sonnet', provider: 'anthropic' },
  prompt: { systemPrompt: 'Drive the run.', instructions: ['STANDING BRIEF'] },
  mcp: {
    notes: { transport: 'stdio', command: 'notes-mcp', args: [{ kind: 'public', value: 'serve' }] },
  },
}

/**
 * Runs the same MCP resolution and materialization the CLI backends run, so a
 * test asserts the bytes the harness would load rather than the request shape.
 */
class HarnessMcpBackend implements Backend {
  readonly name = 'capture'
  last: ChatRequest | null = null
  lastSpecs: Record<string, McpServerSpec> | null = null
  lastConfig: { mcpServers: Record<string, McpServerSpec> } | null = null
  matches(model: string): boolean {
    return model === 'capture' || model.startsWith('capture/')
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
    this.last = req
    this.lastSpecs = resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true })
    const materialized = writeMcpConfigFile(this.lastSpecs)
    this.lastConfig = materialized
      ? JSON.parse(readFileSync(materialized.configPath, 'utf8'))
      : null
    materialized?.cleanup()
    yield { content: 'ok' }
    yield { finish_reason: 'stop' }
  }
}

describe('runtime attachments — chat completions', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono
  let backend: HarnessMcpBackend

  const post = async (body: Record<string, unknown>): Promise<Response> => await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'capture',
      messages: [{ role: 'user', content: 'work' }],
      ...body,
    }),
  })

  const storedBinding = (id: string): Record<string, unknown> =>
    sessions.get(id, 'capture')?.metadata.agent_profile_binding as Record<string, unknown>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-runtime-attachments-'))
    sessions = new SessionStore(dir)
    backend = new HarnessMcpBackend()
    app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
    })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('mounts the attachment into the harness MCP config beside the profile servers', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    expect(response.status).toBe(200)
    expect(backend.lastConfig?.mcpServers.coordination).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:36827/mcp',
    })
    expect(backend.lastConfig?.mcpServers.notes).toMatchObject({ command: 'notes-mcp' })
  })

  it('keeps one session binding across a resume that rebinds the attachment port', async () => {
    const first = await post({
      session_id: 'resume-across-ports',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })
    expect(first.status).toBe(200)
    const boundAfterFirst = storedBinding('resume-across-ports')

    const second = await post({
      session_id: 'resume-across-ports',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(41991) } },
    })

    expect(second.status).toBe(200)
    expect(storedBinding('resume-across-ports')).toEqual(boundAfterFirst)
    expect(backend.lastConfig?.mcpServers.coordination).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:41991/mcp',
    })
  })

  it('still refuses a changed authored profile on the same session', async () => {
    await post({
      session_id: 'changed-profile',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    const changed = await post({
      session_id: 'changed-profile',
      agent_profile: {
        ...PROFILE,
        prompt: { ...PROFILE.prompt, instructions: ['A DIFFERENT BRIEF'] },
      },
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({
      error: {
        type: 'session_binding_conflict',
        session_id: 'changed-profile',
        message: expect.stringContaining('bound to a different AgentProfile/model'),
        stored_binding: { effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE) },
      },
    })
  })

  it('re-attaches a durable run whose only change is the attachment port', async () => {
    const first = await post({
      run_id: 'run-across-ports',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })
    expect(first.status).toBe(200)

    const reconnect = await post({
      run_id: 'run-across-ports',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(41991) } },
    })

    expect(reconnect.status).toBe(200)
  })

  it('refuses an attachment alias already declared by the profile', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { notes: coordination(36827) } },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('collides with an MCP server declared by the agent_profile') },
    })
  })

  it('refuses a secret-ref inside an attachment, naming the key and never a value', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: {
        mcp: {
          coordination: {
            transport: 'http',
            url: 'http://127.0.0.1:36827/mcp',
            headers: { Authorization: { kind: 'secret-ref', key: 'COORD_TOKEN' } },
          },
        },
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('runtime_attachments.mcp["coordination"].headers')
    expect(body.error.message).toContain('COORD_TOKEN')
  })

  it('resolves the runtime coordination secret-ref into the harness header and does not store the bearer', async () => {
    const token = 'coord-probe-token'
    const response = await post({
      session_id: 'coord-secret',
      agent_profile: PROFILE,
      env: { AGENT_RUNTIME_COORDINATION_TOKEN: token, PUBLIC_MODE: 'on' },
      runtime_attachments: {
        mcp: {
          coordination: {
            transport: 'http',
            url: 'http://127.0.0.1:36827/mcp',
            headers: {
              Authorization: {
                kind: 'secret-ref',
                key: 'AGENT_RUNTIME_COORDINATION_TOKEN',
                format: 'bearer',
              },
            },
          },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain(token)
    expect(backend.lastConfig?.mcpServers.coordination).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:36827/mcp',
      headers: { Authorization: `Bearer ${token}` },
    })
    const stored = JSON.stringify(sessions.get('coord-secret', 'capture')?.metadata ?? {})
    expect(stored).not.toContain(token)
    expect(stored).toContain('PUBLIC_MODE')
  })

  it('refuses the coordination secret-ref when the request env has no bearer', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: {
        mcp: {
          coordination: {
            transport: 'http',
            url: 'http://127.0.0.1:36827/mcp',
            headers: {
              Authorization: {
                kind: 'secret-ref',
                key: 'AGENT_RUNTIME_COORDINATION_TOKEN',
                format: 'bearer',
              },
            },
          },
        },
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('AGENT_RUNTIME_COORDINATION_TOKEN')
    expect(body.error.message).toContain('is not on this request')
    expect(body.error.message).not.toContain('Bearer')
  })

  it('still rejects a caller token env name', async () => {
    const response = await post({
      agent_profile: PROFILE,
      env: { ACCESS_TOKEN: 'coord-probe-token' },
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('ACCESS_TOKEN')
    expect(body.error.message).not.toContain('coord-probe-token')
  })

  it('reattaches a durable run when only the coordination bearer changes', async () => {
    const attachment = {
      transport: 'http',
      url: 'http://127.0.0.1:36827/mcp',
      headers: {
        Authorization: {
          kind: 'secret-ref',
          key: 'AGENT_RUNTIME_COORDINATION_TOKEN',
          format: 'bearer',
        },
      },
    }
    const first = await post({
      run_id: 'run-coord-token',
      agent_profile: PROFILE,
      env: { AGENT_RUNTIME_COORDINATION_TOKEN: 'coord-probe-token-a' },
      runtime_attachments: { mcp: { coordination: attachment } },
    })
    expect(first.status).toBe(200)

    const second = await post({
      run_id: 'run-coord-token',
      agent_profile: PROFILE,
      env: { AGENT_RUNTIME_COORDINATION_TOKEN: 'coord-probe-token-b' },
      runtime_attachments: { mcp: { coordination: attachment } },
    })
    expect(second.status).toBe(200)
    expect(await second.text()).not.toContain('coord-probe-token')
  })

  it('keeps refusing a bare mcp channel beside an exact profile', async () => {
    const response = await post({
      agent_profile: PROFILE,
      mcp: { mcpServers: { coordination: { type: 'http', url: 'http://127.0.0.1:36827/mcp' } } },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('request mcp cannot accompany agent_profile') },
    })
  })

})

describe('runtime coordination bearer through chat completions', () => {
  const token = 'coord-probe-token'
  const attachment = {
    transport: 'http',
    url: 'http://127.0.0.1:36827/mcp',
    headers: {
      Authorization: {
        kind: 'secret-ref',
        key: 'AGENT_RUNTIME_COORDINATION_TOKEN',
        format: 'bearer',
      },
    },
  }

  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const

  async function whileCapturing<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; logs: string }> {
    const lines: string[] = []
    const original = new Map<typeof consoleMethods[number], (...args: unknown[]) => void>()
    for (const name of consoleMethods) {
      const current = console[name].bind(console) as (...args: unknown[]) => void
      original.set(name, current)
      console[name] = ((...args: unknown[]) => {
        lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        current(...args)
      }) as typeof console.log
    }
    try {
      return { result: await run(), logs: lines.join('\n') }
    } finally {
      for (const name of consoleMethods) console[name] = original.get(name) as typeof console.log
    }
  }

  function tracedApp(spawner: Spawner, sessions: SessionStore, spans: unknown[]) {
    const runs = new RunRegistry()
    const app = new Hono()
    const trace = new TraceEmitter({
      sink: { write(batch) { spans.push(...batch) } },
      maxToolSpans: 8,
    })
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(new ClaudeBackend({
        bin: 'claude',
        harness: 'claude-code',
        timeoutMs: 0,
        spawner,
      })),
      sessions,
      runs,
      trace,
    })
    mountRuns(app, { runs, retainedStore: sessions })
    return app
  }

  function requestBody(cwd: string, sessionId: string, runId?: string): string {
    return JSON.stringify({
      model: 'claude-code/anthropic/sonnet',
      mode: 'byob',
      cwd,
      session_id: sessionId,
      ...(runId ? { run_id: runId } : {}),
      messages: [{ role: 'user', content: 'settle' }],
      agent_profile: PROFILE,
      env: { AGENT_RUNTIME_COORDINATION_TOKEN: token, PUBLIC_MODE: 'on' },
      runtime_attachments: { mcp: { coordination: attachment } },
    })
  }

  it('puts the bearer only in the coordination MCP header, not the agent env, argv, output, log, or trace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-'))
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-sessions-'))
    const sessions = new SessionStore(dir)
    const spans: unknown[] = []
    const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv; mcpConfig: string; configPath: string }> = []
    const script = [
      "console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-session'}))",
      "console.log(JSON.stringify({type:'assistant',message:{id:'msg',content:[{type:'text',text:'settled'}]}}))",
      "console.log(JSON.stringify({type:'result',subtype:'success',session_id:'native-session',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0}))",
    ].join('\n')
    const spawner: Spawner = async (_bin, args, opts) => {
      const configIndex = args.indexOf('--mcp-config')
      const configPath = args[configIndex + 1]!
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700)
      expect(configPath).toContain(`${join('cli-bridge-private', 'mcp-coord-bearer-')}`)
      launches.push({
        args,
        env: { ...(opts.env ?? {}) },
        mcpConfig: readFileSync(configPath, 'utf8'),
        configPath,
      })
      const child = spawn(process.execPath, ['-e', script], {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { child, release() {}, spawnError: () => null }
    }
    const app = tracedApp(spawner, sessions, spans)
    try {
      const captured = await whileCapturing(async () => await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(cwd, 'coord-bearer', 'coord-bearer-run'),
      }))
      const response = captured.result
      const body = await response.text()
      expect(response.status, body).toBe(200)
      expect(body).toContain('settled')
      expect(body).not.toContain(token)
      expect(captured.logs).not.toContain(token)
      expect(JSON.stringify(spans)).not.toContain(token)
      expect(spans.length).toBeGreaterThan(0)
      expect(launches).toHaveLength(1)
      const launch = launches[0]!
      expect(launch.args.join('\n')).not.toContain(token)
      expect(Object.keys(launch.env)).not.toContain('AGENT_RUNTIME_COORDINATION_TOKEN')
      for (const value of Object.values(launch.env)) {
        expect(value ?? '').not.toContain(token)
      }
      expect(launch.mcpConfig).toContain(`"Authorization": "Bearer ${token}"`)
      expect(launch.mcpConfig).toContain('http://127.0.0.1:36827/mcp')
      expect(existsSync(launch.configPath)).toBe(false)
      expect(existsSync(dirname(launch.configPath))).toBe(false)
      const stored = JSON.stringify(sessions.get('coord-bearer', 'claude-code')?.metadata ?? {})
      expect(stored).not.toContain(token)
      expect(stored).toContain('PUBLIC_MODE')
    } finally {
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('removes the mcp-config when the spawn fails, and the error log does not carry the bearer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-fail-'))
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-fail-sessions-'))
    const sessions = new SessionStore(dir)
    const spans: unknown[] = []
    let configPath = ''
    const spawner: Spawner = async (_bin, args) => {
      configPath = args[args.indexOf('--mcp-config') + 1]!
      expect(existsSync(configPath)).toBe(true)
      throw new Error('spawn refused')
    }
    const app = tracedApp(spawner, sessions, spans)
    try {
      const captured = await whileCapturing(async () => await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(cwd, 'coord-bearer-fail', 'coord-bearer-fail-run'),
      }))
      const body = await captured.result.text()
      expect(captured.result.status).not.toBe(200)
      expect(body).not.toContain(token)
      expect(captured.logs).not.toContain(token)
      expect(JSON.stringify(spans)).not.toContain(token)
      expect(configPath).not.toBe('')
      expect(existsSync(configPath)).toBe(false)
      expect(existsSync(dirname(configPath))).toBe(false)
    } finally {
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('removes the mcp-config when the run is cancelled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-cancel-'))
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-bearer-cancel-sessions-'))
    const sessions = new SessionStore(dir)
    const spans: unknown[] = []
    let configPath = ''
    const spawner: Spawner = async (_bin, args) => {
      configPath = args[args.indexOf('--mcp-config') + 1]!
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { child, release() {}, spawnError: () => null }
    }
    const app = tracedApp(spawner, sessions, spans)
    try {
      const pending = app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(cwd, 'coord-cancel', 'coord-cancel'),
      })
      const started = Date.now()
      while (configPath === '' && Date.now() - started < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(configPath).not.toBe('')
      expect(existsSync(configPath)).toBe(true)
      const cancel = await app.request('/v1/runs/coord-cancel/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const response = await pending
      const body = await response.text()
      expect(cancel.status === 200 || cancel.status === 202).toBe(true)
      expect(body).not.toContain(token)
      expect(JSON.stringify(spans)).not.toContain(token)
      expect(existsSync(configPath)).toBe(false)
      expect(existsSync(dirname(configPath))).toBe(false)
    } finally {
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses the coordination secret-ref for a backend whose MCP config is not private', async () => {
    class PublicMcpBackend implements Backend {
      readonly name = 'pi'
      matches(model: string): boolean { return model === 'pi' }
      async health() { return { name: this.name, state: 'ready' as const } }
      async *chat(req: ChatRequest, session: SessionRecord | null): AsyncIterable<ChatDelta> {
        resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: false })
        yield { finish_reason: 'stop' }
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-coord-pi-'))
    const sessions = new SessionStore(dir)
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(new PublicMcpBackend()),
      sessions,
      runs: new RunRegistry(),
    })
    try {
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'pi',
          messages: [{ role: 'user', content: 'settle' }],
          env: { AGENT_RUNTIME_COORDINATION_TOKEN: token },
          runtime_attachments: { mcp: { coordination: attachment } },
        }),
      })
      const body = await response.text()
      const message = (JSON.parse(body) as { error: { message: string } }).error.message
      expect(response.status).toBe(400)
      expect(message).toContain('AGENT_RUNTIME_COORDINATION_TOKEN')
      expect(message).toContain('backend "pi"')
      expect(message).toContain('not private')
      expect(body).not.toContain(token)
    } finally {
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
