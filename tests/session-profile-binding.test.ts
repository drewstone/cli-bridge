/**
 * Session profile binding — the refusal a caller can act on.
 *
 * A session external id is the harness conversation key (`claude --resume`,
 * `opencode -s <id>`), so the bridge never rebinds one: a matching binding IS
 * the resume path, and a different binding is a refusal. Only the caller can
 * tell an intentional resume from an accidental id collision.
 *
 * Measured 2026-08-22: two graph cells re-ran under session ids their dead
 * first attempt had already bound, and the answer was HTTP 400
 * `invalid_request_error` / `parse_error` with the digests nowhere in the body.
 * A well-formed request was reported as a malformed one, and the ambiguity
 * "did my profile drift, or did I reuse a dead run's id?" cost a debugging
 * session.
 *
 * Coverage:
 *   1. Mismatched binding → 409 `session_binding_conflict` with BOTH bindings.
 *   2. A session that predates binding → the same 409 with `stored_binding: null`.
 *   3. Matching binding still resumes 200 — the old path is untouched.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'

const PROFILE: AgentProfile = {
  name: 'graph-worker',
  harness: 'claude-code',
  model: { default: 'sonnet', provider: 'anthropic' },
  prompt: { systemPrompt: 'Do the cell.', instructions: ['STANDING BRIEF'] },
}

const OTHER_PROFILE: AgentProfile = {
  ...PROFILE,
  prompt: { ...PROFILE.prompt, instructions: ['A DIFFERENT BRIEF'] },
}

class EchoBackend implements Backend {
  readonly name = 'capture'
  turns = 0
  matches(model: string): boolean {
    return model === 'capture' || model.startsWith('capture/')
  }
  async health() { return { name: this.name, state: 'ready' as const } }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.turns += 1
    yield { internal_session_id: 'native-1' }
    yield { content: 'ok' }
    yield { finish_reason: 'stop' }
  }
}

describe('session profile binding — structured conflict', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono
  let backend: EchoBackend

  const post = async (body: Record<string, unknown>): Promise<Response> => await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'capture',
      messages: [{ role: 'user', content: 'work' }],
      ...body,
    }),
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-session-binding-'))
    sessions = new SessionStore(dir)
    backend = new EchoBackend()
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

  it('answers 409 with both bindings when the profile differs', async () => {
    expect((await post({ session_id: 'cell-7', agent_profile: PROFILE })).status).toBe(200)

    const conflict = await post({ session_id: 'cell-7', agent_profile: OTHER_PROFILE })
    expect(conflict.status).toBe(409)
    const body = await conflict.json() as {
      error: {
        type: string
        session_id: string
        message: string
        provider_dispatch: string
        stored_binding: Record<string, unknown>
        received_binding: Record<string, unknown>
      }
    }
    expect(body.error.type).toBe('session_binding_conflict')
    expect(body.error.session_id).toBe('cell-7')
    expect(body.error.provider_dispatch).toBe('not_started')
    expect(body.error.stored_binding).toEqual({
      schema: 'cli-bridge.session-agent-profile.v1',
      effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE),
      provider: 'anthropic',
      model: 'capture',
      requestedReasoningEffort: null,
    })
    expect(body.error.received_binding).toEqual({
      schema: 'cli-bridge.session-agent-profile.v1',
      effectiveProfileDigest: canonicalAgentProfileDigest(OTHER_PROFILE),
      provider: 'anthropic',
      model: 'capture',
      requestedReasoningEffort: null,
    })
    // The two digests are what separates "my profile drifted" from "I reused a
    // dead run's session id". Reporting one without the other explains nothing.
    expect(body.error.stored_binding.effectiveProfileDigest)
      .not.toBe(body.error.received_binding.effectiveProfileDigest)
    // The refusal happens before any spawn, so the model never ran.
    expect(backend.turns).toBe(1)
  })

  it('reports a session that predates binding with a null stored binding', async () => {
    sessions.remember({
      externalId: 'legacy-cell',
      backend: 'capture',
      model: 'capture',
      internalId: 'native-legacy',
      cwd: null,
      metadata: { model: 'capture' },
    })

    const conflict = await post({ session_id: 'legacy-cell', agent_profile: PROFILE })
    expect(conflict.status).toBe(409)
    const body = await conflict.json() as {
      error: { type: string; stored_binding: unknown; received_binding: Record<string, unknown> }
    }
    expect(body.error.type).toBe('session_binding_conflict')
    expect(body.error.stored_binding).toBeNull()
    expect(body.error.received_binding).toMatchObject({
      effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE),
    })
  })

  it('still resumes a session whose binding matches', async () => {
    expect((await post({ session_id: 'cell-9', agent_profile: PROFILE })).status).toBe(200)
    const resumed = await post({ session_id: 'cell-9', agent_profile: PROFILE })
    expect(resumed.status).toBe(200)
    expect(backend.turns).toBe(2)
    // Resume means one conversation, not two: the stored binding is unchanged.
    expect(sessions.get('cell-9', 'capture')?.metadata.agent_profile_binding).toMatchObject({
      effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE),
    })
  })
})
