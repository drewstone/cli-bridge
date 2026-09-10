/**
 * WHICH AGENT emitted this span.
 *
 * Measured 2026-09-10 on a live multi-agent run's trace file (94 spans,
 * `~/.local/state/cli-bridge-8913/data/traces/spans.jsonl`): every span carried
 * `cli_bridge.run.id`, `cli_bridge.session.id`, `cli_bridge.backend.session_id`,
 * `gen_ai.request.model` and token usage — and NO agent identity. Several agents
 * shared that run, so the only discriminator a trace tool had left was the model
 * id, which is not an identity: two agents on one model are indistinguishable,
 * and one agent whose model changed reads as two. "How are these agents
 * collaborating?" had no grounded answer, and the join key existed on both sides
 * the whole time — agent-runtime records `profileDigest` per node, the bridge
 * computes `effectiveProfileDigest` per request — just not on the one artifact a
 * trace tool reads.
 *
 * What is proven here:
 *   1. A request carrying `agent_profile` stamps the effective digest and the
 *      caller's own name for it.
 *   2. That digest is the SAME string the run reports as `effectiveProfileDigest`
 *      — a join key, not a second computation that could disagree.
 *   3. A RESUMED request whose profile lives on the session, not in the body, is
 *      stamped too. This is the multi-agent case: an agent's later turns carry no
 *      profile on the wire.
 *   4. Two agents on ONE model separate by digest. This is the gap itself.
 *   5. Tool spans carry it, so filtering to one agent's work needs no tree walk.
 *   6. A failed turn is still attributed — a run's failures belong to an agent.
 *   7. A request with no profile stamps NOTHING. An invented label would be
 *      indistinguishable from one the caller chose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { canonicalAgentProfileDigest, type AgentProfile } from '@tangle-network/agent-interface'
import type { ContractSpan } from '@tangle-network/agent-trace-contract'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { BackendError } from '../src/backends/types.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { BRIDGE_ATTR, TraceEmitter } from '../src/trace/emitter.js'

/**
 * Two agents that differ ONLY in their standing brief — same harness, same
 * model, same provider. Deliberate: this is the pair a model id cannot tell
 * apart, which is exactly the pair an operator has to attribute.
 */
const DIRECTOR_A: AgentProfile = {
  name: 'director-a',
  harness: 'claude-code',
  model: { default: 'sonnet', provider: 'anthropic' },
  prompt: { instructions: ['Decode the transcript.'] },
}

const DIRECTOR_B: AgentProfile = {
  ...DIRECTOR_A,
  name: 'director-b',
  prompt: { instructions: ['Check the decode.'] },
}

/** A profile the caller never named. The digest still identifies it. */
const ANONYMOUS: AgentProfile = {
  harness: 'claude-code',
  model: { default: 'sonnet', provider: 'anthropic' },
  prompt: { instructions: ['No name.'] },
}

class EchoBackend implements Backend {
  readonly name = 'capture'
  /** When set, the next turn asks for this tool before finishing. */
  toolCall: { id: string; name: string; arguments: string } | null = null
  /** When set, the turn fails with this message instead of finishing. */
  failWith: string | null = null

  matches(model: string): boolean {
    return model === 'capture' || model.startsWith('capture/')
  }

  async health() {
    return { name: this.name, state: 'ready' as const }
  }

  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { internal_session_id: 'native-1' }
    if (this.toolCall) yield { tool_calls: [this.toolCall] }
    if (this.failWith !== null) throw new BackendError(this.failWith, 'upstream')
    yield { content: 'ok' }
    yield { finish_reason: 'stop' }
  }
}

function attr(span: ContractSpan, key: string): unknown {
  return span.attributes[key]
}

