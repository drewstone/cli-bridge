import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  ContextTransferRequestSchema,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  contextTransferRequestDigest,
  portableContextPlanDigest,
  portableConversationContextDigest,
  type AgentProfile,
  type ContextTransferRequest,
  type PortableConversationContext,
} from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { RetainedContextTransfers } from '../src/sessions/retained/context-transfer.js'
import { RetainedSessionError } from '../src/sessions/retained/types.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class ReadyBackend implements Backend {
  readonly name = 'codex'
  readonly requests: ChatRequest[] = []

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  health(): Promise<BackendHealth> {
    return Promise.resolve({ name: this.name, state: 'ready' })
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(request)
    yield { content: 'ok', finish_reason: 'stop' }
  }
}

const profile: AgentProfile = { name: 'destination', harness: 'codex' }

function transferRequest(
  operationId = 'transfer-1',
  acceptedBy: 'system' | 'policy' = 'system',
): ContextTransferRequest {
  const sourceMaterial = {
    source: {
      runId: 'run-source',
      messageId: 'message-assistant',
      provider: 'cli-bridge',
      environmentId: 'environment-source',
      sessionId: 'session-source',
      executionId: 'execution-source',
      requestDigest: `sha256:${'a'.repeat(64)}` as const,
    },
    completeness: 'complete' as const,
    messages: [
      {
        id: 'message-user',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'portable marker 74f2' }],
        timestamp: '2026-08-01T20:00:00.000Z',
      },
      {
        id: 'message-assistant',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'source acknowledgement' }],
        timestamp: '2026-08-01T20:00:01.000Z',
      },
    ],
    attachments: [],
  }
  const source: PortableConversationContext = {
    ...sourceMaterial,
    digest: portableConversationContextDigest(sourceMaterial),
  }
  const destination = {
    runner: 'codex',
    provider: 'cli-bridge',
    environmentId: 'environment-destination',
    sessionId: 'session-destination',
    runId: 'run-destination',
    executionId: 'execution-destination',
    model: 'gpt-5.6',
    profileDigest: canonicalAgentProfileDigest(profile),
  }
  const planMaterial = {
    planId: 'plan-transfer',
    source,
    destination,
    messages: source.messages.map((message) => ({
      messageId: message.id,
      action: 'include' as const,
      parts: message.parts.map((_part, partIndex) => ({ partIndex, action: 'include' as const })),
    })),
    context: source,
    requiresAcceptance: false,
  }
  const plan = { ...planMaterial, digest: portableContextPlanDigest(planMaterial) }
  const material = {
    operationId,
    plan,
    acceptance: {
      planDigest: plan.digest,
      acceptedAt: '2026-08-01T20:00:02.000Z',
      acceptedBy,
    },
  }
  return ContextTransferRequestSchema.parse({
    ...material,
    requestDigest: contextTransferRequestDigest(material),
  })
}

function fixture(): {
  store: SessionStore
  transfers: RetainedContextTransfers
  directory: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-context-transfer-'))
  directories.push(directory)
  const store = new SessionStore(directory)
  const registry = new BackendRegistry().register(new ReadyBackend())
  return {
    store,
    transfers: new RetainedContextTransfers(store, registry, 100),
    directory,
  }
}

function destination(request: ContextTransferRequest) {
  return {
    provider: request.plan.destination.provider,
    environmentId: request.plan.destination.environmentId,
    sessionId: request.plan.destination.sessionId,
    runId: request.plan.destination.runId,
    executionId: request.plan.destination.executionId,
    model: 'codex/gpt-5.6',
    profile,
  }
}

