import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  AgentEnvironmentCapabilitiesSchema,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  createContextTransferRequest,
  portableContextPlanDigest,
  portableConversationContextDigest,
  type AgentProfile,
  type ContextTransferRequest,
  type PortableConversationContext,
} from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest, PreparedContextTransfer } from '../src/backends/types.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { RetainedContextTransfers } from '../src/sessions/retained/context-transfer.js'
import { readyBackendCapabilities } from '../src/sessions/retained/capabilities.js'
import { contextTransferRoute } from '../src/backends/profile-support.js'
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
  creations = 0
  imports = 0
  failCreation = false
  failImport = false

  validateContextTransfer(): void {}

  prepareContextTransfer(): Promise<PreparedContextTransfer> {
    return Promise.resolve({
      createSession: async () => {
        this.creations += 1
        if (this.failCreation) throw new Error('creation acknowledgement lost')
        return { nativeSessionId: 'native-destination', createdAt: '2026-08-01T20:00:03.000Z' }
      },
      importHistory: async () => {
        this.imports += 1
        if (this.failImport) throw new Error('injection acknowledgement lost')
      },
      close: async () => {},
    })
  }

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

interface TransferRequestOptions {
  operationId?: string
  acceptedBy?: 'system' | 'policy'
  /** Bind the destination environment in the accepted plan instead of letting the receiver allocate it. */
  bound?: boolean
  destinationProfile?: AgentProfile
  workspace?: ContextTransferRequest['workspace']
  resources?: ContextTransferRequest['resources']
}

/** Build the complete local plan and project it through the shared constructor, as consumers do. */
function buildTransferRequest(options: TransferRequestOptions = {}): ContextTransferRequest {
  const destinationProfile = options.destinationProfile ?? profile
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
    ...(options.bound === false ? {} : { environmentId: 'environment-destination' }),
    sessionId: 'session-destination',
    runId: 'run-destination',
    executionId: 'execution-destination',
    model: 'gpt-5.6',
    profileDigest: canonicalAgentProfileDigest(destinationProfile),
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
  return createContextTransferRequest({
    operationId: options.operationId ?? 'transfer-1',
    plan,
    profile: destinationProfile,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    acceptance: {
      planDigest: plan.digest,
      acceptedAt: '2026-08-01T20:00:02.000Z',
      acceptedBy: options.acceptedBy ?? 'system',
    },
  })
}

function transferRequest(
  operationId = 'transfer-1',
  acceptedBy: 'system' | 'policy' = 'system',
): ContextTransferRequest {
  return buildTransferRequest({ operationId, acceptedBy })
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
  const { environmentId } = request.plan.destination
  if (environmentId === undefined) throw new Error('fixture destination must bind its environment')
  return {
    provider: request.plan.destination.provider,
    environmentId,
    sessionId: request.plan.destination.sessionId,
    runId: request.plan.destination.runId,
    executionId: request.plan.destination.executionId,
    model: 'codex/gpt-5.6',
    profile,
  }
}

