/** Shared value shapes for one durable run: its output log, snapshot, and claim inputs. */

import type { ChatDelta, ProfileMaterializationReceipt } from '../backends/types.js'
import type { InteractionRequest, RuntimeEventEnvelope, StreamEvent } from '@tangle-network/agent-interface'

/** A buffered delta plus its per-run monotonic sequence number. */
export interface SeqDelta {
  seq: number
  delta: ChatDelta
}

export interface SeqCanonicalEvent {
  seq: number
  envelope: RuntimeEventEnvelope
}

export type CanonicalEventListener = (event: SeqCanonicalEvent) => void

/** Protocol that owns a run id inside this bridge process. */
export type RunOwner = 'one-shot' | 'retained'

export interface CanonicalEventInput {
  event: StreamEvent
  occurredAt?: string
}

export interface RunClaimOptions {
  owner?: RunOwner
  sessionId?: string
  executionId?: string
  provider?: string
  environmentId?: string
  commitDelta?: (input: { runId: string; sequence: number; delta: ChatDelta }) => void
  commitSnapshot?: (snapshot: RunSnapshot) => void
  commitCanonicalEvent?: (input: {
    runId: string
    sequence: number
    eventId: string
    event: StreamEvent
    occurredAt?: string
    receivedAt: string
  }) => RuntimeEventEnvelope
  onNativeControlLost?: (input: { runId: string; sessionId?: string; reason: Error }) => void
}

export interface PendingRunInteraction {
  request: InteractionRequest
  nativeId: string
}

/** Existing completion outcome. `running` means no outcome exists yet. */
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'unknown'

/** Connection/process lifecycle, separate from the terminal outcome. */
export type RunState = 'detached' | 'running' | 'cancelling' | 'terminal'

export interface RunReplayWindow {
  /** Lowest event still replayable. A cursor of `firstAvailableSeq - 1` is valid. */
  firstAvailableSeq: number
  lastSeq: number
  retainedDeltas: number
  maxRetainedDeltas: number
  /** Approximate bytes of delta payload currently retained. */
  retainedBytes: number
  /** Ceiling on retained delta payload. */
  maxRetainedBytes: number
  /** Set once terminal; the buffer is cleared at this Unix-millisecond time. */
  expiresAt: number | null
  expired: boolean
}

export interface RunSnapshot {
  id: string
  /** Digest of the normalized execution request bound to this id. */
  requestDigest: string
  /** Completion outcome; remains `running` while detached or cancelling. */
  status: RunStatus
  /** Distinguishes an attached reader, no reader, cancellation, and process exit. */
  state: RunState
  /** True only after the owned backend job has reached a terminal state. */
  terminal: boolean
  attachedReaders: number
  cancelRequestedAt: number | null
  /** Highest seq emitted so far. 0 = no delta emitted yet. */
  lastSeq: number
  replay: RunReplayWindow
  startedAt: number
  endedAt: number | null
  /** Run-id binding survives replay expiry until this time. */
  identityExpiresAt: number | null
  provider?: string
  environmentId?: string
  sessionId?: string
  executionId?: string
  canonicalLastSeq: number
  lifetimeExpiresAt: number | null
  profileMaterialization: ProfileMaterializationReceipt | null
}

export interface RunRetention {
  replayRetentionMs: number
  identityRetentionMs: number
  maxReplayDeltas: number
  maxReplayBytes: number
  maxLifetimeMs: number
}
