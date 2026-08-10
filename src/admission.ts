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
  /**
   * Slots charged against `maxActive` right now. This is the number the gate
   * admits or refuses on.
   */
  active: number
  /**
   * Charged slots whose job is still running. `live` is what `active` claims to
   * measure, derived independently from the admitted jobs themselves.
   */
  live: number
  /**
   * `active - live`: capacity charged to work that has already finished. Any
   * value above 0 is a defect in this gate, and the reconciler takes those slots
   * back on its next pass.
   */
  stale: number
  /**
   * Charged slots that no caller ever bound to a job lifetime. Binding happens
   * in the same continuation as admission, so a non-zero value means a caller
   * returned or threw between the two and its slot has no owner.
   */
  unbound: number
  /** Age of the longest-held slot in ms; null when nothing is held. */
  oldestHeldMs: number | null
  /** Slots the reconciler has taken back since start. Above 0 means drift happened. */
  reclaimed: number
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

/**
 * The job a slot is admitted for.
 *
 * `isFinished` is the gate's independent ground truth. The gate charges a slot
 * on admission and takes it back when the job's lifetime settles; `isFinished`
 * is what lets it also take the slot back when that lifetime never settles,
 * so an accounted slot can never outlive the work it was accounted for.
 */
export interface AdmissionWork {
  /** Job identity, reported in reconciliation warnings. */
  readonly id: string
  /** True once this job can no longer be running. */
  isFinished(): boolean
}

/**
 * An admitted slot. It exposes no release: the gate owns that, so no exit path
 * — success, throw, disconnect, abort, timeout — can skip one.
 */
export interface AdmissionSlot {
  /**
   * Bind the slot to the job's lifetime. The gate releases the slot when `job`
   * settles, either way; the job's owner keeps its own handle and owns the
   * outcome. Call this exactly once, in the same continuation that received the
   * slot.
   */
  holdUntil(job: PromiseLike<unknown>): void
}

