/**
 * The Agent-Interface face of a run: canonical events, committed durably.
 *
 * A canonical event is only real once its commit returns. When a commit fails
 * the stream stops claiming to know the outcome — publishing "failed" after
 * losing "completed" would turn an unknown result into a false negative — so
 * the durability flag lives here, next to the only code that can set it.
 */

import type { RuntimeEventEnvelope } from '@tangle-network/agent-interface'
import type { RunReplayLog } from './replay-log.js'
import type { CanonicalEventInput, CanonicalEventListener, RunStatus, SeqCanonicalEvent } from './types.js'

export interface CanonicalStreamHost {
  /** The run's own abort signal; only explicit cancellation raises it. */
  readonly signal: AbortSignal
  /** True when canonical events are written through to durable storage. */
  readonly commitsDurably: boolean
  cancelOutstandingInteractions(reason: string): void
  /** First failure wins — this is what readers are told went wrong. */
  recordFailure(error: unknown): void
  /** Replace the recorded failure; a setup failure supersedes an earlier one. */
  setFailure(error: unknown): void
  finish(status: Exclude<RunStatus, 'running'>): void
}

export class CanonicalRunStream {
  private durabilityFailed = false

  constructor(
    private readonly log: RunReplayLog,
    private readonly host: CanonicalStreamHost,
  ) {}

  append(input: CanonicalEventInput): RuntimeEventEnvelope {
    return this.log.appendCanonical(input)
  }

  subscribe(listener: CanonicalEventListener): () => void {
    return this.log.subscribeCanonical(listener)
  }

  assertCursor(afterSeq: number): void {
    this.log.assertCanonicalReplayCursor(afterSeq)
  }

  attach(afterSeq: number, readerSignal?: AbortSignal): AsyncGenerator<SeqCanonicalEvent> {
    return this.log.attachCanonical(afterSeq, readerSignal)
  }

  /** True once a commit failed and the run's outcome can no longer be proven. */
  durabilityUnknown(): boolean {
    return this.durabilityFailed
  }

  markDurabilityUnknown(error: unknown): void {
    this.durabilityFailed = true
    this.host.recordFailure(error)
  }

  async pump(source: AsyncIterable<CanonicalEventInput>): Promise<void> {
    let terminal: 'done' | 'error' | 'cancelled' = 'done'
    let terminalEvent: CanonicalEventInput | null = null
    try {
      for await (const input of source) {
        if (input.event.type === 'status' && (input.event.status === 'completed' || input.event.status === 'failed')) {
          terminalEvent = input
          if (input.event.status === 'failed') terminal = 'error'
          continue
        }
        this.append(input)
      }
      // Withdrawal must be durable before the terminal status. The terminal
      // status is held until the source ends so it can be the final canonical
      // event even when a provider left a dialog outstanding.
      this.host.cancelOutstandingInteractions(this.host.signal.aborted ? 'run cancelled' : 'run ended')
      if (this.host.signal.aborted) {
        this.append({ event: { type: 'status', status: 'failed', detail: 'cancelled' } })
        terminal = 'cancelled'
      } else if (terminalEvent) {
        this.append(terminalEvent)
      } else {
        const error = new Error('native event stream ended without an explicit terminal status')
        this.host.setFailure(error)
        terminal = 'error'
        this.append({ event: { type: 'status', status: 'failed', detail: error.message } })
      }
      this.host.finish(terminal)
    } catch (error) {
      this.host.recordFailure(error)
      // Once a commit has failed, a later terminal event cannot repair the
      // missing observation. Publishing "failed" after losing "completed"
      // would turn an unknown outcome into a false negative for every reader.
      if (!this.durabilityFailed) {
        if (this.host.signal.aborted) {
          try {
            this.host.cancelOutstandingInteractions('run cancelled')
            this.append({ event: { type: 'status', status: 'failed', detail: 'cancelled' } })
          } catch (durabilityError) {
            if (this.host.commitsDurably) this.markDurabilityUnknown(durabilityError)
          }
        } else {
          try {
            this.host.cancelOutstandingInteractions('run ended')
            this.append({
              event: {
                type: 'status',
                status: 'failed',
                detail: error instanceof Error ? error.message : String(error),
              },
            })
          } catch (durabilityError) {
            if (this.host.commitsDurably) this.markDurabilityUnknown(durabilityError)
          }
        }
      }
      this.host.finish(this.durabilityFailed ? 'unknown' : this.host.signal.aborted ? 'cancelled' : 'error')
    }
  }

  /** Commit a claimed run whose setup failed before the source existed. */
  failSetup(error: unknown): void {
    this.host.setFailure(error)
    const cancelled = this.host.signal.aborted
    try {
      this.append({
        event: {
          type: 'status',
          status: 'failed',
          detail: cancelled ? 'cancelled' : error instanceof Error ? error.message : String(error),
        },
      })
    } catch {
      // A storage failure has no safe second persistence path; terminal state
      // still records that this run never became executable.
    }
    this.host.finish(cancelled ? 'cancelled' : 'error')
  }
}
