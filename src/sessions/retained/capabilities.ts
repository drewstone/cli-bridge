/**
 * Admission of a backend to the retained-session contract.
 *
 * A retained session is only offered by a backend that proves native session
 * support, answers a bounded health probe as ready, and advertises the whole
 * contract. A partially-capable backend is refused up front rather than
 * discovered mid-turn.
 */

import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentEnvironmentCapabilities,
  type RequestedInteractions,
} from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../../backends/registry.js'
import type { Backend, NativeSessionBackend } from '../../backends/types.js'
import { boundedProbe } from '../../backends/health.js'
import { RetainedSessionError } from './types.js'

export function isNativeBackend(backend: Backend): backend is NativeSessionBackend {
  return (
    'startNativeSession' in backend &&
    typeof (backend as { startNativeSession?: unknown }).startNativeSession === 'function'
  )
}

/** Resolve and validate the exact interaction posture for one retained turn. */
export function admittedTurnInteractions(
  capabilities: AgentEnvironmentCapabilities,
  requested: RequestedInteractions | undefined,
): RequestedInteractions {
  const supported = capabilities.interactions?.kinds ?? []
  const effective: RequestedInteractions = requested ?? Object.fromEntries(
    supported.map((kind) => [kind, true]),
  )
  const enabled = Object.entries(effective)
    .filter(([, value]) => value)
    .map(([kind]) => kind)
  const unsupported = enabled.filter((kind) => !supported.includes(kind))
  if (unsupported.length > 0) {
    throw new RetainedSessionError(
      `retained backend does not support requested interaction kinds: ${unsupported.join(', ')}`,
      400,
      'capability_denied',
    )
  }
  return Object.freeze({ ...effective })
}

export async function readyNativeBackend(input: {
  registry: BackendRegistry
  model: string
  healthProbeTimeoutMs: number
  signal?: AbortSignal
}): Promise<{ backend: NativeSessionBackend; capabilities: AgentEnvironmentCapabilities }> {
  const backend = input.registry.resolve(input.model)
  if (!backend) {
    throw new RetainedSessionError(`no backend matches model ${JSON.stringify(input.model)}`, 404, 'not_found_error')
  }
  if (!isNativeBackend(backend)) {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backend.name)} does not prove native retained-session support`,
      501,
      'capability_denied',
    )
  }
  const health: Awaited<ReturnType<Backend['health']>> = await boundedProbe(
    backend,
    input.healthProbeTimeoutMs,
    input.signal,
  )
  if (health.state !== 'ready') {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backend.name)} is not ready: ${health.detail ?? health.state}`,
      503,
      'backend_not_ready',
    )
  }
  const validated = AgentEnvironmentCapabilitiesSchema.safeParse(nativeCapabilities(backend))
  if (!validated.success) {
    throw new RetainedSessionError('backend advertised invalid Agent Interface capabilities', 500, 'server_error')
  }
  const capabilities = validated.data as AgentEnvironmentCapabilities
  assertRetainedCapabilities(capabilities, backend.name)
  return { backend, capabilities }
}

function nativeCapabilities(backend: NativeSessionBackend): AgentEnvironmentCapabilities {
  if (!backend.nativeCapabilities)
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backend.name)} did not publish native capabilities`,
      501,
      'capability_denied',
    )
  return backend.nativeCapabilities()
}

function assertRetainedCapabilities(capabilities: AgentEnvironmentCapabilities, backendName: string): void {
  if (
    !capabilities.streaming.live ||
    !capabilities.streaming.replay ||
    !capabilities.streaming.detach ||
    !capabilities.streaming.turnIdempotency ||
    capabilities.retainedControl?.exactRunIdentity !== true ||
    capabilities.retainedControl.resultIdentity !== true ||
    capabilities.retainedControl.eventIdentity !== true ||
    capabilities.retainedControl.cancellationIdempotency !== true ||
    !capabilities.sessions.continue ||
    !capabilities.sessions.list ||
    !capabilities.sessions.messages ||
    capabilities.nativeContinuation?.atomicBoundary !== true ||
    capabilities.nativeContinuation.requestIdempotency !== true ||
    !capabilities.interactions ||
    !capabilities.interactions.replay ||
    !capabilities.interactions.responseIdempotency
  ) {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backendName)} does not advertise the complete retained-session contract`,
      501,
      'capability_denied',
    )
  }
}
