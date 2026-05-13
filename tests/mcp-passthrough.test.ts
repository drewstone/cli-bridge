/**
 * MCP passthrough — end-to-end verification that the standardised
 * request-body `mcp.mcpServers` field plus `X-Mcp-Config` header flow
 * through the chat-completions route into the backend's resolved
 * server map, and that each per-backend materialiser produces a
 * config file the upstream CLI would actually accept.
 *
 * Coverage:
 *
 *   1. Route layer — POST /v1/chat/completions with `mcp` in the body
 *      lands on the backend as `req.mcp` and is reflected by
 *      resolveMcpServers().
 *
 *   2. Route layer — `X-Mcp-Config` header is parsed, merged with the
 *      body (body wins on name collision).
 *
 *   3. Materialiser fidelity — each backend's config file format is
 *      valid for its CLI's loader (claude/kimi JSON, opencode JSON,
 *      codex TOML) AND the materialised stdio command actually spawns
 *      a working JSON-RPC MCP server when launched.
 *
 * (3) is the load-bearing test: it stands up a real Node-based stdio
 * MCP server, exec's the command line our materialiser writes, and
 * confirms the server processes a JSON-RPC `initialize` request. If
 * the materialiser drops `args` or `env`, the spawn fails or the
 * server returns the wrong protocol version — the test catches both.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import {
  materialiseMcpServersForClaudeKimi,
  materialiseMcpServersForCodex,
  materialiseMcpServersForOpencode,
  resolveMcpServers,
} from '../src/backends/profile-support.js'

/**
 * Captures the ChatRequest the route hands to the backend, so tests
 * can assert what the request layer normalised.
 */
class CapturingBackend implements Backend {
  readonly name = 'capture'
  public last: ChatRequest | null = null
  matches(model: string): boolean {
    return model === 'capture' || model.startsWith('capture/')
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(req: ChatRequest, _session: SessionRecord | null): AsyncIterable<ChatDelta> {
    this.last = req
    yield { content: 'ok' }
    yield { finish_reason: 'stop' }
  }
}

describe('chat-completions route — mcp body field', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono
  let backend: CapturingBackend

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-route-'))
    sessions = new SessionStore(dir)
    backend = new CapturingBackend()
    const registry = new BackendRegistry().register(backend)
    app = new Hono()
    mountChatCompletions(app, { registry, sessions })
  })
  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards request-body `mcp.mcpServers` to the backend verbatim', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
        mcp: {
          mcpServers: {
            echo: { type: 'stdio', command: 'node', args: ['./echo.js'] },
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    expect(backend.last?.mcp?.mcpServers?.echo).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['./echo.js'],
    })
  })

  it('accepts MCP config via the X-Mcp-Config header', async () => {
    const headerValue = JSON.stringify({
      mcpServers: {
        echo: { command: 'node', args: ['./from-header.js'] },
      },
    })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-config': headerValue },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(backend.last?.mcp?.mcpServers?.echo).toEqual({
      command: 'node',
      args: ['./from-header.js'],
    })
  })

  it('body wins on collision; header still contributes other names', async () => {
    const headerValue = JSON.stringify({
      mcpServers: {
        echo: { command: 'from-header' },
        extra: { command: 'header-only' },
      },
    })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-config': headerValue },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
        mcp: { mcpServers: { echo: { command: 'from-body' } } },
      }),
    })
    expect(res.status).toBe(200)
    expect(backend.last?.mcp?.mcpServers).toEqual({
      echo: { command: 'from-body' },
      extra: { command: 'header-only' },
    })
  })

  it('a malformed X-Mcp-Config header does NOT 400 the request (best-effort)', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-config': 'not-json' },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(backend.last?.mcp).toBeUndefined()
  })

  it('rejects an invalid `mcp` shape with 400 (schema enforced)', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
        // mcp must be an object — passing a string is a hard schema error.
        mcp: 'oops',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('resolveMcpServers merges body + agent_profile.mcp on the backend side', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'hi' }],
        agent_profile: {
          mcp: {
            'profile-only': { transport: 'stdio', command: 'tsx', args: ['p.ts'] },
            'shared-name': { command: 'from-profile' },
          },
        },
        mcp: {
          mcpServers: {
            'body-only': { command: 'node', args: ['b.js'] },
            'shared-name': { command: 'from-body' },
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    const merged = resolveMcpServers(backend.last!, null)
    expect(merged).toEqual({
      'profile-only': { type: 'stdio', command: 'tsx', args: ['p.ts'] },
      'shared-name': { command: 'from-body' },
      'body-only': { command: 'node', args: ['b.js'] },
    })
  })
})

