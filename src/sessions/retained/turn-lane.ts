/**
 * One ordered admission lane per retained session.
 *
 * A native child answers one turn at a time, so turns for a session are
 * serialized here rather than at the provider. `/turns` refuses to queue and
 * fails fast with 409; `/input` queues up to a bounded depth and fails with
 * 429 beyond it, or 408 if the caller gives up or the wait exceeds its budget.
 * The lane is released only once the previous turn's durable finalization has
 * settled, so the successor cannot observe a half-committed predecessor.
 */

import { RetainedSessionError } from './types.js'

interface TurnLane {
  tail: Promise<void>
  queued: number
}

export interface TurnLaneOptions {
  queue?: boolean
  signal?: AbortSignal
}

export interface TurnLaneTicket {
  /** Hand the lane to the next waiter now. */
  release(): void
  /** Hand the lane over once `settled` resolves or rejects. */
  releaseAfter(settled: Promise<unknown>): void
}

export class TurnLanes {
  private readonly lanes = new Map<string, TurnLane>()

  constructor(
    private readonly maxQueueDepth: number,
    private readonly queueTimeoutMs: number,
  ) {}

  /** True while a turn for this session owns or is queued behind the lane. */
  isActive(id: string): boolean {
    return this.lanes.has(id)
  }

  async acquire(id: string, options: TurnLaneOptions): Promise<TurnLaneTicket> {
    const existingLane = this.lanes.get(id)
    if (options.queue && existingLane && existingLane.queued >= this.maxQueueDepth) {
      throw new RetainedSessionError(
        `retained session ${JSON.stringify(id)} input queue is full at depth ${this.maxQueueDepth}`,
        429,
        'input_queue_full',
      )
    }
    const predecessor = existingLane?.tail ?? Promise.resolve()
    const lane = existingLane ?? { tail: Promise.resolve(), queued: 0 }
    if (existingLane && options.queue) lane.queued += 1
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    lane.tail = current
    this.lanes.set(id, lane)
    let waiting = Boolean(existingLane)
    try {
      if (waiting) {
        await waitForTurnLane(predecessor, options.signal, this.queueTimeoutMs)
        lane.queued -= 1
        waiting = false
      } else if (options.signal?.aborted) {
        throw admissionAborted()
      }
      if (options.signal?.aborted) {
        throw admissionAborted()
      }
    } catch (error) {
      if (waiting) {
        lane.queued -= 1
        if (lane.tail === current) lane.tail = predecessor
        void predecessor.then(release, release)
      } else {
        release()
      }
      this.forget(id, lane, current)
      throw error
    }
    return {
      release: () => {
        release()
        this.forget(id, lane, current)
      },
      releaseAfter: (settled) => {
        void settled.then(release, release)
        void current.then(() => this.forget(id, lane, current))
      },
    }
  }

  private forget(id: string, lane: TurnLane, current: Promise<void>): void {
    if (this.lanes.get(id) === lane && lane.tail === current) this.lanes.delete(id)
  }
}

function admissionAborted(): RetainedSessionError {
  return new RetainedSessionError('retained input was cancelled before turn admission', 408, 'input_queue_aborted')
}

async function waitForTurnLane(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) {
    throw new RetainedSessionError(
      'retained input was cancelled while waiting for turn admission',
      408,
      'input_queue_aborted',
    )
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void =>
      finish(() =>
        reject(
          new RetainedSessionError(
            'retained input was cancelled while waiting for turn admission',
            408,
            'input_queue_aborted',
          ),
        ),
      )
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new RetainedSessionError(
              `retained input waited more than ${timeoutMs}ms for turn admission`,
              408,
              'input_queue_timeout',
            ),
          ),
        ),
      timeoutMs,
    )
    timer.unref?.()
    predecessor.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    )
  })
}
