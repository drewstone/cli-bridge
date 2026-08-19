import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Run } from '../runs/registry.js'
import { RunReplayCursorError } from '../runs/registry.js'
import { deltaToOpenAIChunk, deltaToSseComment, makeChunkMeta } from '../streaming/sse.js'

const DEFAULT_SSE_HEARTBEAT_MS = 15_000

type ParsedCursor =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

/** Resolve the standard replay cursor and the bridge compatibility alias. */
export function resolveRunEventCursor(
  standardValue: string | undefined,
  aliasValue: string | undefined,
): ParsedCursor {
  const parse = (value: string | undefined): ParsedCursor | { readonly ok: true; readonly value: undefined } => {
    if (value === undefined) return { ok: true, value: undefined }
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      return { ok: false, message: 'Last-Event-ID must be a non-negative base-10 integer' }
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, message: 'Last-Event-ID exceeds the safe integer range' }
    }
    return { ok: true, value: parsed }
  }

  const standard = parse(standardValue)
  if (!standard.ok) return standard
  const alias = parse(aliasValue)
  if (!alias.ok) return alias
  if (
    standard.value !== undefined &&
    alias.value !== undefined &&
    standard.value !== alias.value
  ) {
    return {
      ok: false,
      message: 'Last-Event-ID and X-Last-Event-Id must match when both are provided',
    }
  }
  return { ok: true, value: standard.value ?? alias.value ?? 0 }
}

/** Render one retained run without needing the original dispatch request. */
export function streamRunEvents(
  c: Context,
  run: Run,
  model: string,
  afterSeq: number,
): Response {
  return streamChatDeltaEvents(c, (signal) => run.attach(afterSeq, signal), model)
}

/** Render any sequence-numbered ChatDelta source with one OpenAI SSE path. */
export function streamChatDeltaEvents(
  c: Context,
  source: (signal: AbortSignal) => AsyncIterable<{ seq: number; delta: import('../backends/types.js').ChatDelta }>,
  model: string,
): Response {
  return streamSSE(c, async (stream) => {
    const meta = makeChunkMeta(model)
    let clientGone = false
    const readerController = new AbortController()
    stream.onAbort(() => {
      clientGone = true
      readerController.abort()
    })
    const writeRaw = async (chunk: string): Promise<boolean> => {
      if (clientGone || stream.aborted) return false
      try {
        await stream.write(chunk)
        return !stream.aborted
      } catch {
        clientGone = true
        readerController.abort()
        return false
      }
    }
    const writeSse = async (data: string, id?: number): Promise<boolean> => {
      if (clientGone || stream.aborted) return false
      try {
        await stream.writeSSE(id === undefined ? { data } : { data, id: String(id) })
        return !stream.aborted
      } catch {
        clientGone = true
        readerController.abort()
        return false
      }
    }
    const heartbeat = setInterval(() => {
      void writeRaw(': keepalive\n\n')
    }, resolveSseHeartbeatMs())

    try {
      if (!await writeRaw(': connected\n\n')) return
      for await (const { seq, delta } of source(readerController.signal)) {
        if (clientGone) break
        if ((delta.finish_reason === 'error' || delta.finish_reason === 'timeout') && delta.error) {
          await writeSse(JSON.stringify({ error: delta.error }), seq)
          break
        }
        const comment = deltaToSseComment(delta)
        if (comment) {
          if (!await writeRaw(`id: ${seq}\n${comment}`)) break
          continue
        }
        const chunk = deltaToOpenAIChunk(delta, meta)
        if (!chunk) {
          if (!await writeRaw(`id: ${seq}\n: bridge-metadata\n\n`)) break
          continue
        }
        const payload = chunk.slice('data: '.length).replace(/\n\n$/, '')
        if (!await writeSse(payload, seq)) break
      }
    } catch (error) {
      if (clientGone) return
      const message = error instanceof Error ? error.message : String(error)
      const type = error instanceof RunReplayCursorError ? error.code : 'server_error'
      await writeSse(JSON.stringify({ error: { message, type } }))
    } finally {
      clearInterval(heartbeat)
    }
    await writeSse('[DONE]')
  })
}

function resolveSseHeartbeatMs(): number {
  const raw = Number(process.env.BRIDGE_SSE_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw >= 10 ? raw : DEFAULT_SSE_HEARTBEAT_MS
}