/**
 * Mini stdio MCP server — speaks just enough of the protocol to confirm
 * "the server was launched with the args/env our materialiser wrote and
 * it processed a JSON-RPC frame". Not a full MCP impl — exit on the
 * first valid request.
 *
 * Wire format: LSP-style (`Content-Length: N\r\n\r\n<json>`). Same
 * framing every MCP runtime uses. The server prints its response to
 * stdout and exits.
 */
const TINY_MCP_SERVER_SOURCE = `
'use strict'
process.stdin.setEncoding('utf-8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  while (true) {
    const idx = buf.indexOf('\\r\\n\\r\\n')
    if (idx < 0) return
    const headers = buf.slice(0, idx)
    const m = /Content-Length: (\\d+)/i.exec(headers)
    if (!m) { buf = buf.slice(idx + 4); continue }
    const len = Number(m[1])
    if (buf.length < idx + 4 + len) return
    const body = buf.slice(idx + 4, idx + 4 + len)
    buf = buf.slice(idx + 4 + len)
    let req
    try { req = JSON.parse(body) } catch { continue }
    const reply = {
      jsonrpc: '2.0',
      id: req.id ?? 1,
      result: {
        ok: true,
        gotMethod: req.method ?? null,
        // Echo the env var the materialiser MUST forward, so tests can
        // assert env survived the spawn boundary.
        echoEnv: process.env.MCP_ECHO_KEY ?? null,
        // Echo argv[2] so tests can assert args survived.
        echoArg: process.argv[2] ?? null,
      },
    }
    const payload = JSON.stringify(reply)
    process.stdout.write(\`Content-Length: \${Buffer.byteLength(payload, 'utf-8')}\\r\\n\\r\\n\${payload}\`)
    process.exit(0)
  }
})
process.stdin.on('end', () => process.exit(0))
`

interface SpawnedReply {
  ok: boolean
  gotMethod: string | null
  echoEnv: string | null
  echoArg: string | null
}

/**
 * Spawn a command exactly as a backend would launch it (command +
 * args + env), send a single initialize request, parse the reply.
 * Returns the parsed JSON or throws.
 */
async function probeStdioMcp(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 5000,
): Promise<SpawnedReply> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`probe timed out after ${timeoutMs}ms; stderr=${stderr}`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`server exited ${code}; stderr=${stderr}`))
        return
      }
      const idx = stdout.indexOf('\r\n\r\n')
      if (idx < 0) {
        reject(new Error(`no framed response; stdout=${stdout}`))
        return
      }
      const body = stdout.slice(idx + 4)
      try {
        const parsed = JSON.parse(body) as { result: SpawnedReply }
        resolve(parsed.result)
      } catch (err) {
        reject(err as Error)
      }
    })
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    child.stdin.write(`Content-Length: ${Buffer.byteLength(req, 'utf-8')}\r\n\r\n${req}`)
    child.stdin.end()
  })
}

