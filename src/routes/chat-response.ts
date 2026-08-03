import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import { BackendError } from '../backends/types.js'
import { ModeNotSupportedError } from '../modes.js'
import { collectNonStreaming, deltaToOpenAIChunk, deltaToSseComment, makeChunkMeta } from '../streaming/sse.js'
import { AdmissionRejectedError } from '../admission.js'
import { RunIdentityConflictError, RunReplayCursorError, type Run } from '../runs/registry.js'
import { BackendReportedFailureError } from '../runs/error-shape.js'
import { SandboxBackendUnavailableError, resolveSseHeartbeatMs } from './chat-contract.js'

interface CollectedCompletion {
  error?: { message: string; type: string }
  choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>
}

/** True when the run produced something a caller can use. */
function completionHasOutput(body: CollectedCompletion): boolean {
  const message = body.choices?.[0]?.message
  return Boolean(message?.content) || (message?.tool_calls?.length ?? 0) > 0
}

/**
 * Render a (possibly already-running) durable run to this request. The
 * client attaches as a reader from `afterSeq`; a disconnect ends the
 * reader but NEVER the run. Streaming and non-streaming both read the
 * same buffered, seq-numbered delta log.
 */
export async function respondFromRun(
  c: Context,
  run: Run,
  req: ChatRequest,
  runId: string,
  afterSeq: number,
): Promise<Response> {
  try {
    run.assertReplayCursor(afterSeq)
  } catch (error) {
    if (error instanceof RunReplayCursorError) return replayCursorError(c, error)
    throw error
  }
  // Surface mode + run id so clients can reconnect/cancel by run id.
  c.header('X-Bridge-Mode', req.mode ?? 'byob')
  c.header('X-Run-Id', runId)
  c.header('X-Run-Request-Digest', run.requestDigest)

  // OpenAI's /v1/chat/completions defaults `stream: false` when the field
  // is omitted. Only stream when the caller asked for it (`stream: true`);
  // otherwise drain the run's buffer to a single completion body.
  if (req.stream !== true) {
    // A non-streaming response is a single JSON body, so a dispatch-time
    // typed error (mode rejected, spawn/config failure — thrown before any
    // delta) must become a real HTTP status, not a 200 with an error
    // payload. Re-attaching readers receive the same typed error, and the
    // check resolves once output starts or the run settles.
    await run.whenStarted()
    const dispatchErr = run.dispatchError()
    if (dispatchErr !== undefined) return errorResponse(c, dispatchErr)
    try {
      const deltas = mapSeq(run.attach(afterSeq))
      const body = (await collectNonStreaming(deltas, req.model)) as CollectedCompletion
      if (body.error) {
        // A failure AFTER output began is still a failure. With nothing to show
        // for the run, answer with the same status the identical pre-output
        // failure would have produced — a caller cannot tell where in the
        // stream a fault happened and must not have to. With partial output,
        // keep the real work and carry the reason in the body: measured, this
        // was a 200 whose whole explanation was `finish_reason: "error"`.
        const failure = run.failure()
        if (!completionHasOutput(body)) {
          if (failure !== undefined) return errorResponse(c, failure)
          // No recorded failure and no output: the only way to get here is a
          // run the CALLER cancelled. That is not a server fault, so it must not
          // wear a 5xx — but it must not wear a 200 with an empty message
          // either, which is what a benchmark harness would score 0.000.
          return c.json({ error: body.error }, run.snapshot().status === 'cancelled' ? 409 : 500)
        }
      }
      return c.json(body)
    } catch (err) {
      return errorResponse(c, err)
    }
  }

  return streamSSE(c, async (stream) => {
    const meta = makeChunkMeta(req.model)
    const heartbeatMs = resolveSseHeartbeatMs()
    // `clientGone` ends THIS reader on a write failure (socket closed). It
    // does NOT cancel the run — that is the whole point of the decoupling.
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
    // SSE `id:` carries the per-run seq so the client's next reconnect can
    // send it back as Last-Event-ID and replay exactly what it missed.
    const writeSse = async (data: string, id?: number): Promise<boolean> => {
      if (clientGone || stream.aborted) return false
      try {
        await stream.writeSSE(id !== undefined ? { data, id: String(id) } : { data })
        return !stream.aborted
      } catch {
        clientGone = true
        readerController.abort()
        return false
      }
    }
    const heartbeat = setInterval(() => {
      void writeRaw(': keepalive\n\n')
    }, heartbeatMs)
    try {
      if (!(await writeRaw(': connected\n\n'))) return
      for await (const { seq, delta } of run.attach(afterSeq, readerController.signal)) {
        if (clientGone) break
        // The run pump attaches the reason to the terminal delta itself, so a
        // failure at ANY point in the stream — not only before the first delta —
        // becomes one OpenAI error frame here, and a reconnecting reader replays
        // the same reason instead of a bare terminal marker.
        //
        // BOTH terminal failure reasons, because enumerating one of them is the
        // same defect one level down: a `timeout` delta carrying a reason was
        // written out as an ordinary chunk and the frame never appeared.
        if ((delta.finish_reason === 'error' || delta.finish_reason === 'timeout') && delta.error) {
          await writeSse(JSON.stringify({ error: delta.error }), seq)
          break
        }
        // Backend-level liveness ping (e.g. kimi/opencode stdout idle):
        // render as SSE comment so the consumer (AI SDK, openai-node)
        // ignores it per spec instead of trying to route a fake tool
        // call. SSE comments also count as transport heartbeats.
        const comment = deltaToSseComment(delta)
        if (comment) {
          // Every buffered delta advances the durable replay cursor, including
          // liveness and bridge-internal metadata that OpenAI clients should
          // otherwise ignore. Carry the id on an SSE comment frame so an exact
          // client can reject a missing sequence instead of silently skipping it.
          if (!(await writeRaw(`id: ${seq}\n${comment}`))) break
          continue
        }
        const chunk = deltaToOpenAIChunk(delta, meta)
        // Metadata-only deltas (e.g. internal_session_id) yield null —
        // consumed by the run/session store. Emit an id-only comment frame so
        // the replay sequence remains gap-free without exposing a fake chunk.
        if (!chunk) {
          if (!(await writeRaw(`id: ${seq}\n: bridge-metadata\n\n`))) break
          continue
        }
        // deltaToOpenAIChunk returns a complete "data: …\n\n" line. Strip
        // the framing so streamSSE can re-add it (with the seq as id).
        const payload = chunk.slice('data: '.length).replace(/\n\n$/, '')
        if (!(await writeSse(payload, seq))) break
      }
    } catch (err) {
      if (clientGone) return
      const message = err instanceof Error ? err.message : String(err)
      const type = err instanceof RunReplayCursorError ? err.code : 'server_error'
      await writeSse(JSON.stringify({ error: { message, type } }))
    } finally {
      clearInterval(heartbeat)
    }
    await writeSse('[DONE]')
  })
}