describe('span node identity — which agent did this', () => {
  let dir: string
  let sessions: SessionStore
  let app: Hono
  let backend: EchoBackend
  let written: ContractSpan[]

  const post = async (body: Record<string, unknown>): Promise<Response> =>
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'capture',
        messages: [{ role: 'user', content: 'work' }],
        stream: false,
        ...body,
      }),
    })

  const llmSpans = (): ContractSpan[] => written.filter((span) => span.name.startsWith('chat '))
  const toolSpans = (): ContractSpan[] => written.filter((span) => !span.name.startsWith('chat '))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bridge-node-identity-'))
    sessions = new SessionStore(dir)
    backend = new EchoBackend()
    written = []
    app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(backend),
      sessions,
      runs: new RunRegistry(),
      trace: new TraceEmitter({
        sink: { write: (spans) => void written.push(...spans) },
        maxToolSpans: 8,
        log: () => {},
      }),
    })
  })

  afterEach(() => {
    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stamps the effective profile digest and the caller\'s name for it', async () => {
    expect((await post({ agent_profile: DIRECTOR_A })).status).toBe(200)

    const [span] = llmSpans()
    expect(span).toBeDefined()
    expect(attr(span!, BRIDGE_ATTR.profileDigest)).toBe(canonicalAgentProfileDigest(DIRECTOR_A))
    expect(attr(span!, BRIDGE_ATTR.profileName)).toBe('director-a')
  })

  it('stamps the same digest the run reports as effectiveProfileDigest', async () => {
    // The join key an operator carries outward. If the span and the receipt
    // could disagree, a reader joining on it would attribute the turn to the
    // wrong agent and never know.
    expect((await post({ session_id: 'agent-a', agent_profile: DIRECTOR_A })).status).toBe(200)

    const stored = sessions.get('agent-a', 'capture')
    const binding = stored?.metadata.agent_profile_binding as
      { effectiveProfileDigest: string } | undefined
    expect(binding?.effectiveProfileDigest).toBeDefined()
    expect(attr(llmSpans()[0]!, BRIDGE_ATTR.profileDigest)).toBe(binding?.effectiveProfileDigest)
  })

  it('stamps a resumed turn whose profile lives on the session, not on the wire', async () => {
    expect((await post({ session_id: 'agent-a', agent_profile: DIRECTOR_A })).status).toBe(200)
    written = []

    // Second turn carries no agent_profile at all — the shape almost every
    // turn after the first one has.
    expect((await post({ session_id: 'agent-a' })).status).toBe(200)

    const [span] = llmSpans()
    expect(attr(span!, BRIDGE_ATTR.profileDigest)).toBe(canonicalAgentProfileDigest(DIRECTOR_A))
    expect(attr(span!, BRIDGE_ATTR.profileName)).toBe('director-a')
  })

  it('separates two agents that share one model, which the model id cannot', async () => {
    expect((await post({ session_id: 'agent-a', agent_profile: DIRECTOR_A })).status).toBe(200)
    expect((await post({ session_id: 'agent-b', agent_profile: DIRECTOR_B })).status).toBe(200)

    const spans = llmSpans()
    expect(spans).toHaveLength(2)
    // The pre-change discriminators agree across both agents...
    expect(new Set(spans.map((span) => attr(span, 'gen_ai.request.model')))).toHaveLength(1)
    // ...and the identity does not.
    expect(spans.map((span) => attr(span, BRIDGE_ATTR.profileDigest))).toEqual([
      canonicalAgentProfileDigest(DIRECTOR_A),
      canonicalAgentProfileDigest(DIRECTOR_B),
    ])
    expect(spans.map((span) => attr(span, BRIDGE_ATTR.profileName))).toEqual([
      'director-a',
      'director-b',
    ])
  })

  it('stamps the tool spans too, so filtering to one agent needs no tree walk', async () => {
    backend.toolCall = { id: 'call_1', name: 'read_file', arguments: '{"path":"x"}' }
    expect((await post({ agent_profile: DIRECTOR_A })).status).toBe(200)

    const tools = toolSpans()
    expect(tools).toHaveLength(1)
    expect(attr(tools[0]!, BRIDGE_ATTR.profileDigest)).toBe(canonicalAgentProfileDigest(DIRECTOR_A))
    expect(attr(tools[0]!, BRIDGE_ATTR.profileName)).toBe('director-a')
    // The pre-existing tool attributes are untouched.
    expect(attr(tools[0]!, 'gen_ai.tool.name')).toBe('read_file')
    expect(attr(tools[0]!, BRIDGE_ATTR.toolCallId)).toBe('call_1')
  })

  it('attributes a failed turn — a run\'s failures belong to an agent too', async () => {
    backend.failWith = 'harness refused the turn'
    const response = await post({ agent_profile: DIRECTOR_B })
    expect(response.status).toBeGreaterThanOrEqual(400)

    const [span] = llmSpans()
    expect(span?.status.code).toBe('STATUS_CODE_ERROR')
    expect(attr(span!, BRIDGE_ATTR.profileDigest)).toBe(canonicalAgentProfileDigest(DIRECTOR_B))
  })

  it('records the digest and no name when the caller named no profile', async () => {
    expect((await post({ agent_profile: ANONYMOUS })).status).toBe(200)

    const [span] = llmSpans()
    expect(attr(span!, BRIDGE_ATTR.profileDigest)).toBe(canonicalAgentProfileDigest(ANONYMOUS))
    expect(span!.attributes).not.toHaveProperty(BRIDGE_ATTR.profileName)
  })

  it('stamps nothing at all when the request carried no profile', async () => {
    expect((await post({})).status).toBe(200)

    const [span] = llmSpans()
    expect(span).toBeDefined()
    // Absent, not empty: a placeholder here would read as an agent.
    expect(span!.attributes).not.toHaveProperty(BRIDGE_ATTR.profileDigest)
    expect(span!.attributes).not.toHaveProperty(BRIDGE_ATTR.profileName)
  })
})