export interface AdmissionRequest {
  /** The job this slot is charged to. Required — it is what makes the count auditable. */
  work: AdmissionWork
  admissionClass?: AdmissionClass
  signal?: AbortSignal
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

interface HeldSlot {
  readonly admissionClass: AdmissionClass
  readonly work: AdmissionWork
  readonly acquiredAt: number
  bound: boolean
  released: boolean
}

interface Waiter {
  resolve: (slot: AdmissionSlot) => void
  reject: (err: AdmissionRejectedError) => void
  work: AdmissionWork
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
  /**
   * How often the gate re-derives its charged slots from the jobs it charged
   * them to. 0 disables the timer; `reconcile()` still runs on every admission
   * request, so a caller-driven gate stays correct without a clock.
   */
  reconcileIntervalMs?: number
  /** Injectable clock for slot ages. */
  now?: () => number
}

const DEFAULT_RECONCILE_INTERVAL_MS = 1_000

export class AdmissionGate {
  private readonly active: Record<AdmissionClass, number> = { reserved: 0, bulk: 0 }
  private readonly waiters: Record<AdmissionClass, Waiter[]> = { reserved: [], bulk: [] }
  private readonly held = new Set<HeldSlot>()
  private readonly now: () => number
  private readonly reconcileIntervalMs: number
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private reclaimed = 0

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
    const reconcileIntervalMs = opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < 0) {
      throw new Error(`invalid reconcileIntervalMs: ${opts.reconcileIntervalMs}`)
    }
    this.reconcileIntervalMs = reconcileIntervalMs
    this.now = opts.now ?? Date.now
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileIntervalMs)
      this.reconcileTimer.unref?.()
    }
  }

  /** Stop the reconcile timer. The gate stays usable; only the clock detaches. */
  close(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
  }

  /** Concurrency ceiling for `bulk`; `reserved` may use the full pool. */
  private bulkMaxActive(): number {
    return this.opts.maxActive - this.opts.reservedActive
  }

  private activeTotal(): number {
    return this.active.reserved + this.active.bulk
  }

  snapshot(): AdmissionSnapshot {
    let live = 0
    let unbound = 0
    let oldestAcquiredAt: number | null = null
    for (const slot of this.held) {
      if (!slot.work.isFinished()) live += 1
      if (!slot.bound) unbound += 1
      if (oldestAcquiredAt === null || slot.acquiredAt < oldestAcquiredAt) {
        oldestAcquiredAt = slot.acquiredAt
      }
    }
    const active = this.activeTotal()
    return {
      active,
      live,
      stale: active - live,
      unbound,
      oldestHeldMs: oldestAcquiredAt === null ? null : this.now() - oldestAcquiredAt,
      reclaimed: this.reclaimed,
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

  /**
   * Take back every charged slot whose job has already finished.
   *
   * A charged slot is a claim that work is running. When the job says otherwise,
   * the claim is drift, and drift is permanent capacity loss: the measured
   * failure was 20 of 20 slots charged to nothing, admitting nobody, while the
   * host executor reported zero work in flight. Reclaiming here bounds the loss
   * to one pass, and the warning turns an unexplained queue timeout into a
   * reported defect with the job id that caused it.
   *
   * Returns the number of slots reclaimed.
   */
  reconcile(): number {
    let reclaimedNow = 0
    for (const slot of [...this.held]) {
      if (slot.released) continue
      const heldMs = this.now() - slot.acquiredAt
      const finished = slot.work.isFinished()
      // Binding happens in the continuation that receives the slot, so a slot
      // still unbound after a full pass has no owner and never will.
      const ownerless = !slot.bound && heldMs >= this.staleUnboundMs()
      if (!finished && !ownerless) continue
      this.free(slot)
      this.reclaimed += 1
      reclaimedNow += 1
      const cause = finished
        ? `charged to finished job ${slot.work.id}`
        : `charged to job ${slot.work.id}, which no caller bound to a lifetime`
      console.warn(
        `[cli-bridge] admission reconciled: reclaimed a ${slot.admissionClass} slot ${cause} ` +
        `after ${heldMs}ms — its release was skipped. ` +
        `active=${this.activeTotal()}/${this.opts.maxActive} reclaimed_total=${this.reclaimed}`,
      )
    }
    return reclaimedNow
  }

  /** Grace before an unbound slot counts as ownerless. */
  private staleUnboundMs(): number {
    return this.reconcileIntervalMs > 0 ? this.reconcileIntervalMs : DEFAULT_RECONCILE_INTERVAL_MS
  }

  acquire(request: AdmissionRequest): Promise<AdmissionSlot> {
    // Drift found here is capacity this admission can use immediately.
    this.reconcile()

    const admissionClass = request.admissionClass ?? 'bulk'
    const { work, signal } = request
    if (signal?.aborted) {
      return Promise.reject(this.rejected('admission aborted before queueing', 'aborted', admissionClass))
    }

    if (this.canAdmit(admissionClass)) {
      return Promise.resolve(this.take(admissionClass, work))
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

    return new Promise<AdmissionSlot>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, work, signal }
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

  /** Charge one slot and hand back the only handle a caller gets. */
  private take(admissionClass: AdmissionClass, work: AdmissionWork): AdmissionSlot {
    this.active[admissionClass] += 1
    const slot: HeldSlot = {
      admissionClass,
      work,
      acquiredAt: this.now(),
      bound: false,
      released: false,
    }
    this.held.add(slot)
    return {
      holdUntil: (job: PromiseLike<unknown>): void => {
        if (slot.bound) {
          throw new Error(`admission slot for job ${work.id} is already bound to a job lifetime`)
        }
        slot.bound = true
        // Both settlements release. The gate observes the lifetime and never the
        // outcome — the job's owner already holds `job` and reports its failure.
        void Promise.resolve(job).then(() => this.free(slot), () => this.free(slot))
      },
    }
  }

  private free(slot: HeldSlot): void {
    if (slot.released) return
    slot.released = true
    this.held.delete(slot)
    if (this.active[slot.admissionClass] > 0) this.active[slot.admissionClass] -= 1
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
        next.resolve(this.take(admissionClass, next.work))
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
