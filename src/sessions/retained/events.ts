/**
 * Replay and live tailing of a retained session's durable event log.
 *
 * SQLite is the only source of events. A live canonical notification is
 * treated purely as a wake-up: the stream re-reads by cursor and dedupes by
 * event id, so a notification can never surface an uncommitted or duplicate
 * event, and a commit landing between two reads cannot open a gap.
 */

import type { InteractionRequest, Part } from '@tangle-network/agent-interface'
import type { RunRegistry } from '../../runs/registry.js'
import type { RetainedEventRecord, SessionStore } from '../store.js'
import { isUsageEvent } from './native-turn.js'
import type { RetainedSessionState } from './state.js'
import { RetainedSessionError } from './types.js'

export class RetainedEvents {
  constructor(
    private readonly store: SessionStore,
    private readonly runs: RunRegistry,
    private readonly state: RetainedSessionState,
  ) {}

  transcript(id: string): Record<string, unknown> {
    this.state.require(id)
    const events = this.store.retainedEventsAfter(id)
    const messages = new Map<string, { id: string; role: 'assistant'; parts: Part[] }>()
    const interactions: InteractionRequest[] = []
    const usage: unknown[] = []
    for (const item of events) {
      const event = item.envelope.event
      if (event.type === 'message.part.updated') {
        const messageId = event.part.messageID
        const message = messages.get(messageId) ?? { id: messageId, role: 'assistant', parts: [] }
        const index = message.parts.findIndex((part) => part.id === event.part.id)
        if (index >= 0) message.parts[index] = event.part
        else message.parts.push(event.part)
        messages.set(messageId, message)
      } else if (event.type === 'interaction') {
        interactions.push(event.request)
      } else if (event.type === 'raw' && isUsageEvent(event.event)) {
        usage.push(event.event)
      }
    }
    return {
      session_id: id,
      messages: [...messages.values()],
      interactions,
      usage,
      event_count: events.length,
      last_event_id: this.store.latestRetainedEvent(id)?.envelope.cursor ?? null,
    }
  }

  assertSessionCursor(id: string, afterCursor: number): void {
    this.state.require(id)
    const latest = this.store.latestRetainedEvent(id)
    const latestCursor = latest ? Number(latest.envelope.cursor ?? latest.sessionSequence) : 0
    if (afterCursor > latestCursor) {
      throw new RetainedSessionError(
        `replay cursor ${afterCursor} is ahead of the latest retained cursor ${latestCursor}`,
        409,
        'invalid_replay_cursor',
      )
    }
  }

  async *sessionEvents(id: string, afterCursor: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord> {
    this.assertSessionCursor(id, afterCursor)
    // Session replay uses the session cursor and includes every retained run;
    // the active run is only the notification source, not a run filter.
    yield* this.stream({ sessionId: id, afterCursor, runId: null, signal })
  }

  assertRunCursor(runId: string, afterSequence: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RetainedSessionError('run replay cursor must be a non-negative integer', 400, 'invalid_replay_cursor')
    }
    const control = this.runs.get(runId)
    const durable = this.store.retainedRun(runId)
    if (!control && !durable) throw new RetainedSessionError('run is unknown after process loss', 404, 'unknown_run')
    const latest = durable?.lastSequence ?? control?.snapshot().canonicalLastSeq ?? 0
    if (afterSequence > latest) {
      throw new RetainedSessionError(
        `replay cursor ${afterSequence} is ahead of run ${JSON.stringify(runId)} at ${latest}`,
        409,
        'invalid_replay_cursor',
      )
    }
  }