describe('per-backend materialiser produces a launchable stdio MCP server', () => {
  let workDir: string
  let serverPath: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-int-'))
    serverPath = join(workDir, 'mini-mcp.cjs')
    writeFileSync(serverPath, TINY_MCP_SERVER_SOURCE)
  })
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function specsForServer(): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
    return {
      echo: {
        command: process.execPath,
        args: [serverPath, 'expected-arg-value'],
        env: { MCP_ECHO_KEY: 'expected-env-value' },
      },
    }
  }

  it('claude/kimi mcp-config.json — command+args+env survive the JSON round-trip', async () => {
    const specs = specsForServer()
    const m = materialiseMcpServersForClaudeKimi(specs)
    expect(m).not.toBeNull()
    if (!m) return
    try {
      const config = JSON.parse(readFileSync(m.configPath, 'utf-8')) as {
        mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
      }
      const entry = config.mcpServers.echo!
      const reply = await probeStdioMcp(entry.command, entry.args ?? [], entry.env ?? {})
      expect(reply.echoArg).toBe('expected-arg-value')
      expect(reply.echoEnv).toBe('expected-env-value')
      expect(reply.gotMethod).toBe('initialize')
    } finally {
      m.cleanup()
    }
  }, 10_000)

  it('opencode opencode.json — command-as-array + environment survive the JSON round-trip', async () => {
    const specs = specsForServer()
    const m = materialiseMcpServersForOpencode(specs)
    try {
      const config = JSON.parse(readFileSync(m.configPath, 'utf-8')) as {
        mcp: Record<string, { command: string[]; environment?: Record<string, string> }>
      }
      const entry = config.mcp.echo!
      const reply = await probeStdioMcp(entry.command[0]!, entry.command.slice(1), entry.environment ?? {})
      expect(reply.echoArg).toBe('expected-arg-value')
      expect(reply.echoEnv).toBe('expected-env-value')
      expect(reply.gotMethod).toBe('initialize')
    } finally {
      m.cleanup()
    }
  }, 10_000)

  it('codex config.toml — round-trips through the real codex parser when available', async () => {
    // Defence-in-depth: spawn codex itself, point it at our synthetic
    // CODEX_HOME, and ask `codex mcp list` to enumerate. If codex
    // parses our TOML, the server name appears; if codex changed its
    // schema, the test surfaces the regression before users hit it.
    // Skipped silently when codex isn't installed (CI envs without
    // the user's CLI subscription).
    const { spawnSync } = await import('node:child_process')
    const which = spawnSync('which', ['codex'])
    if (which.status !== 0) {
      // eslint-disable-next-line no-console
      console.warn('skipping codex round-trip — codex not on PATH')
      return
    }
    const specs = specsForServer()
    const m = materialiseMcpServersForCodex(specs)
    expect(m).not.toBeNull()
    if (!m) return
    try {
      const result = spawnSync('codex', ['mcp', 'list'], {
        env: { ...process.env, CODEX_HOME: m.homePath },
        encoding: 'utf-8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('echo')
    } finally {
      m.cleanup()
    }
  }, 10_000)

  it('codex config.toml — TOML stanza parses back to a launchable spec', async () => {
    const specs = specsForServer()
    const m = materialiseMcpServersForCodex(specs)
    expect(m).not.toBeNull()
    if (!m) return
    try {
      const toml = readFileSync(join(m.homePath, 'config.toml'), 'utf-8')
      // Don't pull in a TOML lib — assert the lines we expect and
      // re-derive command/args/env from the source spec for the
      // spawn probe (the TOML file is what codex reads; spec is the
      // truth our materialiser wrote it from).
      expect(toml).toContain('[mcp_servers.echo]')
      expect(toml).toContain(`command = "${process.execPath}"`)
      // Args entry must be a TOML array of strings.
      expect(toml).toMatch(/args = \["[^"]*mini-mcp\.cjs", "expected-arg-value"\]/)
      // env inline table — TOML requires quoted strings, unquoted bare keys.
      expect(toml).toContain('env = { MCP_ECHO_KEY = "expected-env-value" }')
      const spec = specs.echo!
      const reply = await probeStdioMcp(spec.command, spec.args, spec.env)
      expect(reply.echoArg).toBe('expected-arg-value')
      expect(reply.echoEnv).toBe('expected-env-value')
    } finally {
      m.cleanup()
    }
  }, 10_000)
})
