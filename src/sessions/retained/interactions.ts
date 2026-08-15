/**
 * Answering one outstanding provider dialog, exactly once.
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
  type InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import { RunInteractionCancelledError, type RunRegistry } from '../../runs/registry.js'
import type { SessionStore } from '../store.js'
import { recordValue, stringValue } from './json-values.js'
import { nativeResponseFor } from './native-turn.js'
import { ENVIRONMENT_ID } from './types.js'

type InteractionResult = { acknowledgement: InteractionAcknowledgement; status: number }

export class RetainedInteractions {
  private readonly inFlight = new Map<string, { requestDigest: string; promise: Promise<InteractionResult> }>()

  constructor(
    private readonly store: SessionStore,
    private readonly runs: RunRegistry,
  ) {}

  async respond(
    value: unknown,
    callerId: string,
    routeBinding?: { runId: string; interactionId: string },
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
    const existing = this.store.getInteractionOperation(command.operationId)
    if (existing) {
      if (existing.requestDigest === requestDigest)
        return { acknowledgement: existing.acknowledgement, status: statusForAcknowledgement(existing.acknowledgement) }
      const conflict: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding: command.binding,
        commandDigest: command.commandDigest,
        status: 'already_resolved_different',
        message: 'operation id was already used with a different caller or response body',
      }
      return { acknowledgement: conflict, status: 409 }
    }

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

    const promise = this.resolve(command, callerId, requestDigest)
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
  ): Promise<InteractionResult> {
    const binding = command.binding
    const run = this.runs.get(binding.runId)
    const record = binding.sessionId
      ? this.store.getRetained(binding.sessionId)
      : run?.sessionId
        ? this.store.getRetained(run.sessionId)
        : null
    if (
      !record ||
      binding.environmentId !== ENVIRONMENT_ID ||
      binding.sessionId !== record.id ||
      !run ||
      run.sessionId !== record.id ||
      run.executionId !== binding.executionId ||
      binding.provider !== record.backend
    ) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: run ? 'binding_mismatch' : 'unknown_run',
        message: run ? 'interaction binding does not match the retained session' : 'run is unknown after process loss',
      }
      this.record(command, callerId, binding.sessionId ?? '', requestDigest, acknowledgement)
      return { acknowledgement, status: run ? 409 : 404 }
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
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return { acknowledgement, status: 409 }
    }
    if (!pending) {
      const resolvedDigest = run.resolvedInteractionDigest(binding.interactionId)
      const status = resolvedDigest
        ? resolvedDigest === canonicalCandidateDigest(command.response)
          ? 'already_resolved_same'
          : 'already_resolved_different'
        : run.interactionWasCancelled(binding.interactionId)
          ? 'cancelled'
          : run.interactionIsResolving(binding.interactionId)
            ? 'already_resolved_different'
            : 'unknown_interaction'
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status,
        message: 'interaction is no longer outstanding',
      }
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return {
        acknowledgement,
        status: status === 'unknown_interaction' ? 404 : status === 'already_resolved_same' ? 200 : 409,
      }
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
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return { acknowledgement, status: 400 }
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
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return { acknowledgement, status: 409 }
    }
    try {
      await run.withNativeControl(async (native) => {
        await native.respondToNativeInteraction(claimed.nativeId, nativeResponseFor(claimed.request, command.response))
        run.resolveInteraction(binding.interactionId, canonicalCandidateDigest(command.response))
      })
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'accepted',
      }
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return { acknowledgement, status: 200 }
    } catch (error) {
      run.releaseInteractionClaim(binding.interactionId)
      if (
        error instanceof RunInteractionCancelledError ||
        run.interactionWasCancelled(binding.interactionId) ||
        run.isCancelling()
      ) {
        const acknowledgement: InteractionAcknowledgement = {
          operationId: command.operationId,
          binding,
          commandDigest: command.commandDigest,
          status: 'cancelled',
          message: 'interaction was cancelled before its response became effective',
        }
        this.record(command, callerId, record.id, requestDigest, acknowledgement)
        return { acknowledgement, status: 409 }
      }
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        commandDigest: command.commandDigest,
        status: 'transport_failure',
        message: `response effect was not proven and will not be repeated: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      }
      this.record(command, callerId, record.id, requestDigest, acknowledgement)
      return { acknowledgement, status: 502 }
    }
  }

  private record(
    command: InteractionResponseCommand,
    callerId: string,
    sessionId: string,
    requestDigest: string,
    acknowledgement: InteractionAcknowledgement,
  ): void {
    this.store.recordInteractionOperation({
      operationId: command.operationId,
      callerId,
      runId: command.binding.runId,
      sessionId,
      interactionId: command.binding.interactionId,
      requestDigest,
      acknowledgement,
    })
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
