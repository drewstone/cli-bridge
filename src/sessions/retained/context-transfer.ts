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
  type InputPart,
  type PortableContextDestination,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../../backends/registry.js'
import type { ChatMessage } from '../../backends/types.js'
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
    if (stored.status === 'pending') {
      return unknown(stored.binding, 'context transfer admission is pending', true)
    }
    return replayedReceipt(stored.binding, stored.receipt)
  }

  lookupByEnvironment(environmentId: string, callerId: string): ContextTransferResult | null {
    const operation = this.store.findContextTransferByEnvironmentId(environmentId)
    if (!operation || operation.callerId !== callerId) return null
    const stored = storedAcknowledgement(operation)
    if (stored.binding.environmentId !== environmentId) return null
    if (stored.status === 'pending') {
      return unknown(stored.binding, 'context transfer admission is pending', true)
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
    if (stored.status !== 'accepted' || !stored.receipt) {
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
    return request.plan.context.messages.map((message): ChatMessage => ({
      role: message.role,
      content: message.parts.map(parsePortableInputPart),
    }))
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
    try {
      await readyBackendCapabilities({
        registry: this.registry,
        model: destinationModel(request),
        healthProbeTimeoutMs: this.healthProbeTimeoutMs,
        signal,
      })
    } catch (error) {
      return unknown(
        request,
        `destination runner is not ready: ${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    }

    const sessionCreatedAt = new Date().toISOString()
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
    }
    if (
      !this.store.updateRetainedControlOperation(
        request.operationId,
        request.requestDigest,
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
  if (raw.status === 'pending') return { status: 'pending', binding }
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
  return { status: 'accepted', binding, receipt: receipt.data }
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

function parsePortableInputPart(value: unknown): InputPart {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new RetainedSessionError(
      'stored context transfer contains an invalid input part',
      409,
      'context_transfer_unknown',
    )
  }
  const part = value as Record<string, unknown>
  if (part.type === 'text' && typeof part.text === 'string') return value as InputPart
  if (part.type === 'file' || part.type === 'image') return value as InputPart
  throw new RetainedSessionError(
    'stored context transfer contains an unsupported input part',
    409,
    'context_transfer_unknown',
  )
}