/** Unwrap SeqDelta → ChatDelta for the non-streaming collector. */

/** Unwrap SeqDelta → ChatDelta for the non-streaming collector. */
async function* mapSeq(iter: AsyncIterable<{ delta: ChatDelta }>): AsyncIterable<ChatDelta> {
  for await (const { delta } of iter) yield delta
}

export function runIdentityConflict(c: Context, error: RunIdentityConflictError): Response {
  return c.json(
    {
      error: {
        message: error.message,
        type: error.code,
        run_id: error.runId,
        expected_request_digest: error.expectedRequestDigest,
        received_request_digest: error.receivedRequestDigest,
      },
    },
    409,
  )
}

function replayCursorError(c: Context, error: RunReplayCursorError): Response {
  return c.json(
    {
      error: {
        message: error.message,
        type: error.code,
        run_id: error.runId,
        last_event_id: error.lastSeq,
        first_available_event_id: error.firstAvailableSeq,
      },
    },
    error.reason === 'expired' ? 410 : 409,
  )
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof RunReplayCursorError) return replayCursorError(c, err)
  if (err instanceof SandboxBackendUnavailableError) {
    return c.json({ error: { message: err.message, type: err.code } }, 503)
  }
  if (err instanceof AdmissionRejectedError) {
    return admissionErrorResponse(c, err)
  }
  if (err instanceof ModeNotSupportedError) {
    return c.json({ error: { message: err.message, type: 'mode_not_supported' } }, 501)
  }
  // An executor that cannot serve the request as configured: 501 (this bridge is
  // not set up for that) rather than 500 (this bridge broke). The message names
  // the setting to change, so it must reach the caller and not only the log.
  if (err instanceof ExecutorConfigurationError) {
    return c.json({ error: { message: err.message, type: err.code } }, 501)
  }
  // A failure the backend YIELDED as a terminal error delta rather than throwing.
  // It reaches here through `run.failure()`, and it is an upstream fault by
  // construction — the CLI ran and ended badly — so 502, or 504 when the reason
  // is a timeout. Falling through to the generic 500 below would have relabelled
  // every upstream fault as a bridge fault.
  if (err instanceof BackendReportedFailureError) {
    return c.json({ error: { message: err.message, type: err.code } }, err.code === 'timeout' ? 504 : 502)
  }
  if (err instanceof BackendError) {
    // Hono's typed status gate treats 499 as an unofficial code; collapse
    // that one to 504 and keep the rest as documented codes.
    const status: 500 | 501 | 502 | 503 | 504 =
      err.code === 'not_configured' || err.code === 'capability_denied'
        ? 501
        : err.code === 'cli_missing'
          ? 503
          : err.code === 'timeout'
            ? 504
            : err.code === 'aborted'
              ? 504
              : 502
    return c.json({ error: { message: err.message, type: err.code } }, status)
  }
  const message = err instanceof Error ? err.message : String(err)
  return c.json({ error: { message, type: 'server_error' } }, 500)
}

function admissionErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof AdmissionRejectedError)) {
    return errorResponse(c, err)
  }
  c.header('Retry-After', '5')
  return c.json(
    {
      error: {
        message: err.message,
        type: 'admission_rejected',
        reason: err.reason,
        admission: err.snapshot,
      },
    },
    503,
  )
}