function unboundTransferRequest(
  operationId = 'transfer-unbound',
  allocation: Pick<TransferRequestOptions, 'workspace' | 'resources'> = {},
): ContextTransferRequest {
  return buildTransferRequest({ operationId, bound: false, ...allocation })
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
  it('reports attachment only for a backend that imports into a fresh native session', async () => {
    const native = new ReadyBackend()
    const unavailable = Object.assign(new ReadyBackend(), { contextTransferAvailable: () => false })
    const backend = new ReadyBackend()
    const oneShot: Backend = {
      name: backend.name, matches: (model) => backend.matches(model),
      health: () => backend.health(), chat: (request) => backend.chat(request),
    }
    const document = async (candidate: Backend) => (await readyBackendCapabilities({
      registry: new BackendRegistry().register(candidate), model: 'codex/gpt-5.6', healthProbeTimeoutMs: 100,
    })).capabilities
    const supported = await document(native)
    expect(supported.contextTransfer).toEqual({ freshSession: true, requestIdempotency: true, lookup: true, attach: true })
    expect(AgentEnvironmentCapabilitiesSchema.safeParse(supported).success).toBe(true)
    for (const candidate of [unavailable, oneShot]) {
      const refused = await document(candidate)
      // Interface 5 requires lookup whenever the field is present, so an unsupported route omits it.
      expect(refused.contextTransfer).toBeUndefined()
      expect(AgentEnvironmentCapabilitiesSchema.safeParse(refused).success).toBe(true)
    }
  })

  it('binds the first turn to the route the CLI Bridge provider attaches with', async () => {
    const qualified: AgentProfile = { ...profile, model: { provider: 'openai', default: 'gpt-5.5' } }
    const request = buildTransferRequest({ operationId: 'transfer-route', bound: false, destinationProfile: qualified })
    expect(contextTransferRoute(request)).toBe('codex/openai/gpt-5.6')
    const { store, transfers } = fixture()
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      const receipt = await transfers.transfer(request, callerId)
      if (receipt.status !== 'accepted') throw new Error('transfer was not accepted')
      expect(store.get(request.plan.destination.sessionId, 'codex')?.metadata.agent_profile_binding).toMatchObject({
        model: 'codex/openai/gpt-5.6', provider: 'openai',
      })
      const attached = {
        ...destination(transferRequest()), environmentId: receipt.environmentId,
        model: 'codex/openai/gpt-5.6', profile: qualified,
      }
      expect(transfers.messagesForTurn(request, callerId, attached)).toEqual([])
      expect(() => transfers.messagesForTurn(request, callerId, { ...attached, model: 'codex/gpt-5.6' }))
        .toThrow(/destination does not match/)
    } finally {
      store.close()
    }
  })

  it.each(['create', 'inject'] as const)('holds an uncertain native %s acknowledgement across restart without another side effect', async (effect) => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-native-unknown-'))
    directories.push(directory)
    const backend = new ReadyBackend()
    backend.failCreation = effect === 'create'
    backend.failImport = effect === 'inject'
    const registry = new BackendRegistry().register(backend)
    const first = new SessionStore(directory)
    const request = unboundTransferRequest()
    const callerId = canonicalCandidateDigest('Bearer owner')
    const transfers = new RetainedContextTransfers(first, registry, 100)
    await expect(transfers.transfer(request, callerId)).resolves.toMatchObject({ status: 'unknown', retryable: false })
    expect(first.getRetainedControlOperation(request.operationId)?.acknowledgement).toMatchObject({
      status: 'pending', native: { phase: effect === 'create' ? 'allocation_started' : 'injection_started' },
    })
    if (effect === 'inject') {
      expect(first.getRetainedControlOperation(request.operationId)?.acknowledgement.native).toMatchObject({ sessionId: 'native-destination' })
    }
    expect(() => transfers.assertSessionDispatch(request.plan.destination.sessionId, callerId)).toThrow(/not authoritative/)
    expect(() => first.claimSessionIdentity(request.plan.destination.sessionId, 'legacy')).toThrow(/not authoritative/)
    expect(() => first.claimSessionIdentity(request.plan.destination.sessionId, 'retained')).toThrow(/not authoritative/)
    first.close()
    const reopened = new SessionStore(directory)
    try {
      const restarted = new RetainedContextTransfers(reopened, registry, 100)
      await expect(restarted.transfer(request, callerId)).resolves.toMatchObject({ status: 'unknown', retryable: false })
      expect(restarted.lookup(request.operationId, request.requestDigest, callerId)).toMatchObject({ status: 'unknown', retryable: false })
      expect(backend.creations).toBe(1)
      expect(backend.imports).toBe(effect === 'create' ? 0 : 1)
      expect(() => restarted.messagesForTurn(request, callerId, destination(request))).toThrow(/not complete/)
    } finally { reopened.close() }
  })

  it('replays an acknowledged native import after a lost HTTP response and receiver restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-native-http-ack-'))
    directories.push(directory)
    const backend = new ReadyBackend()
    const registry = new BackendRegistry().register(backend)
    const request = unboundTransferRequest()
    const authorization = 'Bearer owner'
    const first = new SessionStore(directory)
    const firstRuns = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const firstService = new RetainedSessionService({ store: first, registry, runs: firstRuns, healthProbeTimeoutMs: 100 })
    const firstApp = new Hono()
    mountRetainedSessions(firstApp, firstService)
    // Discard the entire response: the receiver's durable native ACK is the only recovery authority.
    await firstApp.request('/v1/context-transfers', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(request) })
    expect(first.getRetainedControlOperation(request.operationId)?.acknowledgement).toMatchObject({ status: 'accepted', native: { phase: 'imported', sessionId: 'native-destination' } })
    await firstService.shutdown(1_000)
    await firstRuns.shutdown(1_000)
    first.close()
    const reopened = new SessionStore(directory)
    const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const service = new RetainedSessionService({ store: reopened, registry, runs, healthProbeTimeoutMs: 100 })
    const app = new Hono()
    mountRetainedSessions(app, service)
    try {
      const response = await app.request('/v1/context-transfers', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(request) })
      expect(response.status).toBe(200)
      const replay = await response.json() as { status: string; environmentId: string }
      expect(replay.status).toBe('replayed')
      expect(backend.creations).toBe(1)
      expect(backend.imports).toBe(1)
      expect(reopened.get(request.plan.destination.sessionId, 'codex')?.internalId).toBe('native-destination')
      expect(service.contextMessages(request, canonicalCandidateDigest(authorization), { ...destination(request), environmentId: replay.environmentId })).toEqual([])
    } finally {
      await service.shutdown(1_000)
      await runs.shutdown(1_000)
      reopened.close()
    }
  })

  it('refuses a runner without a typed native import port before durable admission', async () => {
    const { store, directory } = fixture()
    const backend = new ReadyBackend()
    const unsupported: Backend = {
      name: backend.name, matches: (model) => backend.matches(model),
      health: () => backend.health(), chat: (request) => backend.chat(request),
    }
    const transfers = new RetainedContextTransfers(store, new BackendRegistry().register(unsupported), 100)
    const request = unboundTransferRequest()
    try {
      await expect(transfers.transfer(request, canonicalCandidateDigest('owner'))).rejects.toMatchObject({ status: 501, code: 'capability_denied' })
      expect(store.getRetainedControlOperation(request.operationId)).toBeNull()
    } finally { store.close() }
  })

  it('refuses to allocate over an existing logical session', async () => {
    const { store, transfers } = fixture()
    const request = unboundTransferRequest()
    store.remember({ externalId: request.plan.destination.sessionId, backend: 'codex', model: 'codex/gpt-5.6', internalId: 'existing-native-thread' })
    try {
      await expect(transfers.transfer(request, canonicalCandidateDigest('owner'))).resolves.toMatchObject({ status: 'unknown', retryable: false })
      expect(store.getRetainedControlOperation(request.operationId)).toBeNull()
    } finally { store.close() }
  })

  it('accepts the exact portable profile through the public transfer route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-bridge-context-profile-'))
    directories.push(directory)
    const store = new SessionStore(directory)
    const registry = new BackendRegistry().register(new ReadyBackend())
    const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const service = new RetainedSessionService({ store, registry, runs, healthProbeTimeoutMs: 100 })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const request = transferRequest()
    expect(request.plan.kind).toBe('portable-context-transfer-plan')

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
      })).toHaveLength(0)
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
    const pending: Promise<unknown>[] = []
    try {
      const firstAdmission = receiver(first.store, firstReady, firstEntered).transfer(request, callerId)
      const secondAdmission = receiver(secondStore, secondReady, secondEntered).transfer(request, callerId)
      pending.push(firstAdmission, secondAdmission)
      await Promise.all([firstEntered.promise, secondEntered.promise])
      firstReady.resolve()
      const accepted = await firstAdmission
      if (accepted.status !== 'accepted') throw new Error('first transfer was not accepted')
      secondReady.resolve()
      await expect(secondAdmission).resolves.toEqual({ ...accepted, status: 'replayed' })
    } finally {
      firstReady.resolve()
      secondReady.resolve()
      await Promise.allSettled(pending)
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
      const changedRequests = [
        buildTransferRequest({
          operationId: request.operationId, bound: false,
          destinationProfile: { ...profile, name: 'different-profile' },
        }),
        unboundTransferRequest(request.operationId, { workspace: { cwd: { base: 'host', path: '/tmp/changed-portable-return' } } }),
        unboundTransferRequest(request.operationId, { resources: { cpu: 2 } }),
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
    const request = unboundTransferRequest('transfer-unbound', {
      workspace: { cwd: { base: 'host', path: '/tmp/portable-return' } },
    })
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      const receipt = await transfers.transfer(request, callerId)
      if (receipt.status !== 'accepted') throw new Error('transfer was not accepted')
      const actual = { ...destination(request), environmentId: receipt.environmentId, cwd: '/tmp/portable-return' }
      expect(transfers.messagesForTurn(request, callerId, actual)).toHaveLength(0)
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
    const request = unboundTransferRequest('transfer-unbound', allocation)
    const callerId = canonicalCandidateDigest('Bearer owner')
    try {
      await expect(transfers.transfer(request, callerId)).rejects.toMatchObject({ status: 400, code: 'capability_denied' })
      expect(transfers.lookup(request.operationId, request.requestDigest, callerId)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('holds legacy receipts without native import proof after restart', async () => {
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
        status: 'unknown', retryable: false,
      })
      await expect(restarted.transfer(request, callerId)).resolves.toMatchObject({ status: 'unknown', retryable: false })
      expect(() => restarted.messagesForTurn(request, callerId, destination(request))).toThrow(/not complete/)
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
    expect(first.transfers.messagesForTurn(request, callerId, destination(request))).toEqual([])

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
    expect(restarted.messagesForTurn(request, callerId, destination(request))).toHaveLength(0)
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
    const request = unboundTransferRequest('transfer-unbound', {
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
      { ...body, context_transfer: undefined },
      { ...body, execution: { kind: 'sandbox' } },
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
      { role: 'user', content: 'use the transferred marker' },
    ])

    await runs.shutdown(1_000)
    await service.shutdown(1_000)
    store.close()
  })
})
