/**
 * Real-binary proof of the explicit text-inference contract on backend
 * opencode: a request that carries `tool_choice: "none"` must reach the
 * provider with ZERO tools (standard semantics — no model tool calls at all,
 * ambient action tools and caller-bound MCP servers alike), an ordinary
 * request keeps its native coding tools and its bound MCP callback, and the
 * native agent-wildcard boundary holds against inherited configuration.
 *
 * Native fact this battery is bound to (measured against opencode 1.18.30
 * with a local OpenAI-compatible recording server): a turn run with
 * `--agent <fresh name>` whose agent is declared
 * `agent[name] = { mode: "primary", permission: { "*": "deny" } }` in the
 * final `OPENCODE_CONFIG_CONTENT` layer carries zero tools on the wire — the
 * resolver appends the agent-specific wildcard after the global and agent
 * defaults and checks every tool id, ambient and MCP alike. Verified with a
 * provider configured by the PROJECT layer, MCP servers in the project
 * config and the operator's global JSONC config, and hostile `"*": "allow"`
 * entries in the global permission map and `agent.build.permission`: tools
 * visible on ordinary turns, zero on the isolated turn, tools restored, all
 * runs completing through their own provider.
 *
 * Every case drives the installed `opencode` through OpencodeBackend against
 * a disposable local recording server with redirected XDG homes: no paid
 * provider, no credentials, invented input only. Skipped when the binary is
 * absent, and by CLI_BRIDGE_SKIP_REAL_OPENCODE=1.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { hostSpawner } from '../src/executors/host.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const ENABLED = existsSync(BIN) && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'

/** The ambient action tools the stock runner puts on the wire. */
const AMBIENT_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task', 'todowrite', 'webfetch', 'write']

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** Minimal stdio MCP server exposing one read-only callback tool. */
const MCP_TRACE_SERVER = `
import { createInterface } from 'node:readline'
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trace', version: '0' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'trace_callback', description: 'Record one trace entry', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } }] } })
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'recorded' }] } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
})
`

interface Recorded {
  auth: string
  tools: string[]
}

