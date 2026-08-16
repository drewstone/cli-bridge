/**
 * The bounded, sequence-numbered output window of one durable run.
 *
 * Two parallel logs share one cursor space per kind: OpenAI-shaped deltas and
 * canonical runtime events. Both are ring-bounded, both wake every attached
 * reader on append, and both fail closed when a reader asks for a cursor the
 * window can no longer serve exactly.
 */

import {
  CanonicalStreamEventSchema,
  RuntimeEventEnvelopeSchema,
  canonicalCandidateDigest,
  type RuntimeEventEnvelope,
} from '@tangle-network/agent-interface'
import type { ChatDelta } from '../backends/types.js'
import { RunReplayCursorError } from './errors.js'
import type {
  CanonicalEventInput,
  CanonicalEventListener,
  RunClaimOptions,
  RunReplayWindow,
  RunRetention,
  SeqCanonicalEvent,
  SeqDelta,
} from './types.js'

interface Waiter {
  resolve: () => void
}

export interface RunReplayLogOptions {
  runId: string
  retention: RunRetention
  /** True once the run is terminal or disposed; readers stop instead of blocking. */
  isClosed: () => boolean
  /** The run-id binding expired — the registry may forget this run. */
  onIdentityExpired: () => void
  commitCanonicalEvent?: RunClaimOptions['commitCanonicalEvent']
  /** A canonical commit failed; the owning run records the outcome as unknown. */
  onCommitFailure: (error: unknown) => void
}

export class RunReplayLog {
  private readonly deltas: SeqDelta[] = []
  private deltaBytes = 0
  private readonly canonical: SeqCanonicalEvent[] = []
  private seq = 0
  private canonicalSeq = 0
  private attachedReaders = 0
  private replayExpiresAt: number | null = null
  private identityExpiresAt: number | null = null
  private replayExpired = false
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  private identityTimer: ReturnType<typeof setTimeout> | null = null
  private profileMaterialization: ChatDelta['profile_materialization'] | null = null
  private readonly waiters = new Set<Waiter>()
  private readonly canonicalSubscribers = new Set<CanonicalEventListener>()

  constructor(private readonly options: RunReplayLogOptions) {}

  lastSeq(): number {
    return this.seq
  }

  canonicalLastSeq(): number {
    return this.canonicalSeq
  }

  readers(): number {
    return this.attachedReaders
  }

  replayExpiry(): number | null {
    return this.replayExpiresAt
  }

  identityExpiry(): number | null {
    return this.identityExpiresAt
  }

  profileReceipt(): ChatDelta['profile_materialization'] | null {
    return this.profileMaterialization ? structuredClone(this.profileMaterialization) : null
  }

  replayWindow(): RunReplayWindow {
    return {
      firstAvailableSeq: this.firstAvailableSeq(),
      lastSeq: this.seq,
      retainedDeltas: this.deltas.length,
      maxRetainedDeltas: this.options.retention.maxReplayDeltas,
      retainedBytes: this.deltaBytes,
      maxRetainedBytes: this.options.retention.maxReplayBytes,
      expiresAt: this.replayExpiresAt,
      expired: this.replayExpired,
    }
  }

  append(delta: ChatDelta): void {
    const committed = structuredClone(delta)
    if (committed.profile_materialization) {
      if (
        this.profileMaterialization
        && JSON.stringify(this.profileMaterialization) !== JSON.stringify(committed.profile_materialization)
      ) {
        throw new Error(`run ${JSON.stringify(this.options.runId)} emitted conflicting profile materialization receipts`)
      }
      this.profileMaterialization = structuredClone(committed.profile_materialization)
    }
    this.seq += 1
    this.deltas.push({ seq: this.seq, delta: committed })
    this.deltaBytes += approximateDeltaBytes(committed)
    while (this.deltas.length > this.options.retention.maxReplayDeltas) this.evictOldestDelta()
    while (this.deltas.length > 1 && this.deltaBytes > this.options.retention.maxReplayBytes) {
      this.evictOldestDelta()
    }
    this.wakeAll()
  }

