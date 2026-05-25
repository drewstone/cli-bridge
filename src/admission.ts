export interface AdmissionSnapshot {
  active: number
  queued: number
  maxActive: number
  maxQueue: number
}

export interface AdmissionLease {
  release(): void
}

export class AdmissionRejectedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'queue_full' | 'queue_timeout' | 'aborted',
    public readonly snapshot: AdmissionSnapshot,
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
  maxQueue: number
  queueTimeoutMs: number
}

export class AdmissionGate {
  private active = 0
  private readonly waiters: Waiter[] = []

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
  }

  snapshot(): AdmissionSnapshot {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxActive: this.opts.maxActive,
      maxQueue: this.opts.maxQueue,
    }
  }

  acquire(signal?: AbortSignal): Promise<AdmissionLease> {
    if (signal?.aborted) {
      return Promise.reject(this.rejected('admission aborted before queueing', 'aborted'))
    }

    if (this.active < this.opts.maxActive) {
      this.active += 1
      return Promise.resolve(this.makeLease())
    }

    if (this.waiters.length >= this.opts.maxQueue) {
      return Promise.reject(this.rejected('cli-bridge is saturated: admission queue is full', 'queue_full'))
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      waiter.onAbort = () => {
        this.removeWaiter(waiter)
        reject(this.rejected('cli-bridge admission aborted while queued', 'aborted'))
      }
      if (signal) {
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      if (this.opts.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(waiter)
          reject(this.rejected(`cli-bridge admission timed out after ${this.opts.queueTimeoutMs}ms`, 'queue_timeout'))
        }, this.opts.queueTimeoutMs)
        waiter.timer.unref?.()
      }
      this.waiters.push(waiter)
    })
  }

  private makeLease(): AdmissionLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.release()
      },
    }
  }

  private release(): void {
    if (this.active > 0) this.active -= 1
    while (this.waiters.length > 0 && this.active < this.opts.maxActive) {
      const next = this.waiters.shift()
      if (!next) return
      this.cleanup(next)
      if (next.signal?.aborted) {
        next.reject(this.rejected('cli-bridge admission aborted while queued', 'aborted'))
        continue
      }
      this.active += 1
      next.resolve(this.makeLease())
      return
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter)
    if (idx !== -1) this.waiters.splice(idx, 1)
    this.cleanup(waiter)
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private rejected(message: string, reason: AdmissionRejectedError['reason']): AdmissionRejectedError {
    return new AdmissionRejectedError(message, reason, this.snapshot())
  }
}
