import type { ChatDelta } from '../backends/types.js'
import type { RetainedEventRecord } from '../sessions/store.js'

/** Decode one durable one-shot event without accepting native-session events. */
export function chatDeltaFromRetainedEvent(record: RetainedEventRecord): ChatDelta | null {
  const event = record.envelope.event
  if (event.type !== 'raw' || event.backend !== 'cli-bridge.chat') return null
  if (!event.event || typeof event.event !== 'object' || Array.isArray(event.event)) {
    throw new Error(`persisted chat event ${JSON.stringify(record.envelope.eventId)} is invalid`)
  }
  return event.event as ChatDelta
}

/** Restore the OpenAI stream face for one durable one-shot run. */
export async function* retainedChatDeltas(
  source: AsyncIterable<RetainedEventRecord>,
): AsyncIterable<{ seq: number; delta: ChatDelta }> {
  for await (const record of source) {
    const delta = chatDeltaFromRetainedEvent(record)
    if (!delta) {
      throw new Error(
        `persisted one-shot run contains a non-chat event at sequence ${record.envelope.sequence}`,
      )
    }
    yield { seq: record.envelope.sequence, delta }
  }
}
