/**
 * Admission classes.
 *
 * `reserved` callers are low-rate and high-importance: the automated PR
 * reviewer issues a couple of calls per pull request and its answer gates a
 * merge, so a rejection is a correctness problem, not a throughput problem.
 * `bulk` callers are high-rate and rate-tolerant: an agent fleet can wait.
 *
 * The two classes exist because a single FIFO pool lets bulk traffic starve
 * the reviewer — it is outnumbered at every instant, so it queues behind work
 * whose median hold time exceeds its own admission timeout.
 */
export type AdmissionClass = 'reserved' | 'bulk'

export const ADMISSION_CLASSES: readonly AdmissionClass[] = ['reserved', 'bulk']

export interface AdmissionSnapshot {
  active: number
  queued: number
  maxActive: number
  maxQueue: number
  /** Slots inside `maxActive` that only `reserved` callers may occupy. */
  reservedActive: number
  /** Ceiling on concurrent `bulk` calls: `maxActive - reservedActive`. */
  bulkMaxActive: number
  activeByClass: Record<AdmissionClass, number>
  queuedByClass: Record<AdmissionClass, number>
}

export interface AdmissionLease {
  release(): void
}

export class AdmissionRejectedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'queue_full' | 'queue_timeout' | 'aborted',
    public readonly snapshot: AdmissionSnapshot,
    public readonly admissionClass: AdmissionClass,
  ) {
    super(message)
    this.name = 'AdmissionRejectedError'
  }
}

interface Waiter {
  resolve: (lease: AdmissionLease) => void
  reject: (err: AdmissionRejectedError) => void
  signal?: AbortSignal
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

export interface AdmissionGateOptions {
  maxActive: number
  /**
   * Queue cap applied PER CLASS, not across the gate. A shared cap would let
   * bulk waiters fill the queue and force a reserved caller into `queue_full`,
   * which is the starvation the reserved lane exists to prevent.
   */
  maxQueue: number
  /** Queue timeout for `reserved` callers. */
  queueTimeoutMs: number
  /** Slots held back for `reserved` callers. 0 restores a single shared pool. */
  reservedActive: number
  /**
   * Queue timeout for `bulk` callers. Bulk work is rate-tolerant, so it should
   * wait rather than fail; keep it under the caller's socket idle timeout so a
   * rejection still arrives as a typed 503 rather than a client-side hang.
   */
  bulkQueueTimeoutMs: number
}

export class AdmissionGate {
  private readonly active: Record<AdmissionClass, number> = { reserved: 0, bulk: 0 }
  private readonly waiters: Record<AdmissionClass, Waiter[]> = { reserved: [], bulk: [] }

  constructor(private readonly opts: AdmissionGateOptions) {
    if (!Number.isInteger(opts.maxActive) || opts.maxActive < 1) {
      throw new Error(`invalid maxActive: ${opts.maxActive}`)
    }
    if (!Number.isInteger(opts.maxQueue) || opts.maxQueue < 0) {
      throw new Error(`invalid maxQueue: ${opts.maxQueue}`)
    }
    if (!Number.isInteger(opts.queueTimeoutMs) || opts.queueTimeoutMs < 0) {
      throw new Error(`invalid queueTimeoutMs: ${opts.queueTimeoutMs}`)
    }
    if (!Number.isInteger(opts.bulkQueueTimeoutMs) || opts.bulkQueueTimeoutMs < 0) {
      throw new Error(`invalid bulkQueueTimeoutMs: ${opts.bulkQueueTimeoutMs}`)
    }
    // reservedActive === maxActive would leave bulk with a zero ceiling and
    // block the fleet forever, so the lane must leave at least one bulk slot.
    if (!Number.isInteger(opts.reservedActive) || opts.reservedActive < 0 || opts.reservedActive >= opts.maxActive) {
      throw new Error(
        `invalid reservedActive: ${opts.reservedActive} — expected an integer in [0, ${opts.maxActive - 1}]`,
      )
    }
  }

  /** Concurrency ceiling for `bulk`; `reserved` may use the full pool. */
  private bulkMaxActive(): number {
    return this.opts.maxActive - this.opts.reservedActive
  }