  async *runEvents(runId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord> {
    this.assertRunCursor(runId, afterSequence)
    const control = this.runs.get(runId)
    const durable = this.store.retainedRun(runId)
    const sessionId = control?.sessionId ?? durable?.sessionId
    if (!sessionId) throw new RetainedSessionError('run has no retained session binding', 404, 'unknown_run')
    yield* this.stream({ sessionId, afterCursor: afterSequence, runId, signal, runCursor: true })
  }

  private async *stream(input: {
    sessionId: string
    afterCursor: number
    runId: string | null
    signal: AbortSignal
    runCursor?: boolean
  }): AsyncGenerator<RetainedEventRecord> {
    let cursor = input.afterCursor
    const seen = new Set<string>()
    const live: Array<{ seq: number; envelope: RetainedEventRecord['envelope'] }> = []
    let wake: (() => void) | null = null
    let unsubscribe: (() => void) | null = null
    const control = input.runId ? this.runs.get(input.runId) : this.runs.nativeSession(input.sessionId)?.run
    if (control && (!input.runId || control.id === input.runId)) {
      unsubscribe = control.subscribeCanonical((event) => {
        live.push({ seq: event.seq, envelope: event.envelope })
        wake?.()
      })
    }
    const readAfter = (from: number): RetainedEventRecord[] =>
      input.runCursor
        ? this.store.retainedEventsAfterRun(input.sessionId, input.runId!, from)
        : this.store.retainedEventsAfter(input.sessionId, from)
    const cursorOf = (event: RetainedEventRecord): number =>
      input.runCursor ? event.envelope.sequence : Number(event.envelope.cursor ?? event.sessionSequence)
    try {
      while (!input.signal.aborted) {
        let progressed = false
        for (const event of readAfter(cursor)) {
          if (input.signal.aborted) return
          const eventCursor = cursorOf(event)
          if (eventCursor <= cursor || seen.has(event.envelope.eventId)) continue
          if (input.runId && event.envelope.runId !== input.runId) continue
          seen.add(event.envelope.eventId)
          cursor = eventCursor
          progressed = true
          yield event
        }

        // A live notification is only a wake-up. Re-read SQLite by cursor and
        // dedupe by event id; the notification cannot expose an uncommitted or
        // duplicate event and a commit between reads cannot create a gap.
        if (live.length > 0) {
          live.length = 0
          continue
        }
        for (const event of readAfter(cursor)) {
          const eventCursor = cursorOf(event)
          if (eventCursor <= cursor || seen.has(event.envelope.eventId)) continue
          if (input.runId && event.envelope.runId !== input.runId) continue
          seen.add(event.envelope.eventId)
          cursor = eventCursor
          progressed = true
          yield event
        }
        if (progressed) continue

        const active = input.runId ? this.runs.get(input.runId) : this.runs.nativeSession(input.sessionId)?.run
        if (!active || active.snapshot().terminal) {
          if (readAfter(cursor).length === 0) {
            const current = this.store.getRetained(input.sessionId)
            const hasHistory = this.store.latestRetainedEvent(input.sessionId) !== null
            if (
              !input.runId &&
              !hasHistory &&
              (current?.status === 'created' || current?.status === 'idle' || current?.status === 'running')
            ) {
              await waitForEventPoll(input.signal, 50)
              continue
            }
            return
          }
          continue
        }
        await waitForEventNotification(
          input.signal,
          () => {
            if (live.length > 0) return true
            wake = null
            return false
          },
          (resolve) => {
            wake = resolve
          },
        )
      }
    } finally {
      unsubscribe?.()
      const notify = wake as (() => void) | null
      notify?.()
    }
  }
}

async function waitForEventPoll(signal: AbortSignal, waitMs: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      finish()
    }
    timer = setTimeout(finish, waitMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForEventNotification(
  signal: AbortSignal,
  ready: () => boolean,
  register: (resolve: () => void) => void,
): Promise<void> {
  if (signal.aborted || ready()) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    register(finish)
    // A run can finish without a canonical notification (for example when
    // startup fails), so the periodic reread is the final safety net.
    timer = setTimeout(finish, 50)
    timer.unref?.()
    if (ready()) finish()
  })
}
