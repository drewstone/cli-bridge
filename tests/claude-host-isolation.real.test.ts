/**
 * Real-CLI canary for Claude host isolation.
 *
 * A turn ClaudeBackend launches must see the AgentProfile, the request and the
 * run workspace, and nothing from the host user's `~/.claude` layer: no user
 * CLAUDE.md, auto-memory, skills, commands, subagents, MCP servers or hooks.
 * On 2026-10-14 a profile run on beelink2 loaded the host CLAUDE.md and called
 * the host's `operate` skill, because the CLI ran with the operator's full user
 * layer.
 *
 * Opt-in with CLI_BRIDGE_REAL_CLAUDE_TESTS=1 because it runs the installed
 * `claude` binary (or CLAUDE_BIN). It needs no login and spends nothing: the CLI
 * talks to a local stand-in for the Anthropic API with a dummy OAuth bearer, and
 * the stand-in records the exact request the model would have received. The
 * dummy bearer also proves the CLI still takes the OAuth path that subscription
 * seats use, which `--bare` would have disabled.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner } from '../src/executors/types.js'

const describeReal = process.env.CLI_BRIDGE_REAL_CLAUDE_TESTS === '1' ? describe : describe.skip

interface Recorded { path: string; authorization: string | undefined; body: string }

/** Answers every Messages call with one streamed "ok" and keeps the request. */
function startApiStandIn(recorded: Recorded[]): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      recorded.push({ path: req.url ?? '', authorization: req.headers.authorization, body })
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
        return
      }
      const model = (JSON.parse(body) as { model?: string }).model ?? 'model'
      const events: Array<[string, unknown]> = [
        ['message_start', { type: 'message_start', message: { id: 'msg_canary', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Plants a canary in every host-user channel Claude Code reads. */
function plantHostUserLayer(home: string, workspace: string, hookMarker: string): void {
  const claude = join(home, '.claude')
  const write = (path: string, text: string): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(claude, 'CLAUDE.md'), 'USER_MEMORY_CANARY: host user instructions.\n')
  write(join(claude, 'skills/canary-skill/SKILL.md'), '---\nname: canary-skill\ndescription: USER_SKILL_CANARY host skill\n---\nhost skill\n')
  write(join(claude, 'commands/user-command.md'), '---\ndescription: USER_COMMAND_CANARY host command\n---\nhost command\n')
  write(join(claude, 'agents/user-agent.md'), '---\nname: user-agent\ndescription: USER_AGENT_CANARY host subagent\n---\nhost agent\n')
  write(join(claude, 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }],
    },
  }))
  // Claude keys a project's auto-memory and local-scope MCP servers by its real path.
  const projectKey = realpathSync(workspace).replace(/[^A-Za-z0-9]/gu, '-')
  write(join(claude, 'projects', projectKey, 'memory/MEMORY.md'), '- USER_AUTOMEMORY_CANARY: remembered on this host\n')
  write(join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { 'user-mcp-canary': { type: 'stdio', command: 'true' } },
    projects: { [realpathSync(workspace)]: { mcpServers: { 'local-mcp-canary': { type: 'stdio', command: 'true' } } } },
  }))
}

describeReal('Claude host isolation against the real CLI', () => {
  const recorded: Recorded[] = []
  let server: Server
  let root: string
  let init: Record<string, unknown> = {}
  let content = ''

  beforeAll(async () => {
    server = await startApiStandIn(recorded)
    root = mkdtempSync(join(tmpdir(), 'claude-host-isolation-'))
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    const hookMarker = join(root, 'host-hook-fired')
    mkdirSync(workspace, { recursive: true })
    plantHostUserLayer(home, workspace, hookMarker)
    // A workspace file the run must still see: the project layer stays loaded.
    mkdirSync(join(workspace, '.claude/skills/project-skill'), { recursive: true })
    writeFileSync(join(workspace, '.claude/skills/project-skill/SKILL.md'), '---\nname: project-skill\ndescription: PROJECT_SKILL_CANARY workspace skill\n---\nworkspace skill\n')

    // Keep a copy of the stream so the init event's inventory can be asserted.
    // Paths are baked in because the host env sanitizer drops unknown names.
    const streamCopy = join(root, 'stream.jsonl')
    const bin = join(root, 'claude-tee')
    writeFileSync(bin, `#!/usr/bin/env bash\nset -o pipefail\n${JSON.stringify(process.env.CLAUDE_BIN ?? 'claude')} "$@" | tee ${JSON.stringify(streamCopy)}\n`)
    chmodSync(bin, 0o755)

    // Only HOME and the dummy bearer differ from the bridge's own launch.
    const spawner: Spawner = (command, args, opts) => hostSpawner(command, args, {
      ...opts,
      env: {
        ...opts.env,
        HOME: home,
        CLAUDE_CODE_OAUTH_TOKEN: 'dummy-oauth-token',
        CLAUDE_CONFIG_DIR: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
    })
    const backend = new ClaudeBackend({
      bin,
      harness: 'claude-code',
      timeoutMs: 0,
      anthropicBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      spawner,
    })
    const req: ChatRequest = {
      cwd: workspace,
      session_id: 'host-isolation-canary',
      mode: 'byob',
      model: 'claude-code/anthropic/sonnet',
      messages: [{ role: 'user', content: 'say ok' }],
      agent_profile: {
        name: 'host-isolation-canary',
        resources: {
          instructions: 'PROFILE_INSTRUCTIONS_CANARY: profile instructions.',
          skills: [{ kind: 'inline', name: 'profile-skill', content: '---\nname: profile-skill\ndescription: PROFILE_SKILL_CANARY profile skill\n---\nprofile skill\n' }],
          failOnError: true,
        },
      },
    }
    for await (const delta of backend.chat(req, null, new AbortController().signal)) content += delta.content ?? ''
    for (const line of readFileSync(streamCopy, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'system' && event.subtype === 'init') init = event
    }
  }, 120_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const modelRequests = (): string => recorded
    .filter((request) => request.path.startsWith('/v1/messages') && !request.path.includes('count_tokens'))
    .map((request) => request.body)
    .join('\n')

  it('completes the turn on the OAuth bearer path', () => {
    expect(content).toBe('ok')
    const calls = recorded.filter((request) => request.path.startsWith('/v1/messages'))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.authorization).toBe('Bearer dummy-oauth-token')
  })

  it('sends the profile and workspace context to the model', () => {
    const sent = modelRequests()
    expect(sent).toContain('PROFILE_INSTRUCTIONS_CANARY')
    expect(sent).toContain('PROFILE_SKILL_CANARY')
    expect(sent).toContain('PROJECT_SKILL_CANARY')
  })

  it('sends nothing from the host user layer', () => {
    const sent = modelRequests()
    for (const canary of ['USER_MEMORY_CANARY', 'USER_AUTOMEMORY_CANARY', 'USER_SKILL_CANARY', 'USER_COMMAND_CANARY', 'USER_AGENT_CANARY']) {
      expect(sent, canary).not.toContain(canary)
    }
    expect(sent).not.toContain('failOnError')
  })

  it('loads no host skill, subagent, MCP server or hook', () => {
    expect(init.skills).toEqual(expect.arrayContaining(['profile-skill', 'project-skill']))
    expect(init.skills).not.toContain('canary-skill')
    expect(init.agents).not.toContain('user-agent')
    expect(init.mcp_servers).toEqual([])
    expect(existsSync(join(root, 'host-hook-fired'))).toBe(false)
  })
})
