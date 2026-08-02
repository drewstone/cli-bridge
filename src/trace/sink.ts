/**
 * Span sink — append-only OTLP-JSONL on local disk, one JSON object per line.
 *
 * JSONL rather than an OTLP/HTTP exporter on purpose: the bridge must stay a
 * zero-OTel-SDK service, and a file is the one transport that cannot make a
 * request wait on a collector being up.
 *
 * Two rules the implementation exists to guarantee:
 *   1. A sink failure never reaches the request. Every filesystem call is
 *      wrapped; a full disk, a read-only mount or a deleted directory costs the
 *      trace, never the completion the caller asked for.
 *   2. A long-lived bridge cannot fill the disk. The file is capped and rotated
 *      through a fixed number of generations, so total on-disk trace bytes are
 *      bounded by `maxBytes * maxFiles` plus at most one oversized final record.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContractSpan } from '@tangle-network/agent-trace-contract'

export interface SpanSink {
  /** Append one request's spans. MUST NOT throw. */
  write(spans: readonly ContractSpan[]): void
}

/** The sink used when tracing is disabled. */
export const nullSpanSink: SpanSink = { write() {} }

export interface JsonlSpanSinkOptions {
  /** Absolute path of the active JSONL file. Rotated generations get `.1`, `.2`, … */
  file: string
  /** Rotate once the active file would exceed this many bytes. */
  maxBytes: number
  /** Total generations retained, including the active file. Minimum 1. */
  maxFiles: number
  /** Injectable for tests. Defaults to `console.error`. */
  log?: (message: string) => void
}

/** Distinct sink error messages logged before the sink goes quiet about them. */
const MAX_DISTINCT_ERRORS_LOGGED = 20

export class JsonlSpanSink implements SpanSink {
  private readonly file: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly log: (message: string) => void
  /** Bytes in the active file. `null` until the first write measures it. */
  private bytes: number | null = null
  private readonly loggedErrors = new Set<string>()

  constructor(options: JsonlSpanSinkOptions) {
    this.file = options.file
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes))
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles))
    this.log = options.log ?? ((message) => console.error(message))
  }

  write(spans: readonly ContractSpan[]): void {
    if (spans.length === 0) return
    try {
      const payload = `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`
      const size = Buffer.byteLength(payload)
      if (this.bytes === null) {
        mkdirSync(dirname(this.file), { recursive: true })
        this.bytes = fileSize(this.file)
      }
      // Rotate BEFORE writing, and only when the file already holds something:
      // rotating an empty file would spend a generation on nothing and, for a
      // record larger than the cap, would rotate on every single write.
      if (this.bytes > 0 && this.bytes + size > this.maxBytes) {
        this.rotate()
        this.bytes = 0
      }
      appendFileSync(this.file, payload)
      this.bytes += size
    } catch (error) {
      // Re-measure next time: the failure may have been a rename/unlink race,
      // and a stale byte count would then rotate at the wrong point forever.
      this.bytes = null
      this.report(error)
    }
  }

  /**
   * Shift generations down and make the active file `.1`. The oldest generation
   * is removed first so the rename chain never has to overwrite a live file.
   */
  private rotate(): void {
    const oldest = `${this.file}.${this.maxFiles - 1}`
    if (this.maxFiles > 1 && existsSync(oldest)) rmSync(oldest, { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index--) {
      const from = `${this.file}.${index}`
      if (existsSync(from)) renameSync(from, `${this.file}.${index + 1}`)
    }
    if (this.maxFiles > 1) {
      renameSync(this.file, `${this.file}.1`)
    } else {
      // One generation retained: the active file IS the whole budget, so the
      // only way to stay under the cap is to drop what it already holds.
      rmSync(this.file, { force: true })
    }
  }

  /**
   * Log each distinct failure once. A full disk fails on every request, and a
   * per-request log line would bury the bridge's real output in its own noise.
   */
  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (this.loggedErrors.has(message)) return
    if (this.loggedErrors.size >= MAX_DISTINCT_ERRORS_LOGGED) return
    this.loggedErrors.add(message)
    this.log(`[cli-bridge] trace sink write failed (tracing degraded, requests unaffected): ${message}`)
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