describe.skipIf(!ENABLED)('a real opencode text-only tool-surface turn', () => {
  let server: Server
  let baseURL: string
  const scratch = mkdtempSync(join(tmpdir(), 'opencode-textonly-real-'))
  const saved = { ...process.env }
  const recorded: Recorded[] = []
  let mcpServerPath: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (data: Buffer) => { body += data.toString('utf8') })
      req.on('end', () => {
        const request = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> }
        recorded.push({
          auth: String(req.headers.authorization ?? ''),
          tools: (request.tools ?? []).map((tool) => String(tool.function?.name ?? '')),
        })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([
          chunk({ role: 'assistant', content: 'A textual plan, no host action.' }),
          chunk({}, 'stop'),
        ]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    mcpServerPath = join(scratch, 'mcp-trace.mjs')
    writeFileSync(mcpServerPath, MCP_TRACE_SERVER)
  })

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(scratch, 'config', 'opencode'), { recursive: true, force: true })
  })

  function providerConfig(id: string, extra: Record<string, unknown> = {}): string {
    process.env.XDG_CONFIG_HOME = join(scratch, 'config')
    process.env.XDG_DATA_HOME = join(scratch, 'data')
    process.env.XDG_CACHE_HOME = join(scratch, 'cache')
    process.env.XDG_STATE_HOME = join(scratch, 'state')
    const apiKey = `key-${id}`
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        [id]: {
          npm: '@ai-sdk/openai-compatible',
          name: id,
          options: { baseURL, apiKey },
          models: { m: { name: 'm', tool_call: true } },
        },
      },
      ...extra,
    })
    return apiKey
  }

  /** No final-layer content at all: the provider must come from the project layer. */
  function projectProviderOnly(): string {
    process.env.XDG_CONFIG_HOME = join(scratch, 'config')
    process.env.XDG_DATA_HOME = join(scratch, 'data')
    process.env.XDG_CACHE_HOME = join(scratch, 'cache')
    process.env.XDG_STATE_HOME = join(scratch, 'state')
    delete process.env.OPENCODE_CONFIG_CONTENT
    return 'key-project-provider'
  }

  /** The operator's global opencode config — JSONC is legal here. */
  function operatorGlobalConfig(value: string): void {
    const dir = join(process.env.XDG_CONFIG_HOME!, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.jsonc'), value)
  }

  /** Recursive listing of a directory tree: names, sizes, contents of small files. */
  function tree(dir: string): Map<string, string> {
    const out = new Map<string, string>()
    const walk = (rel: string): void => {
      const abs = join(dir, rel)
      for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) { out.set(relPath, 'dir'); walk(relPath); continue }
        const info = statSync(join(abs, entry.name))
        out.set(relPath, info.size <= 4096 ? readFileSync(join(abs, entry.name), 'utf8') : `size:${info.size}`)
      }
    }
    walk('')
    return out
  }

  /**
   * The cwd is unchanged by the turn: no new files, AGENTS.md byte-identical,
   * and opencode.json equal as JSON — modulo the `$schema` key opencode itself
   * stamps onto a project config it reads.
   */
  function assertCwdUnchanged(cwd: string, projectConfig: string): void {
    const listing = tree(cwd)
    expect([...listing.keys()].sort()).toEqual(['AGENTS.md', 'opencode.json'])
    expect(listing.get('AGENTS.md')).toBe('# unrelated bystander\nnothing to do here\n')
    const stripSchema = (raw: string): Record<string, unknown> => {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      delete parsed.$schema
      return parsed
    }
    expect(stripSchema(listing.get('opencode.json')!)).toEqual(stripSchema(projectConfig))
  }

  interface TurnOptions {
    request: ChatRequest
    projectConfig: unknown
    session?: SessionRecord | null
  }

  async function turn({ request, projectConfig, session = null }: TurnOptions): Promise<ChatDelta[]> {
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 90_000, spawner: hostSpawner })
    const cwd = mkdtempSync(join(scratch, 'cwd-'))
    // The bait the observer incident named: an unrelated AGENTS.md the model
    // tried to edit with its ambient tool, plus a project-layer config —
    // which may carry the PROVIDER itself and its own MCP server, and must
    // keep working on a text-only turn.
    writeFileSync(join(cwd, 'AGENTS.md'), '# unrelated bystander\nnothing to do here\n')
    const projectJson = JSON.stringify(projectConfig)
    writeFileSync(join(cwd, 'opencode.json'), projectJson)
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat({ cwd, mode: 'byob', ...request }, session, new AbortController().signal)) {
      deltas.push(delta)
    }
    assertCwdUnchanged(cwd, projectJson)
    return deltas
  }

  const finish = (deltas: ChatDelta[]): string | undefined => deltas.at(-1)?.finish_reason
  const forKey = (apiKey: string): Recorded[] => recorded.filter((entry) => entry.auth.includes(apiKey))
  const ambientOn = (entry: Recorded): string[] => entry.tools.filter((name) => AMBIENT_TOOLS.includes(name))
  const projectMcp = (): Record<string, unknown> => ({
    mcp: { projectcb: { type: 'local', command: ['node', mcpServerPath], enabled: true } },
  })
  const projectProvider = (apiKey: string): Record<string, unknown> => ({
    provider: {
      project: {
        npm: '@ai-sdk/openai-compatible',
        name: 'project',
        options: { baseURL, apiKey },
        models: { m: { name: 'm', tool_call: true } },
      },
    },
  })

  it('keeps an ordinary request on its native coding tools and project MCP, completing normally', async () => {
    const key = providerConfig('probe-ordinary')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-ordinary/m',
        session_id: 'text-ordinary',
        messages: [{ role: 'user', content: 'Write a textual plan and the Python for the analysis callback.' }],
      },
    })

    const own = forKey(key)
    const answers = own.filter((entry) => entry.tools.length > 0)
    expect(answers.length).toBeGreaterThanOrEqual(1)
    for (const tool of ['bash', 'edit', 'read', 'write', 'grep', 'glob']) {
      expect(answers[0]!.tools).toContain(tool)
    }
    expect(answers[0]!.tools).toContain('projectcb_trace_callback')
    expect(finish(deltas)).toBe('stop')
    expect(deltas.some((delta) => delta.content === 'A textual plan, no host action.')).toBe(true)
    expect(deltas.some((delta) => delta.tool_calls)).toBe(false)
  }, 120_000)

  it('sends the model a request with zero tools when explicitly requested', async () => {
    const key = providerConfig('probe-textonly')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-textonly/m',
        session_id: 'text-only',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan and the Python for the analysis callback.' }],
      },
    })

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
    expect(deltas.some((delta) => delta.content === 'A textual plan, no host action.')).toBe(true)
    expect(deltas.some((delta) => delta.tool_calls)).toBe(false)
  }, 120_000)

  it('keeps a project-configured provider working on a text-only turn with no final-layer content', async () => {
    const key = projectProviderOnly()
    recorded.length = 0

    const deltas = await turn({
      projectConfig: { ...projectProvider(key), ...projectMcp() },
      request: {
        model: 'opencode/project/m',
        session_id: 'text-project-provider',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
      },
    })

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
    expect(deltas.some((delta) => delta.content === 'A textual plan, no host action.')).toBe(true)
  }, 120_000)

  it('holds zero tools against a legal global JSONC config, its MCP server, and hostile wildcard allows', async () => {
    const key = providerConfig('probe-wildcard')
    operatorGlobalConfig([
      '// operator global config, legal JSONC',
      '{',
      `  "mcp": { "globalcb": { "type": "local", "command": ["node", "${mcpServerPath}"], "enabled": true } },`,
      '  "permission": { "*": "allow" },',
      '  "agent": { "build": { "permission": { "*": "allow" } } }',
      '}',
    ].join('\n'))
    recorded.length = 0

    // Ordinary control: the global MCP server and every ambient tool are visible.
    await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-wildcard/m',
        session_id: 'text-wildcard-ordinary',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
      },
    })
    const ordinary = forKey(key).filter((entry) => entry.tools.length > 0)
    expect(ordinary.length).toBeGreaterThanOrEqual(1)
    expect(ordinary[0]!.tools).toContain('globalcb_trace_callback')
    expect(ordinary[0]!.tools).toContain('projectcb_trace_callback')
    expect(ambientOn(ordinary[0]!).length).toBe(AMBIENT_TOOLS.length)

    // Isolated turn: zero tools despite the project MCP, the global JSONC MCP,
    // and the "*" allows in both the global permission map and agent.build.
    recorded.length = 0
    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-wildcard/m',
        session_id: 'text-wildcard-none',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
      },
    })
    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')

    // Restored: the next ordinary turn sees its tools again.
    recorded.length = 0
    await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-wildcard/m',
        session_id: 'text-wildcard-restored',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
      },
    })
    const restored = forKey(key).filter((entry) => entry.tools.length > 0)
    expect(restored.length).toBeGreaterThanOrEqual(1)
    expect(ambientOn(restored[0]!).length).toBe(AMBIENT_TOOLS.length)
  }, 240_000)

  it('suppresses a deliberately attached MCP tool under none: zero visible tools', async () => {
    const key = providerConfig('probe-mcp-none')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-mcp-none/m',
        session_id: 'text-mcp-none',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan and the Python for the analysis callback.' }],
        mcp: { mcpServers: { tracecb: { type: 'stdio', command: 'node', args: [mcpServerPath] } } },
      },
    })

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
    expect(deltas.some((delta) => delta.content === 'A textual plan, no host action.')).toBe(true)
  }, 120_000)

  it('keeps the same bound callback available with policy omitted (positive control)', async () => {
    const key = providerConfig('probe-mcp-auto')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-mcp-auto/m',
        session_id: 'text-mcp-auto',
        messages: [{ role: 'user', content: 'Write a textual plan and the Python for the analysis callback.' }],
        mcp: { mcpServers: { tracecb: { type: 'stdio', command: 'node', args: [mcpServerPath] } } },
      },
    })

    const own = forKey(key)
    const withTools = own.filter((entry) => entry.tools.length > 0)
    expect(withTools.length).toBeGreaterThanOrEqual(1)
    expect(withTools[0]!.tools).toContain('tracecb_trace_callback')
    expect(ambientOn(withTools[0]!).length).toBeGreaterThan(0)
    expect(finish(deltas)).toBe('stop')
  }, 120_000)

  it('wins over a profile that allows tools', async () => {
    const key = providerConfig('probe-profiled')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-profiled/m',
        session_id: 'text-profiled',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
        agent_profile: {
          name: 'allowed-worker',
          harness: 'opencode',
          prompt: { instructions: ['Answer briefly.'] },
          permissions: { bash: 'allow', edit: 'allow', read: 'allow', write: 'allow' },
          tools: { bash: true, edit: true, read: true, write: true },
        },
      } as ChatRequest,
    })

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
  }, 120_000)

  it('keeps a profiled ordinary turn on its native tools', async () => {
    const key = providerConfig('probe-profiled-ordinary')
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-profiled-ordinary/m',
        session_id: 'text-profiled-ordinary',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
        agent_profile: {
          name: 'allowed-worker',
          harness: 'opencode',
          prompt: { instructions: ['Answer briefly.'] },
        },
      } as ChatRequest,
    })

    const own = forKey(key)
    const withTools = own.filter((entry) => entry.tools.length > 0)
    expect(withTools.length).toBeGreaterThanOrEqual(1)
    expect(withTools[0]!.tools).toContain('bash')
    expect(withTools[0]!.tools).toContain('edit')
    expect(finish(deltas)).toBe('stop')
  }, 120_000)

  it('wins over ambient operator allows and an agent-layer tools map', async () => {
    const key = providerConfig('probe-ambient', {
      permission: { bash: 'allow', edit: 'allow', read: 'allow', write: 'allow', webfetch: 'allow', task: 'allow' },
      tools: { bash: true, edit: true, read: true, write: true },
      agent: { build: { tools: {
        bash: true, edit: true, glob: true, grep: true, read: true, list: true,
        skill: true, task: true, todowrite: true, webfetch: true, write: true,
      } } },
    })
    recorded.length = 0

    const deltas = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-ambient/m',
        session_id: 'text-ambient',
        toolChoice: 'none',
        messages: [{ role: 'user', content: 'Write a textual plan.' }],
      },
    })

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools, `request carried ${entry.tools.join(', ') || '(none)'}`).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
  }, 120_000)

  it('applies per turn on a saved session: callback bound, then none, without rebinding the session', async () => {
    const key = providerConfig('probe-resume')
    recorded.length = 0

    const first = await turn({
      projectConfig: projectMcp(),
      request: {
        model: 'opencode/probe-resume/m',
        session_id: 'text-resume',
        messages: [{ role: 'user', content: 'Remember the word ANCHOR. Answer briefly.' }],
        mcp: { mcpServers: { tracecb: { type: 'stdio', command: 'node', args: [mcpServerPath] } } },
      },
    })
    const internalId = first.find((delta) => delta.internal_session_id !== undefined)?.internal_session_id
    expect(internalId).toBeTruthy()
    expect(finish(first)).toBe('stop')
    const firstTools = forKey(key).filter((entry) => entry.tools.length > 0)
    expect(firstTools.length).toBeGreaterThanOrEqual(1)
    expect(firstTools[0]!.tools).toContain('tracecb_trace_callback')

    recorded.length = 0
    const cwd = first.reduce<string | null>((found, delta) => delta.runner?.cwd ?? found, null)
    expect(cwd).toBeTruthy()
    const session: SessionRecord = {
      externalId: 'text-resume',
      backend: 'opencode',
      internalId: internalId!,
      cwd: cwd!,
      turns: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      metadata: {},
    }
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 90_000, spawner: hostSpawner })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat({
      mode: 'byob',
      model: 'opencode/probe-resume/m',
      session_id: 'text-resume',
      toolChoice: 'none',
      messages: [{ role: 'user', content: 'Now the textual plan.' }],
    }, session, new AbortController().signal)) {
      deltas.push(delta)
    }

    const own = forKey(key)
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const entry of own) {
      expect(entry.tools).toHaveLength(0)
    }
    expect(finish(deltas)).toBe('stop')
    // The resumed turn reused the saved native session, not a fresh one.
    expect(deltas.find((delta) => delta.internal_session_id !== undefined)?.internal_session_id).toBe(internalId)
  }, 120_000)
})
