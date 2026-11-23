/**
 * Shared ndjson JSON-RPC 2.0 transport over a child process's stdio.
 *
 * Used by every backend that drives an `<bin> acp`-style agent: the generic
 * ACP backend (hermes/openclaw) and the Kimi large-prompt transport. One
 * implementation of the framing concept:
 *
 *   - one JSON value per newline-terminated line in each direction
 *   - client requests carry numeric ids and resolve/reject through a pending map
 *   - server-initiated messages are dispatched BY METHOD first: both ends
 *     choose ids independently, so a server request whose id collides with
 *     one of our outstanding calls must reach onMessage, not resolve that
 *     call (measured with a real child sending overlapping same-id traffic)
 *   - stdout is decoded as ONE UTF-8 stream across chunk boundaries — a pipe
 *     write can split a 4-byte character, and per-chunk toString() replaced
 *     東京🙂 café with U+FFFD garbage
 *   - terminal conditions (stdout end, child close, stdin write failure)
 *     reject and clear every outstanding request: a closed peer must never
 *     leave a pending call unresolved, and writes are never retried
 *   - writes respect pipe backpressure (a 200-KiB prompt frame must await
 *     `drain`, not buffer unbounded) and EPIPE surfaces as a captured failure
 *     instead of an unhandled stream error
 *
 * Responses to SERVER requests (permission refusals, capability declines) go
 * back through `respond`/`respondError`; the transport never invents one.
 */

import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Writable } from 'node:stream'

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number | string; message?: string; data?: unknown }
}

/** A JSON-RPC error response to one of our requests, shape preserved. */
export class RpcCallError extends Error {
  constructor(
    public readonly code: number | string | undefined,
    message: string,
    public readonly data: unknown,
  ) {
    super(message)
    this.name = 'RpcCallError'
  }
}

export interface NdjsonRpcOptions {
  child: ChildProcess
  stdin: Writable
  stdout: NodeJS.ReadableStream
  /** Label for transport failure messages, e.g. 'kimi acp'. */
  label?: string
  /** Notifications and server→client requests. Responses to our own requests never reach this. */
  onMessage?: (message: JsonRpcMessage) => void
  /** stdout reached EOF; no further messages can arrive. */
  onEnd?: () => void
}

export interface NdjsonRpc {
  /** Send a request and await its result. Rejects with RpcCallError on an error response. */
  request(method: string, params?: unknown): Promise<unknown>
  /** Fire-and-forget notification (no id). */
  notify(method: string, params?: unknown): void
  /** Answer a server→client request with a result. */
  respond(id: number | string, result: unknown): void
  /** Answer a server→client request with an error. */
  respondError(id: number | string, code: number, message: string): void
  /** The write-side failure captured so far (EPIPE, closed stdin), if any. */
  writeFailure(): Error | null
}

export function attachNdjsonRpc(opts: NdjsonRpcOptions): NdjsonRpc {
  const label = opts.label ?? 'agent rpc'
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let writeChain: Promise<void> = Promise.resolve()
  let writeError: Error | null = null
  let terminated = false

  // Terminal (stdout end / child close / write failure): every outstanding
  // call rejects — a closed peer leaves nothing resolvable — and nothing is
  // ever written or retried afterwards.
  const failAll = (reason: string): void => {
    if (terminated) return
    terminated = true
    const error = new Error(`${label}: ${reason}`)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  opts.stdin.on('error', (err: Error) => {
    if (!writeError) writeError = err
    failAll(`stdin write failed: ${err.message}`)
  })

  const send = (msg: JsonRpcMessage): Promise<void> => {
    const payload = `${JSON.stringify(msg)}\n`
    writeChain = writeChain.then(async () => {
      if (writeError || terminated) throw writeError ?? new Error(`${label}: transport closed`)
      if (!opts.stdin.write(payload)) {
        await new Promise<void>((resolve) => {
          const onDrain = (): void => { cleanup(); resolve() }
          const onError = (): void => { cleanup(); resolve() }
          const cleanup = (): void => {
            opts.stdin.off('drain', onDrain)
            opts.stdin.off('error', onError)
          }
          opts.stdin.once('drain', onDrain)
          opts.stdin.once('error', onError)
        })
      }
    }).catch(() => {
      // Captured in writeError / surfaced through failAll — never retried.
    })
    return writeChain
  }

  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: JsonRpcMessage
    try { message = JSON.parse(trimmed) as JsonRpcMessage } catch { return }
    // Method first: a server REQUEST or NOTIFICATION is dispatched even when
    // its id collides with one of our outstanding calls; only method-less
    // frames are responses, and only then does the pending map apply.
    if (message.method !== undefined) {
      opts.onMessage?.(message)
    } else if (message.id !== undefined && pending.has(message.id as number)) {
      const entry = pending.get(message.id as number)!
      pending.delete(message.id as number)
      if (message.error) {
        const e = message.error
        entry.reject(new RpcCallError(e.code, e.message ?? 'JSON-RPC error', e.data))
      } else {
        entry.resolve(message.result)
      }
    }
    // A response with an unknown id (duplicate or late reply) is dropped.
  }
  opts.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      handleLine(line)
    }
  })
  opts.stdout.on('end', () => {
    buffer += decoder.end()
    opts.onEnd?.()
    failAll('stdout closed before a response arrived')
  })
  opts.stdout.on('error', (err: Error) => { failAll(`stdout error: ${err.message}`) })
  opts.child.once('close', () => { failAll('child closed before a response arrived') })

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        void send({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      void send({ jsonrpc: '2.0', method, params })
    },
    respond(id, result) {
      void send({ jsonrpc: '2.0', id, result })
    },
    respondError(id, code, message) {
      void send({ jsonrpc: '2.0', id, error: { code, message } })
    },
    writeFailure() {
      return writeError
    },
  }
}
