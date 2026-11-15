import type { Spawner } from '../executors/types.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { redactCredentials } from '../runtime/redact-credentials.js'
import { retryCleanupUntilSuccessful, terminateSpawned } from '../executors/process-tree.js'

const STDERR_DRAIN_GRACE_MS = 500
const STDERR_TAIL_CHARS = 1_000

/**
 * Returns the last printable stderr characters with common credential shapes
 * removed. Native stderr is untrusted child output that reaches API callers.
 */
export function redactedStderrTail(stderr: string, maxChars = STDERR_TAIL_CHARS): string {
  const sanitized = redactCredentials(
    stderr
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]+/gu, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim()
  return sanitized.length <= maxChars ? sanitized : `...${sanitized.slice(-maxChars)}`
}

export interface NativeChildOptions {
  /** Names in errors: `process` for the pipe (`pi RPC`), `session` for the owner (`pi native session`). */
  names: { process: string; session: string }
  onStdout(chunk: string): void
  /** Settle the owner's waiters once the child is closed, before cleanup starts. */
  onEnd(error: Error): void
  cleanup(): void | Promise<void>
}

/**
 * The lifecycle of the one child process a retained native session owns:
 * close listeners, stderr diagnostics, termination, and cleanup that keeps the
 * lease and private files until the workload is proven stopped.
 */
export class NativeChild {
  readonly child: Awaited<ReturnType<Spawner>>['child']
  readonly stderr = new BoundedDiagnosticBuffer()
  closed = false
  error: Error | null = null
  closing: Promise<void> | null = null
  private readonly release: () => void
  private readonly terminateChild: () => Promise<void>
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private terminationInFlight: Promise<void> | null = null
  private readonly retryStartCleanup = (): Promise<void> => this.startCleanup()

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: NativeChildOptions) {
    const { process: processName, session } = options.names
    this.child = spawned.child
    this.release = spawned.release
    this.terminateChild = () => spawned.terminate
      ? spawned.terminate()
      : terminateSpawned(spawned).then((outcome) => {
          if (outcome !== 'stopped') throw new Error(`${session} termination ${outcome}`)
        })
    this.child.stdout?.on('data', (chunk) => options.onStdout(chunk.toString()))
    this.child.stderr?.on('data', (chunk) => this.stderr.append(chunk))
    this.child.stdin?.on('error', (error) => this.end(error))
    this.child.stdout?.on('end', () => this.endAfterStderrDrains(`${processName} stdout ended`))
    this.child.on('error', (error) => {
      this.error = error
      this.end(error)
    })
    this.child.on('close', () => this.end(this.error ?? this.exitError(`${processName} process closed`)))
  }

  async terminate(): Promise<void> {
    if (this.terminationInFlight) return this.terminationInFlight
    this.terminationInFlight = this.terminateChild()
    try {
      await this.terminationInFlight
    } finally {
      this.terminationInFlight = null
    }
  }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => {
        try {
          listener(this.error ?? new Error(`${this.options.names.process} process closed`))
        } catch {
          // A late owner cannot break child cleanup.
        }
      })
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  whenClosed(): Promise<void> {
    if (this.closed) return this.startCleanup()
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.onClose(() => {
        unsubscribe()
        this.startCleanup().then(resolve, reject)
      })
    })
  }

  /**
   * The child may report a fatal startup failure on stderr just before its
   * stdout closes. The two pipes end in no fixed order, so wait briefly for
   * stderr to drain before building the terminal error.
   */
  endAfterStderrDrains(reason: string): void {
    const stderr = this.child.stderr
    if (this.closed || !stderr || stderr.readableEnded || stderr.destroyed) {
      this.end(this.exitError(reason))
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.off('end', finish)
      stderr.off('close', finish)
      this.end(this.exitError(reason))
    }
    const timer = setTimeout(finish, STDERR_DRAIN_GRACE_MS)
    timer.unref?.()
    stderr.once('end', finish)
    stderr.once('close', finish)
  }

  exitError(reason: string): Error {
    const tail = redactedStderrTail(this.stderr.render())
    return new Error(tail ? `${reason}: ${tail}` : reason)
  }

  end(error: Error): void {
    const firstClose = !this.closed
    if (firstClose) this.closed = true
    this.error ??= error
    this.options.onEnd(this.error)
    const cleanup = this.startCleanup()
    if (firstClose) {
      for (const listener of [...this.closeListeners]) {
        try {
          listener(this.error)
        } catch {
          // A session owner cannot break child cleanup.
        }
      }
      this.closeListeners.clear()
    }
    void cleanup.catch((cleanupError) => {
      this.error ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
    })
  }

  startCleanup(): Promise<void> {
    if (this.closing) return this.closing
    const attempt = (async () => {
      try {
        await this.terminate()
      } catch (error) {
        // Keep the lease and private files until the owned workload stops.
        // A later attempt can prove the stop and finish cleanup.
        retryCleanupUntilSuccessful(this.retryStartCleanup)
        throw error
      }
      const failures: unknown[] = []
      try {
        await this.options.cleanup()
      } catch (error) {
        failures.push(error)
        retryCleanupUntilSuccessful(this.options.cleanup)
      }
      try {
        this.release()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, `${this.options.names.session} cleanup failed`)
    })()
    this.closing = attempt
    void attempt.catch(() => {
      if (this.closing === attempt) this.closing = null
    })
    return attempt
  }
}
