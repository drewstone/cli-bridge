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
  // Runtime treats every declared key as part of capability negotiation.
  // A false value denies that kind at emission time; it does not erase the
  // declaration before the provider's advertised capability is checked.
  const unsupported = Object.keys(effective).filter((kind) => !supported.includes(kind))
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
  const backend = resolveBackend(input.registry, input.model)
  if (!isNativeBackend(backend)) {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backend.name)} does not prove native retained-session support`,
      501,
      'capability_denied',
    )
  }
  await assertReady(backend, input.healthProbeTimeoutMs, input.signal)
  return { backend, capabilities: validatedNativeCapabilities(backend) }
}

/**
 * Admit either a native retained backend or a ready one-shot backend.
 *
 * Non-native routes use the same durable chat protocol for streaming, replay,
 * reconnect, status, and exact cancellation. They do not claim native session
 * continuation or native interaction controls.
 */
export async function readyBackendCapabilities(input: {
  registry: BackendRegistry
  model: string
  healthProbeTimeoutMs: number
  signal?: AbortSignal
}): Promise<{ backend: Backend; capabilities: AgentEnvironmentCapabilities }> {
  const backend = resolveBackend(input.registry, input.model)
  await assertReady(backend, input.healthProbeTimeoutMs, input.signal)
  return isNativeBackend(backend)
    ? { backend, capabilities: validatedNativeCapabilities(backend) }
    : { backend, capabilities: genericCliBridgeCapabilities(backend.name) }
}

/**
 * The conservative capability document for a ready non-native backend.
 *
 * A generic backend proves only one-shot streaming and the bridge's durable
 * run protocol. It does not prove provider continuation, profile materializers,
 * tools, MCP, subagents, detach, or usage receipts.
 */
export function genericCliBridgeCapabilities(_backendName?: string): AgentEnvironmentCapabilities {
  const candidate: AgentEnvironmentCapabilities = {
    profile: {
      namedProfiles: false,
      systemPrompt: { replace: false, append: false },
      instructions: false,
      tools: false,
      permissions: false,
      mcp: false,
      subagents: false,
      resources: {
        files: false,
        instructions: false,
        tools: false,
        skills: false,
        agents: false,
        commands: false,
      },
      hooks: false,
      modes: false,
      runtimeUpdate: false,
      validation: false,
    },
    streaming: { live: true, replay: true, detach: false, turnIdempotency: true },
    sessions: { continue: false, list: false, messages: false },
    workspace: {
      read: false,
      write: false,
      exec: false,
      git: false,
      upload: false,
      download: false,
    },
    branching: { checkpoint: false, fork: false },
    placement: false,
    usage: false,
    confidential: false,
    observation: {
      identity: true,
      lifecycle: true,
      endpoint: true,
      placement: false,
      resources: false,
      resourceUse: false,
      modelUsage: false,
      computeBilling: false,
      accountUsage: false,
    },
  }
  const validated = AgentEnvironmentCapabilitiesSchema.safeParse(candidate)
  if (!validated.success) {
    throw new RetainedSessionError('Bridge generic capabilities are invalid', 500, 'server_error')
  }
  return validated.data as AgentEnvironmentCapabilities
}

function resolveBackend(registry: BackendRegistry, model: string): Backend {
  const backend = registry.resolve(model)
  if (!backend) {
    throw new RetainedSessionError(`no backend matches model ${JSON.stringify(model)}`, 404, 'not_found_error')
  }
  return backend
}

async function assertReady(backend: Backend, healthProbeTimeoutMs: number, signal?: AbortSignal): Promise<void> {
  const health: Awaited<ReturnType<Backend['health']>> = await boundedProbe(
    backend,
    healthProbeTimeoutMs,
    signal,
  )
  if (health.state !== 'ready') {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backend.name)} is not ready: ${health.detail ?? health.state}`,
      503,
      'backend_not_ready',
    )
  }
}

function validatedNativeCapabilities(backend: NativeSessionBackend): AgentEnvironmentCapabilities {
  const validated = AgentEnvironmentCapabilitiesSchema.safeParse(nativeCapabilities(backend))
  if (!validated.success) {
    throw new RetainedSessionError('backend advertised invalid Agent Interface capabilities', 500, 'server_error')
  }
  const capabilities = validated.data as AgentEnvironmentCapabilities
  assertRetainedCapabilities(capabilities, backend.name)
  return capabilities
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
