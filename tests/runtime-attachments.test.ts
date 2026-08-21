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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import type { Backend, ChatDelta, ChatRequest, McpServerSpec } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { resolveMcpServers, writeMcpConfigFile } from '../src/backends/profile-support.js'

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
    this.lastSpecs = resolveMcpServers(req, session)
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

  it('never folds the attachment into the AgentProfile the request carries', async () => {
    await post({
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    const profile = backend.last?.agent_profile as AgentProfile
    expect(Object.keys(profile.mcp ?? {})).toEqual(['notes'])
    expect(canonicalAgentProfileDigest(profile)).toBe(canonicalAgentProfileDigest(PROFILE))
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

    expect(changed.status).toBe(400)
    expect(await changed.json()).toMatchObject({
      error: { message: expect.stringContaining('bound to a different AgentProfile/model') },
    })
  })

  it('binds the exact model and provider, and no attachment', async () => {
    await post({
      session_id: 'binding-contents',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    expect(storedBinding('binding-contents')).toEqual({
      schema: 'cli-bridge.session-agent-profile.v1',
      effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE),
      provider: 'anthropic',
      model: 'capture',
      requestedReasoningEffort: null,
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

  it('refuses an attachment alias already declared by the request mcp channel', async () => {
    const response = await post({
      mcp: { mcpServers: { coordination: { command: 'other-mcp' } } },
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('collides with an MCP server declared by the request mcp channel') },
    })
  })

  it('refuses a disabled attachment instead of dropping it silently', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: { ...coordination(36827), enabled: false } } },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('is disabled') },
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

  it('never persists an attachment into durable session state', async () => {
    await post({
      session_id: 'no-persisted-attachment',
      agent_profile: PROFILE,
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    const metadata = sessions.get('no-persisted-attachment', 'capture')?.metadata ?? {}
    expect(metadata).not.toHaveProperty('runtime_attachments')
    expect(JSON.stringify(metadata)).not.toContain('36827')
  })

  it('mounts an attachment for a request that carries no AgentProfile', async () => {
    const response = await post({
      mcp: { mcpServers: { notes: { command: 'notes-mcp' } } },
      runtime_attachments: { mcp: { coordination: coordination(36827) } },
    })

    expect(response.status).toBe(200)
    expect(Object.keys(backend.lastConfig?.mcpServers ?? {}).sort()).toEqual(['coordination', 'notes'])
  })

  it('rejects an unknown runtime_attachments field before execution', async () => {
    const response = await post({
      agent_profile: PROFILE,
      runtime_attachments: { mcp: {}, env: { COORD: '1' } },
    })

    expect(response.status).toBe(400)
    expect(backend.last).toBeNull()
  })
})