describe('portable context transfer', () => {
  it('admits, replays, restarts, and consumes one exact fresh-session transfer', async () => {
    const first = fixture()
    const request = transferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')

    await expect(first.transfers.transfer(request, callerId)).resolves.toMatchObject({
      status: 'accepted',
      operationId: request.operationId,
      runId: request.plan.destination.runId,
      transferredMessageIds: ['message-user', 'message-assistant'],
    })
    await expect(first.transfers.transfer(request, callerId)).resolves.toMatchObject({ status: 'replayed' })
    expect(first.transfers.lookup(request.operationId, request.requestDigest, callerId)).toMatchObject({
      status: 'replayed',
    })
    expect(first.transfers.messagesForTurn(request, callerId, destination(request))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'portable marker 74f2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'source acknowledgement' }] },
    ])

    first.store.close()
    const reopened = new SessionStore(first.directory)
    const restarted = new RetainedContextTransfers(
      reopened,
      new BackendRegistry().register(new ReadyBackend()),
      100,
    )
    expect(restarted.lookup(request.operationId, request.requestDigest, callerId)).toMatchObject({
      status: 'replayed',
    })
    expect(restarted.messagesForTurn(request, callerId, destination(request))).toHaveLength(2)
    reopened.close()
    for (const file of readdirSync(first.directory).filter((entry) => entry.startsWith('sessions.sqlite'))) {
      expect(readFileSync(join(first.directory, file)).includes(Buffer.from('portable marker 74f2'))).toBe(false)
    }
  })

  it('rejects operation and destination collisions before context can execute', async () => {
    const { store, transfers } = fixture()
    const callerId = canonicalCandidateDigest('Bearer owner')
    const request = transferRequest()
    await transfers.transfer(request, callerId)

    const changedRequest = transferRequest(request.operationId, 'policy')
    await expect(transfers.transfer(changedRequest, callerId)).resolves.toMatchObject({
      status: 'conflict',
      existingRequestDigest: request.requestDigest,
    })
    const coordinateCollision = transferRequest('transfer-2')
    await expect(transfers.transfer(coordinateCollision, callerId)).resolves.toMatchObject({
      status: 'conflict',
      existingRequestDigest: request.requestDigest,
    })
    expect(() => transfers.messagesForTurn(request, callerId, {
      ...destination(request),
      sessionId: 'session-wrong',
    })).toThrow(RetainedSessionError)
    expect(() => transfers.messagesForTurn(request, callerId, {
      ...destination(request),
      profile: { ...profile, name: 'wrong-profile' },
    })).toThrow(/destination does not match/)
    store.close()
  })

  it('does not disclose an operation to a different authenticated caller', async () => {
    const { store, transfers } = fixture()
    const request = transferRequest()
    const owner = canonicalCandidateDigest('Bearer owner')
    const stranger = canonicalCandidateDigest('Bearer stranger')
    await transfers.transfer(request, owner)

    expect(transfers.lookup(request.operationId, request.requestDigest, stranger)).toBeNull()
    expect(() => transfers.messagesForTurn(request, stranger, destination(request))).toThrow(
      /not admitted/,
    )
    store.close()
  })

  it('prepends admitted context to the real one-shot backend request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-context-route-'))
    directories.push(directory)
    const store = new SessionStore(directory)
    const backend = new ReadyBackend()
    const registry = new BackendRegistry().register(backend)
    const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const service = new RetainedSessionService({ store, registry, runs, healthProbeTimeoutMs: 100 })
    const app = new Hono()
    mountRetainedSessions(app, service)
    mountChatCompletions(app, {
      registry,
      sessions: store,
      retainedRuns: store,
      runs,
      contextTransfers: service,
    })
    const request = transferRequest()
    const authorization = 'Bearer owner'
    const transferResponse = await app.request('/v1/context-transfers', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    expect(transferResponse.status).toBe(200)
    await expect(transferResponse.json()).resolves.toMatchObject({ status: 'accepted' })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex/gpt-5.6',
        messages: [{ role: 'user', content: 'use the transferred marker' }],
        agent_profile: profile,
        context_transfer: request,
        provider: request.plan.destination.provider,
        environment_id: request.plan.destination.environmentId,
        session_id: request.plan.destination.sessionId,
        run_id: request.plan.destination.runId,
        execution_id: request.plan.destination.executionId,
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    })
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'portable marker 74f2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'source acknowledgement' }] },
      { role: 'user', content: 'use the transferred marker' },
    ])

    await runs.shutdown(1_000)
    await service.shutdown(1_000)
    store.close()
  })
})
