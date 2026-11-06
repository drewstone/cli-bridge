/**
 * Stream-level error frames on /v1/runs/:id/events must carry a sequence id.
 *
 * Runtime's bridge parser (agent-runtime 0.208.1 bridgeExecutor) throws a
 * terminal ValidationError on any JSON data frame without an `id:` line and
 * reports "bridge emitted an unnumbered run event" instead of the failure the
 * frame was carrying. Observed 2026-09-11 on collab-decoder-20260910-r2: a
 * bridge SIGTERM surfaced as a schema violation classified `infra: false`.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { ChatDelta } from '../src/backends/types.js'
import { streamChatDeltaEvents } from '../src/routes/run-events.js'

function appWithSource(source: () => AsyncIterable<{ seq: number; delta: ChatDelta }>): Hono {
  const app = new Hono()
  app.get('/v1/runs/:id/events', (c) => streamChatDeltaEvents(c, () => source(), 'test-model'))
  return app
}

/** Every JSON data frame in an SSE body, paired with its event block's id (null = unnumbered). */
function jsonDataFrames(body: string): Array<{ id: string | null; data: string }> {
  const frames: Array<{ id: string | null; data: string }> = []
  for (const block of body.split('\n\n')) {
    let id: string | null = null
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4)
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
    }
    const data = dataLines.join('\n')
    if (data === '[DONE]' || data === '') continue
    try {
      JSON.parse(data)
      frames.push({ id, data })
    } catch {
      // Not a JSON frame; the parser's id requirement does not apply.
    }
  }
  return frames
}

describe('stream-level error frames carry a sequence id', () => {
  it('numbers the stream error frame with the next id after the last delivered event', async () => {
    async function* source(): AsyncIterable<{ seq: number; delta: ChatDelta }> {
      yield { seq: 1, delta: { content: 'half an answer' } }
      throw new Error('bridge shutting down')
    }
    const response = await appWithSource(source).request('/v1/runs/r/events')
    expect(response.status).toBe(200)
    const body = await response.text()

    const frames = jsonDataFrames(body)
    const errorFrame = frames.at(-1)
    expect(errorFrame).toBeDefined()
    expect(errorFrame!.id).toBe('2')
    expect(JSON.parse(errorFrame!.data)).toMatchObject({
      error: { message: 'bridge shutting down', type: 'server_error' },
    })
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('numbers the error frame even when the source throws before any event', async () => {
    async function* source(): AsyncIterable<{ seq: number; delta: ChatDelta }> {
      throw new Error('nothing was delivered')
    }
    const response = await appWithSource(source).request('/v1/runs/r/events')
    const body = await response.text()

    const frames = jsonDataFrames(body)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe('0')
    expect(JSON.parse(frames[0]!.data)).toMatchObject({
      error: { message: 'nothing was delivered', type: 'server_error' },
    })
  })

  it('keeps every JSON data frame numbered, matching the Runtime parser contract', async () => {
    async function* source(): AsyncIterable<{ seq: number; delta: ChatDelta }> {
      yield { seq: 1, delta: { content: 'a' } }
      yield { seq: 2, delta: { content: 'b' } }
      yield { seq: 3, delta: { content: 'c' } }
      throw new Error('late failure')
    }
    const response = await appWithSource(source).request('/v1/runs/r/events')
    const body = await response.text()
    expect(jsonDataFrames(body).every((frame) => frame.id !== null)).toBe(true)
  })
})
