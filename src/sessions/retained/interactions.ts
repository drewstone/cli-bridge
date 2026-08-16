/**
 * Answering one outstanding provider dialog without duplicate delivery.
 *
 * The response is idempotent on `operationId` and bound to `(run,
 * interaction)`. A repeat of the same bytes replays the recorded
 * acknowledgement; a different body under the same id, a second responder, a
 * withdrawn dialog, and an unprovable delivery are four distinct answers,
 * because a caller that cannot tell them apart cannot decide whether to retry.
 */

import {
  InteractionResponseCommandSchema,
  canonicalCandidateDigest,
  interactionResponseCommandDigest,
  validateInteractionResponse,
  type InteractionBinding,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import { RunInteractionCancelledError, type Run, type RunRegistry } from '../../runs/registry.js'
import type { RetainedSessionRecord } from '../store.js'
import { recordValue, stringValue } from './json-values.js'
import { nativeResponseFor } from './native-turn.js'
import {
  InteractionOperationCapacityError,
  interactionOperationMatches,
  type InteractionOperationIdentity,
  type RetainedInteractionPersistence,
  type StoredInteractionOperation,
} from './interaction-store.js'
import { ENVIRONMENT_ID } from './types.js'

type InteractionResult = { acknowledgement: InteractionAcknowledgement; status: number }
const AUTO_DENY_CALLER_ID = 'system:retained-auto-deny'
type InteractionStore = RetainedInteractionPersistence & {
  getRetained(id: string): RetainedSessionRecord | null
  findInteraction(sessionId: string, interactionId: string): InteractionRequest | null
}

export class RetainedInteractions {
  private readonly inFlight = new Map<string, { requestDigest: string; promise: Promise<InteractionResult> }>()

  constructor(
    private readonly store: InteractionStore,
    private readonly runs: RunRegistry,
  ) {}

  /**
   * Deny a provider dialog that this turn did not explicitly request.
   *
   * The request is registered in memory only, then sent through `respond`.
   * That keeps the durable operation ledger and the serialized native-control
   * lane identical to an explicit user response without advertising the
   * denied dialog as an interactive event.
   */
  async denyUnrequestedInteraction(input: {
    run: Run
    request: InteractionRequest
    nativeId: string
  }): Promise<void> {
    const binding = {
      ...input.request.binding,
      requestDigest: input.request.requestDigest,
    }
    const response = { id: input.request.id, outcome: 'cancelled' as const }
    const command = {
      operationId: canonicalCandidateDigest({ kind: 'retained-auto-deny', binding }),
      binding,
      response,
      commandDigest: interactionResponseCommandDigest({ binding, response }),
    }
    input.run.registerInteraction({ request: input.request, nativeId: input.nativeId })
    const result = await this.respond(
      command,
      AUTO_DENY_CALLER_ID,
      undefined,
      { allowUnpublished: true },
    )
    if (result.acknowledgement.status === 'transport_failure') {
      throw new Error(result.acknowledgement.message ?? 'automatic interaction denial effect is unknown')
    }
  }

  async respond(
    value: unknown,
    callerId: string,
    routeBinding?: { runId: string; interactionId: string },
    options: { allowUnpublished?: boolean } = {},
  ): Promise<InteractionResult> {
    const parsed = InteractionResponseCommandSchema.safeParse(value)
    if (!parsed.success) {
      const operationId = readOperationId(value)
      const binding = readBinding(value)
      const acknowledgement = invalidAcknowledgement(
        operationId,
        binding,
        commandDigestForInvalid(value),
        parsed.error.issues[0]?.message ?? 'invalid interaction response command',
      )
      return { acknowledgement, status: 400 }
    }
    const command = parsed.data
    const expectedCommandDigest = interactionResponseCommandDigest({
      binding: command.binding,
      response: command.response,
    })
    if (command.commandDigest !== expectedCommandDigest) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding: command.binding,
        commandDigest: command.commandDigest,
        status: 'invalid_response',
        message: 'commandDigest does not match the exact binding and response',
      }
      return { acknowledgement, status: 400 }
    }
    if (
      routeBinding &&
      (command.binding.runId !== routeBinding.runId || command.binding.interactionId !== routeBinding.interactionId)
    ) {
      return {
        acknowledgement: {
          operationId: command.operationId,
          binding: command.binding,
          commandDigest: command.commandDigest,
          status: 'binding_mismatch',
          message: 'interaction URL does not match the command binding',
        },
        status: 409,
      }
    }
    const requestDigest = canonicalCandidateDigest({ callerId, command })

    const inFlight = this.inFlight.get(command.operationId)
    if (inFlight) {
      if (inFlight.requestDigest === requestDigest) return inFlight.promise
      return {
        acknowledgement: {
          operationId: command.operationId,
          binding: command.binding,
          commandDigest: command.commandDigest,
          status: 'already_resolved_different',
          message: 'operation id is already being processed with a different caller or response body',
        },
        status: 409,
      }
    }

    const promise = this.resolve(command, callerId, requestDigest, options)
    this.inFlight.set(command.operationId, { requestDigest, promise })
    try {
      return await promise
    } finally {
      const current = this.inFlight.get(command.operationId)
      if (current?.promise === promise) this.inFlight.delete(command.operationId)
    }
  }

  private async resolve(
    command: InteractionResponseCommand,
    callerId: string,
    requestDigest: string,
    options: { allowUnpublished?: boolean },
  ): Promise<InteractionResult> {
    const binding = command.binding
    const responseDigest = canonicalCandidateDigest(command.response)
    const operation: InteractionOperationIdentity = {
      operationId: command.operationId,
      callerId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      interactionId: binding.interactionId,
      requestDigest,
      responseDigest,
    }
    const existing = this.store.getInteractionOperation(command.operationId)
    if (existing && !interactionOperationMatches(existing, operation)) {
      const conflict: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'already_resolved_different',
        message: 'operation id was already used with a different caller or response body',
      }
      return { acknowledgement: conflict, status: 409 }
    }
    if (existing) return this.reconcile(existing, command, callerId, requestDigest, responseDigest)

    const run = this.runs.get(binding.runId)
    const record = this.store.getRetained(binding.sessionId)
    const durableRequest = this.store.findInteraction(binding.sessionId, binding.interactionId)
    if (
      !record ||
      binding.sessionId !== record.id ||
      (run !== undefined && (run.sessionId !== record.id || run.executionId !== binding.executionId))
    ) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: run ? 'binding_mismatch' : 'unknown_run',
        message: run ? 'interaction binding does not match the retained session' : 'run is unknown after process loss',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    if (!durableRequest && !options.allowUnpublished) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'unknown_interaction',
        message: 'interaction is not present in retained event history',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    if (durableRequest && (
      durableRequest.requestDigest !== binding.requestDigest ||
      durableRequest.binding.runId !== binding.runId ||
      durableRequest.binding.provider !== binding.provider ||
      durableRequest.binding.environmentId !== binding.environmentId ||
      durableRequest.binding.sessionId !== binding.sessionId ||
      durableRequest.binding.executionId !== binding.executionId
    )) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'binding_mismatch',
        message: 'interaction binding does not match retained event history',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    const effectUnknown = this.store.findEffectUnknownInteraction(
      binding.runId,
      binding.sessionId,
      binding.interactionId,
    )
    if (effectUnknown) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'transport_failure',
        message: 'response effect is unknown; this interaction is permanently closed and will not be repeated',
        retryable: false,
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    if (!run) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'unknown_run',
        message: 'run is unknown after process loss',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    const pending = run.interaction(binding.interactionId)
    if (pending && (
      pending.request.requestDigest !== binding.requestDigest
      || pending.request.binding.runId !== binding.runId
      || pending.request.binding.provider !== binding.provider
      || pending.request.binding.environmentId !== binding.environmentId
      || pending.request.binding.sessionId !== binding.sessionId
      || pending.request.binding.executionId !== binding.executionId
    )) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'binding_mismatch',
        message: 'interaction request binding does not match the response binding',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    if (!pending) {
      const resolvedDigest = run.resolvedInteractionDigest(binding.interactionId)
      const status = resolvedDigest
        ? resolvedDigest === responseDigest
          ? 'already_resolved_same'
          : 'already_resolved_different'
        : run.interactionWasCancelled(binding.interactionId)
          ? 'cancelled'
          : run.interactionWasEffectUnknown(binding.interactionId)
            ? 'transport_failure'
            : run.interactionIsResolving(binding.interactionId)
              ? 'already_resolved_different'
              : 'unknown_interaction'
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status,
        message:
          status === 'transport_failure'
            ? 'response effect is unknown; this interaction is permanently closed and will not be repeated'
            : 'interaction is no longer outstanding',
        ...(status === 'transport_failure' ? { retryable: false } : {}),
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    const validation = validateInteractionResponse(pending.request, command.response)
    if (!validation.ok) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'invalid_response',
        message: validation.errors.join('; '),
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    const claimed = run.claimInteraction(binding.interactionId)
    if (!claimed) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: run.interactionWasCancelled(binding.interactionId) ? 'cancelled' : 'already_resolved_different',
        message: 'another response is already resolving this interaction',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    }
    let effectClaim: ReturnType<RetainedInteractionPersistence['beginInteractionOperation']>
    try {
      effectClaim = this.store.beginInteractionOperation(operation)
    } catch (error) {
      run.releaseInteractionClaim(binding.interactionId)
      if (error instanceof InteractionOperationCapacityError) {
        return {
          acknowledgement: {
            operationId: command.operationId,
            binding,
            commandDigest: command.commandDigest,
            status: 'transport_failure',
            message: error.message,
            retryable: true,
          },
          status: 429,
        }
      }
      throw error
    }
    if (effectClaim.kind !== 'created') {
      run.releaseInteractionClaim(binding.interactionId)
      if (effectClaim.kind === 'replayed') {
        return this.reconcile(effectClaim.operation, command, callerId, requestDigest, responseDigest)
      }
      const conflict: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'already_resolved_different',
        message: 'operation id was already used with a different caller or response body',
      }
      return { acknowledgement: conflict, status: 409 }
    }
    try {
      await run.withNativeControl(async (native) => {
        await native.respondToNativeInteraction(claimed.nativeId, nativeResponseFor(claimed.request, command.response))
        this.store.recordInteractionEffect(command.operationId, requestDigest, responseDigest)
        run.resolveInteraction(binding.interactionId, responseDigest)
      })
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'accepted',
      }
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    } catch (error) {
      const current = this.store.getInteractionOperation(command.operationId)
      if (current?.phase === 'acknowledged' || current?.phase === 'effect_unknown' || current?.phase === 'effect_proven') {
        return this.reconcile(current, command, callerId, requestDigest, responseDigest)
      }
      if (
        error instanceof RunInteractionCancelledError ||
        run.interactionWasCancelled(binding.interactionId) ||
        run.isCancelling()
      ) {
        run.releaseInteractionClaim(binding.interactionId)
        const acknowledgement: InteractionAcknowledgement = {
          operationId: command.operationId,
          binding,
          commandDigest: command.commandDigest,
          status: 'cancelled',
          message: 'interaction was cancelled before its response became effective',
        }
        return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
      }
      run.markInteractionEffectUnknown(binding.interactionId)
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'transport_failure',
        message: `response effect was not proven and will not be repeated: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      }
      try {
        const persisted = this.store.markInteractionEffectUnknown(
          command.operationId,
          requestDigest,
          responseDigest,
          acknowledgement,
        )
        return this.resultForStoredOperation(persisted)
      } catch {
        // The intent is still durable. A later process will reconcile it as
        // unknown before it can attempt another native effect.
        return { acknowledgement, status: 502 }
      }
    }
  }

  private reconcile(
    operation: StoredInteractionOperation,
    command: InteractionResponseCommand,
    callerId: string,
    requestDigest: string,
    responseDigest: string,
  ): InteractionResult {
    if (operation.phase === 'acknowledged' || operation.phase === 'effect_unknown') {
      return this.resultForStoredOperation(operation)
    }
    if (operation.phase === 'intent') {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding: command.binding,
        commandDigest: command.commandDigest,
        status: 'transport_failure',
        message: 'response delivery was interrupted before its native effect was proven; it will not be repeated',
        retryable: false,
      }
      const reconciled = this.store.markInteractionEffectUnknown(
        command.operationId,
        requestDigest,
        responseDigest,
        acknowledgement,
      )
      return this.resultForStoredOperation(reconciled)
    }

    const run = this.runs.get(command.binding.runId)
    if (run?.interaction(command.binding.interactionId)) {
      run.resolveInteraction(command.binding.interactionId, responseDigest)
    }
    const acknowledgement: InteractionAcknowledgement = {
      operationId: command.operationId,
      binding: command.binding,
      commandDigest: command.commandDigest,
      status: 'accepted',
    }
    try {
      return this.persist(command, callerId, requestDigest, responseDigest, acknowledgement)
    } catch {
      const latest = this.store.getInteractionOperation(command.operationId)
      if (latest?.phase === 'acknowledged' || latest?.phase === 'effect_unknown') {
        return this.resultForStoredOperation(latest)
      }
      return {
        acknowledgement: {
          operationId: command.operationId,
          binding: command.binding,
          commandDigest: command.commandDigest,
          status: 'transport_failure',
          message: 'response effect was proven but acknowledgement persistence failed; retry is safe and will not repeat the effect',
          retryable: true,
        },
        status: 502,
      }
    }
  }

  private persist(
    command: InteractionResponseCommand,
    callerId: string,
    requestDigest: string,
    responseDigest: string,
    acknowledgement: InteractionAcknowledgement,
  ): InteractionResult {
    const persisted = this.store.recordInteractionOperation({
      operationId: command.operationId,
      callerId,
      runId: command.binding.runId,
      sessionId: command.binding.sessionId,
      interactionId: command.binding.interactionId,
      requestDigest,
      responseDigest,
      acknowledgement,
    })
    return this.resultForStoredOperation(persisted)
  }

  private resultForStoredOperation(operation: StoredInteractionOperation): InteractionResult {
    if (!operation.acknowledgement) throw new Error(`interaction operation ${JSON.stringify(operation.operationId)} has no acknowledgement`)
    return {
      acknowledgement: operation.acknowledgement,
      status: statusForAcknowledgement(operation.acknowledgement),
    }
  }
}

export function statusForAcknowledgement(acknowledgement: InteractionAcknowledgement): number {
  if (acknowledgement.status === 'unknown_run' || acknowledgement.status === 'unknown_interaction') return 404
  if (acknowledgement.status === 'invalid_response') return 400
  if (acknowledgement.status === 'transport_failure') return 502
  if (
    acknowledgement.status === 'already_resolved_different' ||
    acknowledgement.status === 'binding_mismatch' ||
    acknowledgement.status === 'cancelled' ||
    acknowledgement.status === 'expired'
  )
    return 409
  return 200
}

function readOperationId(value: unknown): string {
  return stringValue(recordValue(value)?.operationId) ?? 'invalid-operation'
}

function readBinding(value: unknown): InteractionBinding {
  const binding = recordValue(recordValue(value)?.binding)
  const fallbackDigest = canonicalCandidateDigest({ invalidInteractionCommand: value })
  return {
    requestDigest: stringValue(binding?.requestDigest) as `sha256:${string}` ?? fallbackDigest,
    runId: stringValue(binding?.runId) ?? 'unknown-run',
    provider: stringValue(binding?.provider) ?? 'unknown-provider',
    environmentId: stringValue(binding?.environmentId) ?? ENVIRONMENT_ID,
    sessionId: stringValue(binding?.sessionId) ?? 'unknown-session',
    executionId: stringValue(binding?.executionId) ?? 'unknown-execution',
    interactionId: stringValue(binding?.interactionId) ?? 'unknown-interaction',
  }
}

function commandDigestForInvalid(value: unknown): `sha256:${string}` {
  const candidate = recordValue(value)?.commandDigest
  return typeof candidate === 'string' && /^sha256:[a-f0-9]{64}$/u.test(candidate)
    ? candidate as `sha256:${string}`
    : canonicalCandidateDigest({ invalidInteractionCommand: value })
}

function invalidAcknowledgement(
  operationId: string,
  binding: InteractionBinding,
  commandDigest: `sha256:${string}`,
  message: string,
): InteractionAcknowledgement {
  return { operationId, binding, commandDigest, status: 'invalid_response', message }
}
