/**
 * Shared helper for piping NDJSON-framed prompts into CLI subprocesses
 * via stdin instead of argv.
 *
 * Why this exists:
 *
 *   Claude Code, Kimi, and other coding CLIs accept `--input-format
 *   stream-json` which reads NDJSON messages from stdin (one JSON
 *   object per line). The previous code path packed the entire prompt
 *   into a single `--prompt <text>` argv argument, which collides
 *   with Linux's per-argv-string limit (`MAX_ARG_STRLEN` =
 *   PAGE_SIZE × 32 = 128 KiB on x86_64). Any caller passing a long
 *   system prompt or multi-turn history hit `spawn E2BIG` with no
 *   clear error from the agent's perspective.
 *
 *   Routing through stdin eliminates the limit entirely — kernel
 *   stack-page accounting for argv+envp no longer applies to data
 *   handed in through file descriptors.
 *
 * Resilience contract:
 *
 *   - Handle EPIPE: if the subprocess closes stdin before we finish
 *     writing (which it shouldn't, but defensive programming),
 *     surface as a `BackendError`-friendly result, not a crash.
 *   - Handle backpressure: the kernel pipe buffer is 64 KiB on Linux
 *     by default. Larger payloads need `writable.write()` to await
 *     the `drain` event. We do that.
 *   - Always close stdin with `.end()` so the subprocess sees EOF
 *     and stops waiting for more messages.
 *   - Caller drives the abort signal — we don't subscribe here;
 *     callers already kill the child on abort, which collapses
 *     the stdin pipe naturally.
 */

import type { Writable } from 'node:stream'

export interface StdinMessage {
  role: 'user'
  content: string
}

export type WriteStdinResult =
  | { ok: true; bytesWritten: number }
  | { ok: false; error: string }

/**
 * NDJSON envelope shape for `--input-format stream-json`.
 *
 *  - 'claude'  → `{"type":"user","message":{"role":"user","content":"…"}}`
 *               (Claude Code CLI; the original, wrapped, envelope).
 *  - 'flat'    → `{"role":"user","content":"…"}`
 *               (Kimi CLI 1.44.0; parses ONLY the flat shape, silently
 *                emits zero output if handed claude's wrapped envelope.)
 *
 * Defaults to 'claude' to preserve existing callers (claude.ts).
 */
export type StdinPayloadFormat = 'claude' | 'flat'

export interface WriteStdinOptions {
  format?: StdinPayloadFormat
}

/**
 * Serialise `messages` as NDJSON in the requested `--input-format
 * stream-json` schema (see {@link StdinPayloadFormat}) and pipe them
 * into `stdin`. Closes the stream when done. Tolerates EPIPE and
 * backpressure.
 */
export async function writeStdinPayload(
  stdin: Writable,
  messages: readonly StdinMessage[],
  options?: WriteStdinOptions,
): Promise<WriteStdinResult> {
  const format = options?.format ?? 'claude'
  const lines = messages.map((m) => {
    const payload = format === 'flat'
      ? { role: m.role, content: m.content }
      : { type: 'user', message: { role: m.role, content: m.content } }
    return `${JSON.stringify(payload)}\n`
  })
  let bytesWritten = 0
  let pipeError: string | undefined

  // Re-emit errors as a captured field instead of unhandled exceptions
  // — without this an EPIPE on a closed subprocess takes down the
  // whole cli-bridge process. The `error` listener returns the
  // failure to the caller via `pipeError`; the subsequent write
  // attempt also returns false so we know to bail out.
  stdin.on('error', (err) => {
    pipeError = err instanceof Error ? err.message : String(err)
  })

  for (const line of lines) {
    if (pipeError) return { ok: false, error: pipeError }
    const wroteFully = stdin.write(line)
    bytesWritten += Buffer.byteLength(line, 'utf8')
    if (!wroteFully) {
      // Pipe buffer full — wait for drain before continuing so we
      // don't queue an unbounded amount of in-memory data.
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          stdin.off('error', onError)
          resolve()
        }
        const onError = () => {
          stdin.off('drain', onDrain)
          resolve() // pipeError is already captured
        }
        stdin.once('drain', onDrain)
        stdin.once('error', onError)
      })
    }
  }
  if (pipeError) return { ok: false, error: pipeError }

  await new Promise<void>((resolve) => {
    stdin.end(() => resolve())
  })

  if (pipeError) return { ok: false, error: pipeError }
  return { ok: true, bytesWritten }
}
