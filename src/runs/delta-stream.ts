/**
 * The OpenAI face of a run: `ChatDelta`s appended to the replay log.
 *
 * Its whole job is that a terminal failure never reaches a caller bare. A
 * failure arrives two ways — thrown, or yielded as `{ finish_reason: 'error' }`
 * — and both have to end with a reason on the terminal delta and a recorded
 * failure the reader can turn into a real HTTP status.
 */

import type { ChatDelta } from '../backends/types.js'
import { BackendReportedFailureError, describeRunFailure, reasonForTerminalDelta } from './error-shape.js'
import type { RunReplayLog } from './replay-log.js'
import type { RunStatus } from './types.js'

export interface DeltaStreamHost {
  readonly runId: string
  /** The run's own abort signal; only explicit cancellation raises it. */
  readonly signal: AbortSignal
  /** First failure wins — used when a yielded terminal delta carries a reason. */
  recordFailure(error: unknown): void
  /** Replace the recorded failure; a thrown failure supersedes a yielded one. */
  setFailure(error: unknown): void
  /** A failure before any output — the only kind that can replace the body. */
  setSetupError(error: unknown): void
  finish(status: Exclude<RunStatus, 'running'>): void
}

export interface DeltaStreamOptions {
  terminalReceipt?: () => ChatDelta['profile_materialization'] | undefined
}

export class DeltaRunStream {
  constructor(
    private readonly log: RunReplayLog,
    private readonly host: DeltaStreamHost,
    private readonly options: DeltaStreamOptions = {},
  ) {}

  /**
   * Consume the backend exactly once, independently from attached readers.
   *
   * Only the thrown path was covered originally, and the yielded one is the
   * one that reached callers: the loop appended the bare delta, `finish()`
   * recorded status `error`, and no failure was recorded — so the reader had
   * nothing to report and answered HTTP 200 with `content: ""`. Normalizing
   * inside this loop is what makes the invariant hold for backends that do not
   * exist yet.
   */
  async pump(source: AsyncIterable<ChatDelta>, options: DeltaStreamOptions = this.options): Promise<void> {
    try {
      let outcome: 'done' | 'error' = 'done'
      for await (const delta of source) {
        this.log.append(this.withTerminalReason(delta))
        if (delta.finish_reason === 'error' || delta.finish_reason === 'timeout') {
          outcome = 'error'
        }
      }
      this.host.finish(this.host.signal.aborted ? 'cancelled' : outcome)
    } catch (error) {
      if (this.host.signal.aborted) {
        this.host.finish('cancelled')
      } else {
        this.host.setFailure(error)
        if (this.log.lastSeq() === 0) this.host.setSetupError(error)
        // The reason rides ON the terminal delta, so it survives buffering,
        // replay and reconnect. A bare `{ finish_reason: 'error' }` left the
        // caller with an empty completion whose only explanation was in this
        // process's stdout.
        const receipt = options.terminalReceipt?.()
        if (receipt) this.log.append({ profile_materialization: receipt })
        this.log.append({ finish_reason: 'error', error: describeRunFailure(error) })
        this.host.finish('error')
        console.error(`[cli-bridge] run ${this.host.runId} failed:`, error)
      }
    }
  }

  /** Commit a claimed run whose admission/backend setup failed before `pump()`. */
  failSetup(error: unknown): void {
    this.host.setSetupError(error)
    this.host.setFailure(error)
    this.log.append({ finish_reason: 'error', error: describeRunFailure(error) })
    this.host.finish(this.host.signal.aborted ? 'cancelled' : 'error')
  }

  /**
   * Give a yielded terminal failure the reason it must carry, and record it as
   * the run's failure so the reader can turn it into a real HTTP status.
   *
   * Cancellation is deliberately excluded: the caller asked for it, `finish()`
   * already records status `cancelled`, and calling it a failure would make a
   * granted request read as a fault. The delta still gets a reason, so a reader
   * can tell a cancelled run from an empty answer.
   */
  private withTerminalReason(delta: ChatDelta): ChatDelta {
    const finishReason = delta.finish_reason
    if (finishReason !== 'error' && finishReason !== 'timeout') return delta
    if (this.host.signal.aborted) {
      return {
        ...delta,
        error: delta.error ?? {
          message: `run ${this.host.runId} was cancelled by the caller before it produced a terminal answer`,
          type: 'run_cancelled',
        },
      }
    }
    const reason = reasonForTerminalDelta(finishReason, delta.error, 'the backend')
    this.host.recordFailure(new BackendReportedFailureError(reason.message, reason.type))
    return { ...delta, error: reason }
  }
}