  appendCanonical(input: CanonicalEventInput): RuntimeEventEnvelope {
    const event = CanonicalStreamEventSchema.parse(input.event)
    const sequence = this.canonicalSeq + 1
    const receivedAt = new Date().toISOString()
    const eventId = runtimeEventId(this.options.runId, sequence)
    let envelope: RuntimeEventEnvelope
    try {
      envelope = this.options.commitCanonicalEvent?.({
        runId: this.options.runId,
        sequence,
        eventId,
        event,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        receivedAt,
      }) ?? {
        runId: this.options.runId,
        eventId,
        sequence,
        cursor: String(sequence),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        receivedAt,
        event,
      }
      const parsedEnvelope = RuntimeEventEnvelopeSchema.parse(envelope)
      if (
        parsedEnvelope.runId !== this.options.runId
        || parsedEnvelope.eventId !== eventId
        || parsedEnvelope.sequence !== sequence
      ) {
        throw new Error(
          `canonical commit returned an envelope with identity that does not match run ${JSON.stringify(this.options.runId)} `
          + `sequence ${sequence}`,
        )
      }
    } catch (error) {
      if (this.options.commitCanonicalEvent) this.options.onCommitFailure(error)
      throw error
    }
    this.canonicalSeq = sequence
    this.canonical.push({ seq: sequence, envelope })
    while (this.canonical.length > this.options.retention.maxReplayDeltas) this.canonical.shift()
    const committed = { seq: sequence, envelope }
    for (const listener of this.canonicalSubscribers) {
      try {
        listener(committed)
      } catch {
        /* a reader cannot break the run */
      }
    }
    this.wakeAll()
    return envelope
  }

  subscribeCanonical(listener: CanonicalEventListener): () => void {
    this.canonicalSubscribers.add(listener)
    return () => this.canonicalSubscribers.delete(listener)
  }

  /** Fail closed unless every event after this cursor remains available. */
  assertReplayCursor(afterSeq: number): void {
    const firstAvailableSeq = this.firstAvailableSeq()
    if (afterSeq > this.seq) {
      throw new RunReplayCursorError(this.options.runId, afterSeq, firstAvailableSeq, this.seq, 'ahead')
    }
    if (this.replayExpired || afterSeq < firstAvailableSeq - 1) {
      throw new RunReplayCursorError(this.options.runId, afterSeq, firstAvailableSeq, this.seq, 'expired')
    }
  }

  assertCanonicalReplayCursor(afterSeq: number): void {
    const first = this.canonical[0]?.seq ?? this.canonicalSeq + 1
    if (afterSeq > this.canonicalSeq) {
      throw new RunReplayCursorError(this.options.runId, afterSeq, first, this.canonicalSeq, 'ahead')
    }
    if (this.replayExpired || afterSeq < first - 1) {
      throw new RunReplayCursorError(this.options.runId, afterSeq, first, this.canonicalSeq, 'expired')
    }
  }

