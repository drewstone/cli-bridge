/** Durable admission and consumption of portable context for one fresh session. */

import { randomUUID } from 'node:crypto'
import {
  ContextTransferReceiptSchema,
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
  contextTransferReceiptMatches,
  PortableContextDestinationSchema,
  workspaceCwdPathForBase,
  type AgentProfile,
  type ContextTransferReceipt,
  type ContextTransferRequest,
  type ContextTransferResult,
  type PortableContextDestination,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../../backends/registry.js'
import type { Backend, ChatMessage, ProfileMaterializationReceipt } from '../../backends/types.js'
import { exactSessionProfileBinding } from '../../backends/profile-support.js'
import type { SessionStore, StoredRetainedControlOperation } from '../store.js'
import { readyBackendCapabilities } from './capabilities.js'
import { RetainedSessionError } from './types.js'

interface StoredContextTransferBinding {
  operationId: string
  requestDigest: Sha256Digest
  planDigest: Sha256Digest
  contextDigest: Sha256Digest
  environmentId: string
  destination: PortableContextDestination
}

interface StoredContextTransferAcknowledgement {
  status: 'pending' | 'accepted'
  binding: StoredContextTransferBinding
  receipt?: ContextTransferReceipt
  native?: {
    backend: string
    phase: 'allocation_started' | 'created' | 'injection_started' | 'imported'
    sessionId?: string
    createdAt?: string
    profileMaterialization?: ProfileMaterializationReceipt
  }
}

export interface ContextTransferConsumption {
  provider: string
  environmentId: string
  sessionId: string
  runId: string
  executionId: string
  model: string
  profile: AgentProfile | undefined
  cwd?: string
  executionKind?: 'host' | 'sandbox'
}

export class RetainedContextTransfers {
  private readonly pending = new Map<string, Promise<ContextTransferResult>>()

  constructor(
    private readonly store: SessionStore,
    private readonly registry: BackendRegistry,
    private readonly healthProbeTimeoutMs: number,
  ) {}

  async transfer(
    value: unknown,
    callerId: string,
    signal?: AbortSignal,
  ): Promise<ContextTransferResult> {
    const request = parseTransferRequest(value)
    const key = `${callerId}:${request.operationId}:${request.requestDigest}`
    const active = this.pending.get(key)
    if (active) return active
    const operation = this.admit(request, callerId, signal)
    this.pending.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key)
    }
  }

  lookup(
    operationId: string,
    requestDigest: string,
    callerId: string,
  ): ContextTransferResult | null {
    const operation = this.store.getRetainedControlOperation(operationId)
    if (!operation || operation.kind !== 'context_transfer' || operation.callerId !== callerId) return null
    if (operation.requestDigest !== requestDigest) {
      return conflict(operationId, requestDigest, operation.requestDigest)
    }
    const stored = storedAcknowledgement(operation)
    if (stored.status === 'pending' || stored.native?.phase !== 'imported') {
      return unknown(stored.binding, 'native context import is not acknowledged', nativeRetrySafe(stored))
    }
    return replayedReceipt(stored.binding, stored.receipt)
  }

  lookupByEnvironment(environmentId: string, callerId: string): ContextTransferResult | null {
    const operation = this.store.findContextTransferByEnvironmentId(environmentId)
    if (!operation || operation.callerId !== callerId) return null
    const stored = storedAcknowledgement(operation)
    if (stored.binding.environmentId !== environmentId) return null
    if (stored.status === 'pending' || stored.native?.phase !== 'imported') {
      return unknown(stored.binding, 'native context import is not acknowledged', nativeRetrySafe(stored))
    }
    return replayedReceipt(stored.binding, stored.receipt)
  }

  messagesForTurn(
    value: unknown,
    callerId: string,
    destination: ContextTransferConsumption,
  ): ChatMessage[] {
    const request = parseTransferRequest(value)
    const operation = this.store.getRetainedControlOperation(request.operationId)
    if (
      !operation ||
      operation.kind !== 'context_transfer' ||
      operation.callerId !== callerId ||
      operation.requestDigest !== request.requestDigest
    ) {
      throw new RetainedSessionError(
        'context transfer was not admitted for this caller and request',
        409,
        'context_transfer_not_admitted',
      )
    }
    const stored = storedAcknowledgement(operation)
    if (stored.status !== 'accepted' || !stored.receipt || stored.native?.phase !== 'imported') {
      throw new RetainedSessionError(
        'context transfer admission is not complete',
        409,
        'context_transfer_pending',
      )
    }
    if (
      !bindingMatchesRequest(stored.binding, request) ||
      !contextTransferReceiptMatches(request, stored.receipt)
    ) {
      throw new RetainedSessionError(
        'stored context transfer does not match the requested plan',
        409,
        'context_transfer_conflict',
      )
    }
    assertDestination(request, destination, stored.binding.environmentId)
    // The native session already owns the selected typed messages. Feeding them
    // through the prompt path again would duplicate and flatten their history.
    return []
  }

  assertSessionDispatch(sessionId: string, callerId: string, dispatch?: { backend: string; hasTransferRequest: boolean; executionKind: 'host' | 'sandbox' }): void {
    const operation = this.store.findContextTransferBySessionId(sessionId)
    if (!operation) return
    const stored = storedAcknowledgement(operation)
    if (operation.callerId !== callerId || stored.status !== 'accepted' || stored.native?.phase !== 'imported') {
      throw new RetainedSessionError('native context import is not authoritative for this session and caller', 409, 'context_transfer_pending')
    }
    const session = this.store.get(sessionId, stored.native.backend)
    if (session?.internalId !== stored.native.sessionId || (dispatch && (dispatch.backend !== stored.native.backend || dispatch.executionKind !== 'host'))) {
      throw new RetainedSessionError('native context import is bound to a different session or executor', 409, 'context_transfer_destination_conflict')
    }
    if (dispatch && session.turns === 0 && !dispatch.hasTransferRequest) {
      throw new RetainedSessionError('the first native turn requires its exact authoritative transfer receipt', 409, 'context_transfer_not_admitted')
    }
  }

  private async admit(
    request: ContextTransferRequest,
    callerId: string,
    signal?: AbortSignal,
  ): Promise<ContextTransferResult> {
    // Preserve an existing operation's conflict/replay result, but never record
    // a new admission for allocation fields this local provider cannot honor.
    if (!this.store.getRetainedControlOperation(request.operationId)) {
      assertSupportedAllocation(request)
      if (!request.profile) throw new RetainedSessionError('typed native context import requires its exact frozen public profile', 400, 'capability_denied')
      const backend = this.registry.resolve(destinationModel(request))
      if (!backend?.validateContextTransfer || !backend.prepareContextTransfer) {
        throw new RetainedSessionError('destination runner does not support typed native context import', 501, 'capability_denied')
      }
      backend.validateContextTransfer(request)
    }
    let binding = bindingFor(request)
    const pendingAcknowledgement: StoredContextTransferAcknowledgement = {
      status: 'pending',
      binding,
    }
    const operation: StoredRetainedControlOperation = {
      operationId: request.operationId,
      callerId,
      kind: 'context_transfer',
      runId: request.plan.destination.runId,
      sessionId: request.plan.destination.sessionId,
      requestDigest: request.requestDigest,
      acknowledgement: pendingAcknowledgement as unknown as Record<string, unknown>,
    }
    const claim = this.store.claimContextTransferOperation(operation, {
      environmentId: binding.environmentId,
      executionId: request.plan.destination.executionId,
    })
    if (claim.kind === 'session_conflict') {
      return unknown(request, 'context transfer requires a fresh logical session', false)
    }
    if (claim.kind === 'coordinate_conflict') {
      return conflict(request.operationId, request.requestDigest, claim.operation.requestDigest)
    }
    if (claim.kind === 'existing') {
      if (claim.operation.callerId !== callerId) {
        return unknown(request, 'context transfer operation is owned by another caller', false)
      }
      if (claim.operation.requestDigest !== request.requestDigest) {
        return conflict(request.operationId, request.requestDigest, claim.operation.requestDigest)
      }
      const stored = storedAcknowledgement(claim.operation)
      if (!bindingMatchesRequest(stored.binding, request)) {
        return unknown(request, 'stored context transfer binding does not match the request', false)
      }
      if (stored.status === 'accepted' && stored.native?.phase !== 'imported') {
        return unknown(stored.binding, 'legacy receipt has no acknowledged native import', false)
      }
      if (stored.status === 'accepted') {
        return replayedReceipt(stored.binding, stored.receipt, request)
      }
      // A prior pending admission owns the allocated ID across process restart.
      binding = stored.binding
    }

    assertSupportedAllocation(request)

    const acceptedAt = Date.parse(request.acceptance.acceptedAt)
    if (acceptedAt > Date.now()) {
      return unknown(request, 'context transfer acceptance time is in the future', false)
    }
    let backend: Backend
    try {
      const ready = await readyBackendCapabilities({
        registry: this.registry,
        model: destinationModel(request),
        healthProbeTimeoutMs: this.healthProbeTimeoutMs,
        signal,
      })
      backend = ready.backend
      if (!backend.validateContextTransfer || !backend.prepareContextTransfer || !request.profile || ready.capabilities.contextTransfer?.freshSession !== true) {
        return unknown(binding, 'destination runner cannot import this exact public profile and typed context', false)
      }
      backend.validateContextTransfer(request)
    } catch (error) {
      return unknown(
        request,
        `destination runner is not ready: ${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    }

    const imported = await this.importNative(request, binding, backend, signal ?? new AbortController().signal)
    if (imported.status === 'accepted' && imported.native?.phase === 'imported') return replayedReceipt(binding, imported.receipt, request)
    if (imported.status !== 'pending' || imported.native?.phase !== 'imported' || !imported.native.sessionId || !imported.native.createdAt) {
      return unknown(binding, 'native import acknowledgement is pending; no native operation will be repeated', false)
    }
    const sessionCreatedAt = imported.native.createdAt
    this.store.remember({
      externalId: binding.destination.sessionId,
      backend: imported.native.backend,
      internalId: imported.native.sessionId,
      model: destinationModel(request),
      contextTransferAdmission: { operationId: request.operationId, requestDigest: request.requestDigest },
      cwd: request.workspace?.cwd ? workspaceCwdPathForBase(request.workspace.cwd) : undefined,
      metadata: {
        agent_profile: request.profile,
        agent_profile_binding: exactSessionProfileBinding({
          model: destinationModel(request), messages: [], agent_profile: request.profile,
        }, null),
        ...(imported.native.profileMaterialization ? { profile_materialization: imported.native.profileMaterialization } : {}),
      },
    })
    const receipt = ContextTransferReceiptSchema.parse({
      status: 'accepted',
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      planDigest: request.plan.digest,
      contextDigest: request.plan.context.digest,
      source: request.plan.source.source,
      destination: request.plan.destination,
      provider: request.plan.destination.provider,
      environmentId: binding.environmentId,
      sessionId: request.plan.destination.sessionId,
      runId: request.plan.destination.runId,
      executionId: request.plan.destination.executionId,
      sessionCreatedForOperationId: request.operationId,
      sessionCreatedAt,
      transferredMessageIds: request.plan.messages
        .filter((message) => message.action === 'include')
        .map((message) => message.messageId),
      omittedMessageIds: request.plan.messages
        .filter((message) => message.action === 'omit')
        .map((message) => message.messageId),
      admittedAt: new Date().toISOString(),
    })
    if (!contextTransferReceiptMatches(request, receipt)) {
      return unknown(request, 'context transfer receipt does not match its accepted plan', false)
    }
    const acknowledgement: StoredContextTransferAcknowledgement = {
      status: 'accepted',
      binding,
      receipt,
      native: imported.native,
    }
    if (
      !this.store.compareContextTransferAcknowledgement(
        request.operationId,
        request.requestDigest,
        imported as unknown as Record<string, unknown>,
        acknowledgement as unknown as Record<string, unknown>,
      )
    ) {
      const raced = this.store.getRetainedControlOperation(request.operationId)
      if (!raced || raced.callerId !== callerId || raced.requestDigest !== request.requestDigest) {
        return unknown(request, 'context transfer admission changed before commit', true)
      }
      const stored = storedAcknowledgement(raced)
      if (!bindingMatchesRequest(stored.binding, request)) {
        return unknown(request, 'context transfer admission changed before commit', false)
      }
      return replayedReceipt(stored.binding, stored.receipt, request)
    }
    return receipt
  }

  private async importNative(
    request: ContextTransferRequest,
    binding: StoredContextTransferBinding,
    backend: Backend,
    signal: AbortSignal,
  ): Promise<StoredContextTransferAcknowledgement> {
    let currentOperation = this.store.getRetainedControlOperation(request.operationId)!
    let current = storedAcknowledgement(currentOperation)
    if (current.status === 'accepted' || current.native?.phase === 'imported') return current
    if (current.native?.phase === 'allocation_started' || current.native?.phase === 'injection_started') return current
    const transition = (next: StoredContextTransferAcknowledgement): boolean => {
      const won = this.store.compareContextTransferAcknowledgement(
        request.operationId, request.requestDigest,
        currentOperation.acknowledgement, next as unknown as Record<string, unknown>,
      )
      currentOperation = this.store.getRetainedControlOperation(request.operationId)!
      current = storedAcknowledgement(currentOperation)
      return won
    }
    const needsCreation = !current.native
    if (needsCreation) {
      if (!transition({ ...current, native: { backend: backend.name, phase: 'allocation_started' } })) return current
    } else {
      if (!transition({ ...current, native: { ...current.native!, phase: 'injection_started' } })) return current
    }
    let prepared: Awaited<ReturnType<NonNullable<Backend['prepareContextTransfer']>>> | undefined
    try {
      prepared = await backend.prepareContextTransfer!(request, binding.environmentId, signal)
      if (needsCreation) {
        const created = await prepared.createSession()
        if (!created.nativeSessionId || !Number.isFinite(Date.parse(created.createdAt))) throw new Error('native creation returned an invalid identity')
        if (!transition({ ...current, native: {
          backend: backend.name, phase: 'created', sessionId: created.nativeSessionId, createdAt: created.createdAt,
          ...(prepared.profileMaterialization ? { profileMaterialization: prepared.profileMaterialization } : {}),
        } })) return current
      }
      if (current.native?.phase === 'created') {
        if (!transition({ ...current, native: { ...current.native, phase: 'injection_started' } })) return current
      }
      if (current.native?.phase === 'injection_started') {
        await prepared.importHistory(current.native.sessionId!)
        transition({ ...current, native: { ...current.native!, phase: 'imported' } })
      }
      return current
    } catch {
      // An RPC failure does not prove absence. Retain the exact operation phase
      // and owned native identity; never create or inject a second time.
      return current
    } finally {
      await prepared?.close()
    }
  }
}

function nativeRetrySafe(stored: StoredContextTransferAcknowledgement): boolean {
  return stored.status === 'pending' && (!stored.native || stored.native.phase === 'created' || stored.native.phase === 'imported')
}

function parseTransferRequest(value: unknown): ContextTransferRequest {
  const parsed = ContextTransferRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new RetainedSessionError(
      'invalid context transfer request',
      400,
      'invalid_request_error',
    )
  }
  return parsed.data
}

function storedAcknowledgement(
  operation: StoredRetainedControlOperation,
): StoredContextTransferAcknowledgement {
  const raw = operation.acknowledgement
  const binding = storedBinding(raw.binding, operation)
  const native = parseNativeAcknowledgement(raw.native)
  if (raw.status === 'pending') return { status: 'pending', binding, ...(native ? { native } : {}) }
  const receipt = ContextTransferReceiptSchema.safeParse(raw.receipt)
  if (
    raw.status !== 'accepted' ||
    !receipt.success ||
    receipt.data.status !== 'accepted' ||
    !receiptMatchesBinding(binding, receipt.data)
  ) {
    throw new RetainedSessionError(
      'stored context transfer receipt is invalid',
      409,
      'context_transfer_unknown',
    )
  }
  return { status: 'accepted', binding, receipt: receipt.data, ...(native ? { native } : {}) }
}

function parseNativeAcknowledgement(value: unknown): StoredContextTransferAcknowledgement['native'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw invalidStoredBinding()
  const native = value as NonNullable<StoredContextTransferAcknowledgement['native']>
  if (typeof native.backend !== 'string' || !native.backend || !['allocation_started', 'created', 'injection_started', 'imported'].includes(native.phase)
    || (native.phase !== 'allocation_started' && (typeof native.sessionId !== 'string' || !native.sessionId || !Number.isFinite(Date.parse(native.createdAt ?? ''))))) {
    throw invalidStoredBinding()
  }
  return native
}

function bindingFor(request: ContextTransferRequest): StoredContextTransferBinding {
  return {
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    planDigest: request.plan.digest,
    contextDigest: request.plan.context.digest,
    environmentId: request.plan.destination.environmentId ?? randomUUID(),
    destination: request.plan.destination,
  }
}

function storedBinding(
  value: unknown,
  operation: StoredRetainedControlOperation,
): StoredContextTransferBinding {
  if (!value || typeof value !== 'object') {
    throw invalidStoredBinding()
  }
  const raw = value as Record<string, unknown>
  const destination = PortableContextDestinationSchema.safeParse(raw.destination)
  // Older acknowledgements bound the environment directly in the accepted plan.
  const environmentId = raw.environmentId === undefined
    ? destination.success ? destination.data.environmentId : undefined
    : typeof raw.environmentId === 'string' ? raw.environmentId : undefined
  const allocatedDestination = destination.success && environmentId !== undefined
    ? PortableContextDestinationSchema.safeParse({ ...destination.data, environmentId })
    : undefined
  if (
    raw.operationId !== operation.operationId ||
    raw.requestDigest !== operation.requestDigest ||
    !isSha256Digest(raw.requestDigest) ||
    !isSha256Digest(raw.planDigest) ||
    !isSha256Digest(raw.contextDigest) ||
    !destination.success ||
    !allocatedDestination?.success ||
    environmentId === undefined ||
    (destination.data.environmentId !== undefined && environmentId !== destination.data.environmentId) ||
    destination.data.runId !== operation.runId ||
    destination.data.sessionId !== operation.sessionId
  ) {
    throw invalidStoredBinding()
  }
  return {
    operationId: operation.operationId,
    requestDigest: raw.requestDigest,
    planDigest: raw.planDigest,
    contextDigest: raw.contextDigest,
    environmentId,
    destination: destination.data,
  }
}

function invalidStoredBinding(): RetainedSessionError {
  return new RetainedSessionError(
    'stored context transfer binding is invalid',
    409,
    'context_transfer_unknown',
  )
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

function bindingMatchesRequest(
  binding: StoredContextTransferBinding,
  request: ContextTransferRequest,
): boolean {
  return (
    binding.operationId === request.operationId &&
    binding.requestDigest === request.requestDigest &&
    binding.planDigest === request.plan.digest &&
    binding.contextDigest === request.plan.context.digest &&
    canonicalCandidateDigest(binding.destination) ===
      canonicalCandidateDigest(request.plan.destination)
  )
}

function receiptMatchesBinding(
  binding: StoredContextTransferBinding,
  receipt: ContextTransferReceipt,
): boolean {
  const destination = binding.destination
  return (
    receipt.operationId === binding.operationId &&
    receipt.requestDigest === binding.requestDigest &&
    receipt.planDigest === binding.planDigest &&
    receipt.contextDigest === binding.contextDigest &&
    canonicalCandidateDigest(receipt.destination) === canonicalCandidateDigest(destination) &&
    receipt.provider === destination.provider &&
    receipt.environmentId === binding.environmentId &&
    receipt.sessionId === destination.sessionId &&
    receipt.runId === destination.runId &&
    receipt.executionId === destination.executionId &&
    receipt.sessionCreatedForOperationId === binding.operationId
  )
}

function replayedReceipt(
  binding: StoredContextTransferBinding,
  receipt: ContextTransferReceipt | undefined,
  request?: ContextTransferRequest,
): ContextTransferResult {
  if (
    !receipt ||
    !receiptMatchesBinding(binding, receipt) ||
    (request !== undefined &&
      (!bindingMatchesRequest(binding, request) ||
        !contextTransferReceiptMatches(request, receipt)))
  ) {
    throw new RetainedSessionError(
      'stored context transfer receipt does not match its binding',
      409,
      'context_transfer_unknown',
    )
  }
  return ContextTransferResultSchema.parse({ ...receipt, status: 'replayed' })
}

function conflict(
  operationId: string,
  requestDigest: string,
  existingRequestDigest: string,
): ContextTransferResult {
  return ContextTransferResultSchema.parse({
    status: 'conflict',
    operationId,
    requestDigest,
    existingRequestDigest,
  })
}

function unknown(
  request: Pick<ContextTransferRequest, 'operationId' | 'requestDigest'>,
  message: string,
  retryable: boolean,
): ContextTransferResult {
  return ContextTransferResultSchema.parse({
    status: 'unknown',
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    message: message.slice(0, 4_096),
    retryable,
  })
}

function destinationModel(request: ContextTransferRequest): string {
  const { runner, model } = request.plan.destination
  if (!model || model === runner || model.startsWith(`${runner}/`)) return model ?? runner
  return `${runner}/${model}`
}

function assertSupportedAllocation(request: ContextTransferRequest): void {
  const unsupported = ['environment', 'image', 'repoUrl', 'gitRef', 'checkpoint', 'providerOptions']
    .filter((key) => request.workspace?.[key as keyof NonNullable<ContextTransferRequest['workspace']>] !== undefined)
    .map((key) => `workspace.${key}`)
  if (request.resources !== undefined) unsupported.push('resources')
  if (unsupported.length > 0) {
    throw new RetainedSessionError(
      `local context transfer cannot represent ${unsupported.join(', ')}`,
      400,
      'capability_denied',
    )
  }
  try {
    workspaceCwdPathForBase(request.workspace?.cwd, 'host', 'CLI Bridge')
  } catch (error) {
    throw new RetainedSessionError(
      error instanceof Error ? error.message : String(error),
      400,
      'capability_denied',
    )
  }
}

function assertDestination(
  request: ContextTransferRequest,
  destination: ContextTransferConsumption,
  environmentId: string,
): void {
  const expected = request.plan.destination
  const expectedCwd = workspaceCwdPathForBase(request.workspace?.cwd, 'host', 'CLI Bridge')
  if (
    destination.provider !== expected.provider ||
    destination.environmentId !== environmentId ||
    destination.sessionId !== expected.sessionId ||
    destination.runId !== expected.runId ||
    destination.executionId !== expected.executionId ||
    destination.model !== destinationModel(request) ||
    (expectedCwd !== undefined && destination.cwd !== expectedCwd) ||
    (expectedCwd !== undefined && destination.executionKind === 'sandbox') ||
    destination.profile === undefined ||
    canonicalAgentProfileDigest(destination.profile) !== expected.profileDigest
  ) {
    throw new RetainedSessionError(
      'context transfer destination does not match the admitted provider, run, model, profile, or cwd',
      409,
      'context_transfer_destination_conflict',
    )
  }
}
