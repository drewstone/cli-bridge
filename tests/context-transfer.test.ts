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

const profile: AgentProfile = {
  name: 'destination', harness: 'codex',
  prompt: { instructions: ['Preserve the portable marker.'] },
  resources: { instructions: 'Read the workspace before making changes.' },
}

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
    environmentId: request.plan.destination.environmentId!,
    sessionId: request.plan.destination.sessionId,
    runId: request.plan.destination.runId,
    executionId: request.plan.destination.executionId,
    model: 'codex/gpt-5.6',
    profile,
  }
}

function unboundTransferRequest(operationId = 'transfer-unbound'): ContextTransferRequest {
  const original = structuredClone(transferRequest(operationId))
  Reflect.deleteProperty(original.plan.destination, 'environmentId')
  const { digest: _digest, ...planMaterial } = original.plan
  const plan = { ...planMaterial, digest: portableContextPlanDigest(planMaterial) }
  const material = {
    operationId,
    plan,
    acceptance: { ...original.acceptance, planDigest: plan.digest },
    profile,
  }
  return ContextTransferRequestSchema.parse({
    ...material,
    requestDigest: contextTransferRequestDigest(material),
  })
}

function withAllocation(
  request: ContextTransferRequest,
  allocation: Pick<ContextTransferRequest, 'workspace' | 'resources'>,
): ContextTransferRequest {
  const { requestDigest: _digest, ...base } = request
  const material = { ...base, ...allocation }
  return ContextTransferRequestSchema.parse({
    ...material,
    requestDigest: contextTransferRequestDigest(material),
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve: () => resolve() }
}

class BlockedReadyBackend extends ReadyBackend {
  constructor(private readonly ready: Promise<void>, private readonly entered: () => void) { super() }
  override async health(): Promise<BackendHealth> {
    this.entered()
    await this.ready
    return super.health()
  }
}

describe('portable context transfer', () => {
  it('accepts the exact portable profile through the public transfer route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-context-profile-'))
    directories.push(directory)
    const store = new SessionStore(directory)
    const registry = new BackendRegistry().register(new ReadyBackend())
    const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const service = new RetainedSessionService({ store, registry, runs, healthProbeTimeoutMs: 100 })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const { requestDigest: _digest, ...base } = transferRequest()
    const material = { ...base, profile }
    const request = { ...material, requestDigest: contextTransferRequestDigest(material) }

    try {
      const response = await app.request('/v1/context-transfers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: 'accepted',
        requestDigest: request.requestDigest,
        environmentId: 'environment-destination',
      })
    } finally {
      await runs.shutdown(1_000)
      await service.shutdown(1_000)
      store.close()
    }
  })

  it('retains one allocated environment after an unbound admission and restart', async () => {
    const first = fixture()
    const request = unboundTransferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    const accepted = await first.transfers.transfer(request, callerId)
    if (accepted.status !== 'accepted') throw new Error('transfer was not accepted')
    expect(accepted.destination).toEqual(request.plan.destination)
    expect(accepted.destination.environmentId).toBeUndefined()
    expect(accepted.environmentId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(accepted.environmentId).not.toBe(request.plan.source.source.environmentId)
    expect(first.transfers.lookupByEnvironment(accepted.environmentId, callerId)).toMatchObject({
      status: 'replayed', environmentId: accepted.environmentId,
    })
    first.store.close()
    const reopened = new SessionStore(first.directory)
    const restarted = new RetainedContextTransfers(reopened, new BackendRegistry().register(new ReadyBackend()), 100)
    try {
      await expect(restarted.transfer(request, callerId)).resolves.toMatchObject({
        status: 'replayed', environmentId: accepted.environmentId,
      })
      expect(restarted.messagesForTurn(request, callerId, {
        ...destination(request), environmentId: accepted.environmentId,
      })).toHaveLength(2)
      expect(() => restarted.messagesForTurn(request, callerId, {
        ...destination(request), environmentId: 'unadmitted-environment',
      })).toThrow(/destination does not match/)
    } finally {
      reopened.close()
    }
  })

  it('replays one durable receipt across concurrent receiver instances', async () => {
    const first = fixture()
    const secondStore = new SessionStore(first.directory)
    const firstReady = deferred()
    const secondReady = deferred()
    const firstEntered = deferred()
    const secondEntered = deferred()
    const receiver = (store: SessionStore, ready: ReturnType<typeof deferred>, entered: ReturnType<typeof deferred>) =>
      new RetainedContextTransfers(store, new BackendRegistry().register(new BlockedReadyBackend(ready.promise, entered.resolve)), 1_000)
    const request = unboundTransferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      const firstAdmission = receiver(first.store, firstReady, firstEntered).transfer(request, callerId)
      const secondAdmission = receiver(secondStore, secondReady, secondEntered).transfer(request, callerId)
      await Promise.all([firstEntered.promise, secondEntered.promise])
      firstReady.resolve()
      const accepted = await firstAdmission
      if (accepted.status !== 'accepted') throw new Error('first transfer was not accepted')
      secondReady.resolve()
      await expect(secondAdmission).resolves.toEqual({ ...accepted, status: 'replayed' })
    } finally {
      firstReady.resolve()
      secondReady.resolve()
      secondStore.close()
      first.store.close()
    }
  })

  it('rejects changed profile, workspace, and resource material under the same operation key', async () => {
    const { store, transfers } = fixture()
    const request = unboundTransferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      await transfers.transfer(request, callerId)
      const changedProfile = { ...profile, name: 'different-profile' }
      const { digest: _planDigest, ...planMaterial } = request.plan
      const changedPlanMaterial = {
        ...planMaterial,
        destination: { ...planMaterial.destination, profileDigest: canonicalAgentProfileDigest(changedProfile) },
      }
      const changedPlan = { ...changedPlanMaterial, digest: portableContextPlanDigest(changedPlanMaterial) }
      const { requestDigest: _digest, ...base } = request
      const changedMaterial = {
        ...base, profile: changedProfile, plan: changedPlan,
        acceptance: { ...request.acceptance, planDigest: changedPlan.digest },
      }
      const changedRequests = [
        ContextTransferRequestSchema.parse({ ...changedMaterial, requestDigest: contextTransferRequestDigest(changedMaterial) }),
        withAllocation(request, { workspace: { cwd: { base: 'host', path: '/tmp/changed-portable-return' } } }),
        withAllocation(request, { resources: { cpu: 2 } }),
      ]
      for (const changed of changedRequests) {
        await expect(transfers.transfer(changed, callerId)).resolves.toMatchObject({
          status: 'conflict', existingRequestDigest: request.requestDigest,
        })
      }
    } finally {
      store.close()
    }
  })

  it('requires the exact declared host cwd when consuming admitted context', async () => {
    const { store, transfers } = fixture()
    const request = withAllocation(unboundTransferRequest(), {
      workspace: { cwd: { base: 'host', path: '/tmp/portable-return' } },
    })
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      const receipt = await transfers.transfer(request, callerId)
      if (receipt.status !== 'accepted') throw new Error('transfer was not accepted')
      const actual = { ...destination(request), environmentId: receipt.environmentId, cwd: '/tmp/portable-return' }
      expect(transfers.messagesForTurn(request, callerId, actual)).toHaveLength(2)
      expect(() => transfers.messagesForTurn(request, callerId, { ...actual, cwd: '/tmp/other-return' })).toThrow(/destination does not match/)
      expect(() => transfers.messagesForTurn(request, callerId, { ...actual, cwd: undefined })).toThrow(/destination does not match/)
      expect(() => transfers.messagesForTurn(request, callerId, { ...actual, executionKind: 'sandbox' })).toThrow(/destination does not match/)
    } finally {
      store.close()
    }
  })

  it.each([
    { workspace: { environment: 'cloud-template' } },
    { workspace: { image: 'cloud-image' } },
    { workspace: { repoUrl: 'https://example.com/repository.git', gitRef: 'main' } },
    { workspace: { providerOptions: { size: 'large' } } },
    { workspace: { cwd: { base: 'repository' as const, path: 'src' } } },
    { workspace: { checkpoint: {
      checkpointId: 'checkpoint-cloud', provider: 'tangle',
      source: { provider: 'tangle', environmentId: 'cloud-source', sessionId: 'source-session', runId: 'source-run', executionId: 'source-execution', requestDigest: `sha256:${'b'.repeat(64)}` as const },
      idempotencyKey: 'checkpoint-operation', requestDigest: `sha256:${'c'.repeat(64)}` as const,
      createdAt: '2026-08-01T20:00:00.000Z',
    } } },
    { resources: { cpu: 2 } },
  ])('refuses unsupported local allocation before durable admission: %j', async (allocation) => {
    const { store, transfers } = fixture()
    const request = withAllocation(unboundTransferRequest(), allocation)
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      await expect(transfers.transfer(request, callerId)).rejects.toMatchObject({ status: 400, code: 'capability_denied' })
      expect(transfers.lookup(request.operationId, request.requestDigest, callerId)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('reads legacy stored destination bindings after restart', async () => {
    const source = fixture()
    const request = transferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    const receipt = await source.transfers.transfer(request, callerId)
    if (receipt.status !== 'accepted') throw new Error('transfer was not accepted')
    source.store.close()
    const legacy = fixture()
    legacy.store.recordRetainedControlOperation({
      operationId: request.operationId,
      callerId,
      kind: 'context_transfer',
      runId: request.plan.destination.runId,
      sessionId: request.plan.destination.sessionId,
      requestDigest: request.requestDigest,
      acknowledgement: {
        status: 'accepted',
        binding: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          planDigest: request.plan.digest,
          contextDigest: request.plan.context.digest,
          destination: request.plan.destination,
        },
        receipt,
      },
    })
    legacy.store.close()
    const reopened = new SessionStore(legacy.directory)
    const restarted = new RetainedContextTransfers(reopened, new BackendRegistry().register(new ReadyBackend()), 100)
    try {
      expect(restarted.lookupByEnvironment(receipt.environmentId, callerId)).toMatchObject({
        status: 'replayed', environmentId: receipt.environmentId,
      })
      await expect(restarted.transfer(request, callerId)).resolves.toMatchObject({ status: 'replayed' })
      expect(restarted.messagesForTurn(request, callerId, destination(request))).toHaveLength(2)
    } finally {
      reopened.close()
    }
  })

  it('resumes a pending admission with its recorded environment after restart', async () => {
    const first = fixture()
    const request = unboundTransferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    const recordedEnvironmentId = 'environment-allocated-before-restart'
    first.store.recordRetainedControlOperation({
      operationId: request.operationId, callerId, kind: 'context_transfer',
      runId: request.plan.destination.runId, sessionId: request.plan.destination.sessionId,
      requestDigest: request.requestDigest,
      acknowledgement: {
        status: 'pending',
        binding: {
          operationId: request.operationId, requestDigest: request.requestDigest,
          planDigest: request.plan.digest, contextDigest: request.plan.context.digest,
          environmentId: recordedEnvironmentId, destination: request.plan.destination,
        },
      },
    })
    first.store.close()
    const reopened = new SessionStore(first.directory)
    const restarted = new RetainedContextTransfers(reopened, new BackendRegistry().register(new ReadyBackend()), 100)
    try {
      await expect(restarted.transfer(request, callerId)).resolves.toMatchObject({
        status: 'accepted', environmentId: recordedEnvironmentId, destination: request.plan.destination,
      })
      expect(restarted.lookupByEnvironment(recordedEnvironmentId, callerId)).toMatchObject({
        status: 'replayed', environmentId: recordedEnvironmentId,
      })
    } finally {
      reopened.close()
    }
  })

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

  it('checks the allocated environment and cwd before the public one-shot backend request', async () => {
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
    const request = withAllocation(unboundTransferRequest(), {
      workspace: { cwd: { base: 'host', path: '/tmp/portable-return' } },
    })
    const authorization = 'Bearer owner'
    const transferResponse = await app.request('/v1/context-transfers', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    expect(transferResponse.status).toBe(200)
    const receipt = await transferResponse.json() as { status: string, environmentId: string }
    expect(receipt.status).toBe('accepted')

    const body = {
      model: 'codex/gpt-5.6',
      messages: [{ role: 'user', content: 'use the transferred marker' }],
      agent_profile: profile,
      context_transfer: request,
      provider: request.plan.destination.provider,
      environment_id: receipt.environmentId,
      session_id: request.plan.destination.sessionId,
      run_id: request.plan.destination.runId,
      execution_id: request.plan.destination.executionId,
      cwd: '/tmp/portable-return',
    }
    for (const invalid of [
      { ...body, cwd: '/tmp/other-return' },
      { ...body, environment_id: 'unadmitted-environment' },
    ]) {
      const rejected = await app.request('/v1/chat/completions', {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(invalid),
      })
      expect(rejected.status).toBe(409)
      expect(backend.requests).toHaveLength(0)
    }

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    })
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.cwd).toBe('/tmp/portable-return')
    expect(backend.requests[0]?.agent_profile).toEqual(profile)
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
