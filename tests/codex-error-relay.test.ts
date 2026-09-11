/**
 * Codex provider errors reach the caller with the provider's own code.
 *
 * Every codex failure used to leave the bridge as `type: "upstream"`, whatever
 * the provider had said. Downstream that is one undifferentiated class: a
 * capacity refusal that clears by itself, a rate-limit refusal worth one
 * backoff, and a malformed request that will fail identically forever all read
 * the same, so a retry policy can only guess. agent-runtime decodes this exact
 * channel as `upstreamCode` (`bridgeUpstreamError`, src/runtime/supervise/
 * runtime.ts) and reads the relayed `status` in `classifyDriverFailure`, which
 * is what stops a 400 from being re-driven to the attempt ceiling.
 *
 * The fixtures are recorded refusals, not invented ones — provenance and counts
 * are in tests/fixtures/codex-error-events.ts. Three of these tests exist
 * because the recordings disagreed with what the parser first assumed: the
 * commonest rate-limit refusal names its variant with the object key rather than
 * a `type` field, a malformed request arrives under an `other` discriminant with
 * the real code in the body, and the status a provider states sits on the
 * wrapper beside its error rather than inside it.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexBackend, codexFailureReason } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import {
  CODEX_BAD_REQUEST_EVENT,
  CODEX_BAD_REQUEST_NESTED_EVENT,
  CODEX_CAPACITY_EVENT,
  CODEX_GATEWAY_EVENT,
  CODEX_RATE_LIMIT_EVENT,
  CODEX_STREAM_DISCONNECT_EVENT,
  CODEX_UNAUTHORIZED_EVENT,
  CODEX_UNCLASSIFIED_EVENT,
  CODEX_USAGE_LIMIT_EVENT,
} from './fixtures/codex-error-events.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

/** A codex run that reports one failure event and exits non-zero, as codex does. */
function failingSpawner(lines: Array<Record<string, unknown>>): Spawner {
  return async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 1
        child.emit('close', 1)
      }, 10)
    })
    return { child: child as never, release() {}, spawnError: () => null }
  }
}

const THREAD = { type: 'thread.started', thread_id: '019f3889-c05e-70c3-ae9f-3077da9454c4' }

function request(): ChatRequest {
  return { model: 'codex', messages: [{ role: 'user', content: 'do the thing' }], mode: 'byob' } as ChatRequest
}

async function relayedError(event: Record<string, unknown>): Promise<NonNullable<ChatDelta['error']>> {
  const backend = new CodexBackend({ bin: 'codex', timeoutMs: 0, spawner: failingSpawner([THREAD, event]) })
  const deltas: ChatDelta[] = []
  for await (const delta of backend.chat(request(), null, new AbortController().signal)) deltas.push(delta)
  const terminal = deltas.at(-1)
  expect(terminal?.finish_reason).toBe('error')
  expect(terminal?.error).toBeDefined()
  return terminal!.error!
}

describe('codex relays the provider refusal, not one opaque class', () => {
  it('surfaces a capacity refusal with the code codex gave it', async () => {
    const error = await relayedError(CODEX_CAPACITY_EVENT)
    expect(error.type).toBe('server_overloaded')
    // The CLI's own words survive intact; the code is carried beside them, not instead of them.
    expect(error.message).toBe(`codex: ${CODEX_CAPACITY_EVENT.message}`)
  })

  it('surfaces a rate-limit refusal with a different code', async () => {
    const error = await relayedError(CODEX_RATE_LIMIT_EVENT)
    expect(error.type).toBe('response_too_many_failed_attempts')
    expect(error.message).toBe(`codex: ${CODEX_RATE_LIMIT_EVENT.message}`)
  })

  it('surfaces a malformed-request refusal with a different code again', async () => {
    const error = await relayedError(CODEX_BAD_REQUEST_EVENT)
    expect(error.type).toBe('invalid_request_error')
    expect(error.message).toBe(`codex: ${CODEX_BAD_REQUEST_EVENT.message}`)
  })

  it('gives the three refusals the three codes their providers stated', async () => {
    const codes = await Promise.all(
      [CODEX_CAPACITY_EVENT, CODEX_RATE_LIMIT_EVENT, CODEX_BAD_REQUEST_EVENT].map(
        async (event) => (await relayedError(event)).type,
      ),
    )
    // Named rather than counted: a parser that let codex's `other` win would still
    // produce three distinct values, and three distinct wrong values is the regression.
    expect(codes).toEqual(['server_overloaded', 'response_too_many_failed_attempts', 'invalid_request_error'])
  })

  it('separates a spent allowance from an overloaded model and from expired credentials', async () => {
    expect((await relayedError(CODEX_USAGE_LIMIT_EVENT)).type).toBe('usage_limit_exceeded')
    expect((await relayedError(CODEX_UNAUTHORIZED_EVENT)).type).toBe('unauthorized')
  })

  it('carries the status the provider stated, which is what ends a retry loop', async () => {
    // 400 on the wrapper beside the body. agent-runtime prefers a structured status over
    // the message text and reads a 4xx as "fails identically forever", so this is the
    // field that stops a malformed request being retried to the attempt ceiling.
    expect((await relayedError(CODEX_BAD_REQUEST_NESTED_EVENT)).status).toBe(400)
    // 429 from the variant payload, which the classifier reads as worth another attempt.
    expect((await relayedError(CODEX_RATE_LIMIT_EVENT)).status).toBe(429)
  })

  it('states no status when the provider stated none as a field', async () => {
    // Codex names 502 in prose here. agent-runtime already reads a status out of message
    // text; a second scraper in the bridge would only disagree with it.
    expect((await relayedError(CODEX_GATEWAY_EVENT)).status).toBeUndefined()
    expect((await relayedError(CODEX_CAPACITY_EVENT)).status).toBeUndefined()
  })

  it('keeps reporting upstream when the refusal names no code at all', async () => {
    const error = await relayedError(CODEX_UNCLASSIFIED_EVENT)
    expect(error.type).toBe('upstream')
    expect(error.message).toBe(`codex: ${CODEX_UNCLASSIFIED_EVENT.message}`)
  })

  it('relays the code on a turn that codex still completes', async () => {
    const backend = new CodexBackend({
      bin: 'codex',
      timeoutMs: 0,
      spawner: failingSpawner([THREAD, CODEX_RATE_LIMIT_EVENT, { type: 'turn.completed', usage: {} }]),
    })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(request(), null, new AbortController().signal)) deltas.push(delta)
    expect(deltas.at(-1)?.error?.type).toBe('response_too_many_failed_attempts')
  })
})