describe('recordNode — the recorder\'s own contract', () => {
  function recorder(written: Array<readonly ContractSpan[]>) {
    return new TraceEmitter({
      sink: { write: (spans) => void written.push(spans) },
      maxToolSpans: 8,
      log: () => {},
    }).beginRequest({
      runId: 'run-1',
      model: 'capture',
      backend: 'capture',
      caller: { correlation: 'none', caller: null },
    })
  }

  it('keeps the last identity when a turn records twice', () => {
    const written: Array<readonly ContractSpan[]> = []
    const recording = recorder(written)
    recording.recordNode({ profileDigest: 'sha256:aaa', profileName: 'first' })
    recording.recordNode({ profileDigest: 'sha256:bbb', profileName: 'second' })
    recording.end()

    expect(attr(written[0]![0]!, BRIDGE_ATTR.profileDigest)).toBe('sha256:bbb')
    expect(attr(written[0]![0]!, BRIDGE_ATTR.profileName)).toBe('second')
  })

  it('ignores an empty digest rather than stamping one', () => {
    const written: Array<readonly ContractSpan[]> = []
    const recording = recorder(written)
    recording.recordNode({ profileDigest: '' })
    recording.end()

    expect(written[0]![0]!.attributes).not.toHaveProperty(BRIDGE_ATTR.profileDigest)
  })

  it('omits an empty name rather than writing one', () => {
    const written: Array<readonly ContractSpan[]> = []
    const recording = recorder(written)
    recording.recordNode({ profileDigest: 'sha256:aaa', profileName: '' })
    recording.end()

    expect(attr(written[0]![0]!, BRIDGE_ATTR.profileDigest)).toBe('sha256:aaa')
    expect(written[0]![0]!.attributes).not.toHaveProperty(BRIDGE_ATTR.profileName)
  })

  it('bounds a pathological name the same way every other attribute is bounded', () => {
    const written: Array<readonly ContractSpan[]> = []
    const recording = recorder(written)
    recording.recordNode({ profileDigest: 'sha256:aaa', profileName: 'n'.repeat(4096) })
    recording.end()

    expect(String(attr(written[0]![0]!, BRIDGE_ATTR.profileName))).toHaveLength(256)
  })
})