  private activeTotal(): number {
    return this.active.reserved + this.active.bulk
  }

  snapshot(): AdmissionSnapshot {
    return {
      active: this.activeTotal(),
      queued: this.waiters.reserved.length + this.waiters.bulk.length,
      maxActive: this.opts.maxActive,
      maxQueue: this.opts.maxQueue,
      reservedActive: this.opts.reservedActive,
      bulkMaxActive: this.bulkMaxActive(),
      activeByClass: { ...this.active },
      queuedByClass: {
        reserved: this.waiters.reserved.length,
        bulk: this.waiters.bulk.length,
      },
    }
  }

  acquire(signal?: AbortSignal, admissionClass: AdmissionClass = 'bulk'): Promise<AdmissionLease> {
    if (signal?.aborted) {
      return Promise.reject(this.rejected('admission aborted before queueing', 'aborted', admissionClass))
    }

    if (this.canAdmit(admissionClass)) {
      this.active[admissionClass] += 1
      return Promise.resolve(this.makeLease(admissionClass))
    }

    const queue = this.waiters[admissionClass]
    if (queue.length >= this.opts.maxQueue) {
      return Promise.reject(this.rejected(
        `cli-bridge is saturated: ${admissionClass} admission queue is full ` +
        `(${queue.length}/${this.opts.maxQueue})`,
        'queue_full',
        admissionClass,
      ))
    }

    const queueTimeoutMs = admissionClass === 'reserved'
      ? this.opts.queueTimeoutMs
      : this.opts.bulkQueueTimeoutMs

    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      waiter.onAbort = () => {
        this.removeWaiter(admissionClass, waiter)
        reject(this.rejected('cli-bridge admission aborted while queued', 'aborted', admissionClass))
      }
      if (signal) {
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      if (queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(admissionClass, waiter)
          reject(this.rejected(
            `cli-bridge admission timed out after ${queueTimeoutMs}ms in the ${admissionClass} lane`,
            'queue_timeout',
            admissionClass,
          ))
        }, queueTimeoutMs)
        waiter.timer.unref?.()
      }
      queue.push(waiter)
    })
  }

  private canAdmit(admissionClass: AdmissionClass): boolean {
    if (this.activeTotal() >= this.opts.maxActive) return false
    if (admissionClass === 'bulk') return this.active.bulk < this.bulkMaxActive()
    return true
  }

  private makeLease(admissionClass: AdmissionClass): AdmissionLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.release(admissionClass)
      },
    }
  }

  private release(admissionClass: AdmissionClass): void {
    if (this.active[admissionClass] > 0) this.active[admissionClass] -= 1
    this.drain()
  }

  /**
   * Hand freed slots to waiters, `reserved` before `bulk`; FIFO within a class.
   *
   * The reservation is hard: bulk never exceeds `bulkMaxActive`, even while the
   * reserved lane sits idle. Letting bulk borrow an idle reserved slot would
   * put the reviewer back behind a median host call (~137s measured) on the
   * next arrival, which is the starvation this lane exists to remove. The price
   * is `reservedActive` slots idle while no reviewer is running.
   */
  private drain(): void {
    for (const admissionClass of ADMISSION_CLASSES) {
      const queue = this.waiters[admissionClass]
      while (queue.length > 0 && this.canAdmit(admissionClass)) {
        const next = queue.shift()
        if (!next) break
        this.cleanup(next)
        if (next.signal?.aborted) {
          next.reject(this.rejected('cli-bridge admission aborted while queued', 'aborted', admissionClass))
          continue
        }
        this.active[admissionClass] += 1
        next.resolve(this.makeLease(admissionClass))
      }
    }
  }

  private removeWaiter(admissionClass: AdmissionClass, waiter: Waiter): void {
    const queue = this.waiters[admissionClass]
    const idx = queue.indexOf(waiter)
    if (idx !== -1) queue.splice(idx, 1)
    this.cleanup(waiter)
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private rejected(
    message: string,
    reason: AdmissionRejectedError['reason'],
    admissionClass: AdmissionClass,
  ): AdmissionRejectedError {
    return new AdmissionRejectedError(message, reason, this.snapshot(), admissionClass)
  }
}
