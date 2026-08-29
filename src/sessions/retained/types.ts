/** Public value shapes of the retained-session surface. */

import type { AgentEnvironmentCapabilities, AgentProfile } from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../../backends/registry.js'
import type { RunRegistry, RunSnapshot } from '../../runs/registry.js'
import type { RetainedSessionRecord, RetainedSessionStatus, SessionStore } from '../store.js'

/** The environment and provider id this bridge publishes on every run reference. */
export const ENVIRONMENT_ID = 'cli-bridge'

export class RetainedSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'RetainedSessionError'
  }
}

export type RetainedControlAcknowledgement = {
  operationId: string
  kind: 'steer' | 'cancel'
  sessionId: string
  runId: string
  status:
    | 'accepted'
    | 'cancelled'
    | 'already_terminal'
    | 'pending'
    | 'unknown_run'
    | 'capability_denied'
    | 'conflict'
    | 'effect_unknown'
  message?: string
  retryable?: false
  existingRequestDigest?: `sha256:${string}`
}

export interface RetainedTurnResult {
  session: RetainedSessionRecord
  run: DurableRetainedRunSnapshot
  contextBoundary: Record<string, unknown> | null
}

export interface RetainedRunCoordinates {
  provider: string
  environmentId: string
}

export type DurableRetainedRunSnapshot =
  | RunSnapshot
  | {
      readonly id: string
      readonly executionId: string
      readonly requestDigest: string
      readonly status: 'unknown'
      readonly state: 'detached'
      readonly terminal: false
      readonly sessionId: string
      readonly provider: string
      readonly environmentId: string
    }

export interface RetainedSessionView {
  id: string
  object: 'session'
  create_request_digest: string
  backend: string
  model: string
  status: RetainedSessionStatus
  run_id: string | null
  internal_session_id: string | null
  turns: number
  created_at: string
  updated_at: string
  capabilities: AgentEnvironmentCapabilities
  profile_materialization_receipt: Record<string, unknown> | null
  context_boundary: Record<string, unknown> | null
  run?: DurableRetainedRunSnapshot
}

export interface RetainedSessionServiceOptions {
  store: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  inputQueueMaxDepth?: number
  inputQueueTimeoutMs?: number
  healthProbeTimeoutMs?: number
}

export interface RetainedContextTransferDestination {
  provider: string
  environmentId: string
  sessionId: string
  runId: string
  executionId: string
  model: string
  profile: AgentProfile | undefined
}