describe('codexFailureReason reads both channels codex reports a refusal on', () => {
  it('names the variant by its key when the variant carries data', () => {
    // The commonest recorded rate-limit refusal: no `type` field to read.
    expect(codexFailureReason(CODEX_RATE_LIMIT_EVENT).type).toBe('response_too_many_failed_attempts')
  })

  it('reads a data-carrying variant field through the variant key it is nested under', () => {
    // The key and its fields are one nesting apart, and every reader of this channel has
    // to go through it: a flat read of `codex_error_info.http_status_code` matches a shape
    // serde never writes, so it would silently report no status on all 309 recordings.
    expect(codexFailureReason(CODEX_RATE_LIMIT_EVENT).status).toBe(429)
    expect(
      codexFailureReason({
        type: 'error',
        message: 'boom',
        codex_error_info: { response_too_many_failed_attempts: 'no fields' },
      }).status,
    ).toBeUndefined()
  })

  it('prefers the provider code over codex declining to classify', () => {
    // Both bad-request recordings arrive as `other` with the real code in the body.
    expect(codexFailureReason(CODEX_BAD_REQUEST_EVENT).type).toBe('invalid_request_error')
    expect(codexFailureReason(CODEX_BAD_REQUEST_NESTED_EVENT).type).toBe('invalid_request_error')
  })

  it('prefers a real discriminant over the provider body it quoted', () => {
    const reason = codexFailureReason({ ...CODEX_BAD_REQUEST_EVENT, codex_error_info: 'usage_limit_exceeded' })
    expect(reason.type).toBe('usage_limit_exceeded')
  })

  it('keeps other when the quoted body names no code either', () => {
    // A gateway fault: `other` is still what codex said, and it beats inventing nothing.
    expect(codexFailureReason(CODEX_GATEWAY_EVENT).type).toBe('other')
    // The transport fault codex reports as prose only is the same shape.
    expect(codexFailureReason(CODEX_STREAM_DISCONNECT_EVENT).type).toBe('other')
  })

  it('ignores a brace in the prose that is not the provider body', () => {
    const reason = codexFailureReason({
      type: 'error',
      message: 'sandbox denied exec error, exit code: 1, stderr: bad substitution near ${HOME',
    })
    expect(reason.type).toBe('upstream')
  })

  it('ignores a parseable object in the prose that is not an error body', () => {
    // Codex quotes tool calls and assistant output into the same message text, and the
    // first balanced object in a message is not therefore the provider's error body.
    expect(
      codexFailureReason({
        type: 'error',
        message: 'assistant said: {"type":"function_call","name":"shell"} then the turn failed',
      }).type,
    ).toBe('upstream')
  })

  it('refuses to relay a code the bridge itself assigns meaning to', () => {
    // The relay channel is shared with the bridge's taxonomy: the route answers 504 for
    // `timeout`, and agent-runtime never retries `parse_error`. Both words are reachable
    // from text a provider controls, so neither may be relayed off this channel.
    const timeout = codexFailureReason({
      type: 'error',
      message: 'stream error: {"error":{"type":"timeout","message":"gateway gave up"}}',
    })
    expect(timeout.type).toBe('upstream')
    expect(timeout.message).toContain('gateway gave up')
    expect(
      codexFailureReason({
        type: 'error',
        message: 'tool output echoed: {"error":{"type":"parse_error","message":"nope"}}',
        codex_error_info: 'other',
      }).type,
    ).toBe('other')
  })

  it('refuses to invent a reason for an event with no message', () => {
    expect(codexFailureReason({ type: 'error' })).toEqual({ message: 'codex error', type: 'upstream' })
  })
})