  /**
   * Attach one transport reader. The optional signal detaches only this
   * reader; it never propagates to the backend's owned abort controller.
   */
  async *attach(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqDelta> {
    this.attachedReaders += 1
    this.wakeAll()
    let cursor = afterSeq
    try {
      while (!readerSignal?.aborted) {
        this.assertReplayCursor(cursor)

        // Copy the currently available tail before yielding. The bounded
        // ring may rotate while the consumer processes a delta; this copy
        // prevents an array shift from silently skipping an event.
        const available = this.deltas.filter((item) => item.seq > cursor)
        for (const item of available) {
          if (readerSignal?.aborted) return
          cursor = item.seq
          yield item
        }

        // Output may have arrived after `available` was copied but before
        // the waiter is registered. Loop immediately when the sequence moved
        // so that wake-up cannot be lost in that check/subscribe gap.
        if (cursor < this.seq) continue
        if (this.options.isClosed()) return
        await this.waitForChange(readerSignal)
      }
    } finally {
      this.attachedReaders = Math.max(0, this.attachedReaders - 1)
      this.wakeAll()
    }
  }

  async *attachCanonical(afterSeq = 0, readerSignal?: AbortSignal): AsyncGenerator<SeqCanonicalEvent> {
    this.attachedReaders += 1
    this.wakeAll()
    let cursor = afterSeq
    try {
      while (!readerSignal?.aborted) {
        this.assertCanonicalReplayCursor(cursor)
        const available = this.canonical.filter((item) => item.seq > cursor)
        for (const item of available) {
          if (readerSignal?.aborted) return
          cursor = item.seq
          yield item
        }
        if (cursor < this.canonicalSeq) continue
        if (this.options.isClosed()) return
        await this.waitForChange(readerSignal)
      }
    } finally {
      this.attachedReaders = Math.max(0, this.attachedReaders - 1)
      this.wakeAll()
    }
  }

  /** Resolve once output begins or dispatch reaches a terminal failure. */
  async whenStarted(): Promise<void> {
    while (this.seq === 0 && !this.options.isClosed()) {
      await this.waitForChange()
    }
  }

  /** Start the replay and identity countdowns from one terminal instant. */
  scheduleRetention(endedAt: number): void {
    this.replayExpiresAt = endedAt + this.options.retention.replayRetentionMs
    this.identityExpiresAt = endedAt + this.options.retention.identityRetentionMs
    this.wakeAll()
    if (this.replayTimer || this.identityTimer) return
    this.replayTimer = setTimeout(() => {
      this.replayExpired = true
      this.clearReplayBuffers()
      this.wakeAll()
    }, this.options.retention.replayRetentionMs)
    this.replayTimer.unref?.()

    this.identityTimer = setTimeout(() => {
      this.options.onIdentityExpired()
    }, this.options.retention.identityRetentionMs)
    this.identityTimer.unref?.()
  }

  /** Drop every retained event immediately; used only on disposal. */
  discard(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer)
    if (this.identityTimer) clearTimeout(this.identityTimer)
    this.replayTimer = null
    this.identityTimer = null
    this.replayExpired = true
    this.clearBuffers()
    this.wakeAll()
  }

  wakeAll(): void {
    for (const waiter of [...this.waiters]) waiter.resolve()
  }

  waitForChange(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let resolved = false
      let waiter: Waiter
      const onAbort = (): void => finish()
      const finish = (): void => {
        if (resolved) return
        resolved = true
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      waiter = { resolve: finish }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private firstAvailableSeq(): number {
    return this.deltas[0]?.seq ?? this.seq + 1
  }

  private evictOldestDelta(): void {
    const oldest = this.deltas.shift()
    if (oldest) this.deltaBytes -= approximateDeltaBytes(oldest.delta)
  }

  private clearBuffers(): void {
    this.clearReplayBuffers()
    this.profileMaterialization = null
  }

  private clearReplayBuffers(): void {
    this.deltas.length = 0
    this.canonical.length = 0
    this.deltaBytes = 0
  }
}

const DELTA_OVERHEAD_BYTES = 128

function approximateDeltaBytes(delta: ChatDelta): number {
  let bytes = DELTA_OVERHEAD_BYTES
  if (delta.content) bytes += delta.content.length
  if (delta.model) bytes += delta.model.length
  if (delta.system_fingerprint) bytes += delta.system_fingerprint.length
  if (delta.error) bytes += delta.error.message.length + delta.error.type.length
  for (const call of delta.tool_calls ?? []) {
    bytes += DELTA_OVERHEAD_BYTES + call.id.length + call.name.length + call.arguments.length
  }
  if (delta.internal_session_id) bytes += delta.internal_session_id.length
  if (delta.profile_materialization) bytes += JSON.stringify(delta.profile_materialization).length
  if (delta.keepalive) bytes += delta.keepalive.source.length + DELTA_OVERHEAD_BYTES
  if (delta.usage) bytes += JSON.stringify(delta.usage).length
  return bytes
}

function runtimeEventId(runId: string, sequence: number): string {
  const candidate = `${runId}:${sequence}`
  return candidate.length <= 512
    ? candidate
    : `event:${canonicalCandidateDigest({ runId, sequence }).slice('sha256:'.length)}`
}
