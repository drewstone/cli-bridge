/**
 * Ownership of the one retained provider child a run may hold.
 *
 * Every mutation of that ownership — attach, handoff, inspect, deliberate
 * close, abort-and-close — runs on a single serialized lane, so a response
 * already in flight cannot race a cancellation and two durable
 * acknowledgements cannot disagree about which side effect won.
 *
 * The policy of WHEN each transition is legal stays with the run; this owns
 * the mechanism and the failure bookkeeping that lets a failed cleanup be
 * retried by the same owner instead of collapsing into an unknown state.
 */

import type { NativeSession } from '../backends/types.js'

export interface NativeControlHost {
  readonly runId: string
  isDisposed(): boolean
  /** False while disposal or cancellation is already accounting for the loss. */
  shouldReportLoss(): boolean
  reportLoss(reason: Error): void
}

export class NativeRunControl {
  private control: NativeSession | null = null
  private closeUnsubscribe: (() => void) | null = null
  private pendingFinalization: Promise<void> | null = null
  private unexpectedClose: NativeSession | null = null
  private cleanupFailure: unknown = null
  private attachmentReservations = 0
  private readonly attachmentWaiters = new Set<() => void>()
  private lane_: Promise<void> = Promise.resolve()

  constructor(private readonly host: NativeControlHost) {}

  /** Serialize one ownership transition behind every transition before it. */
  lane<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lane_
    let release!: () => void
    this.lane_ = new Promise<void>((resolve) => {
      release = resolve
    })
    return (async () => {
      await previous
      try {
        return await operation()
      } finally {
        release()
      }
    })()
  }

  set(control: NativeSession): void {
    if (this.host.isDisposed() && this.attachmentReservations === 0) {
      throw new Error(`run ${this.host.runId} cannot accept native session control after disposal`)
    }
    if (this.control && this.control !== control) {
      throw new Error(`run ${this.host.runId} already owns a native session control`)
    }
    this.control = control
    this.unexpectedClose = null
    this.cleanupFailure = null
    this.closeUnsubscribe?.()
    this.closeUnsubscribe = control.onClose((reason) => {
      this.handleClosed(control, reason)
    })
    if (control.isClosed()) {
      this.handleClosed(control, new Error('native session closed before ownership was established'))
    }
  }

  /** The owned child as recorded, without probing whether it is still open. */
  current(): NativeSession | null {
    return this.control
  }

  /** The owned child, or null once a close has been observed and accounted for. */
  live(): NativeSession | null {
    if (this.control?.isClosed()) {
      this.handleClosed(this.control, new Error('native session is closed'))
      return null
    }
    return this.control
  }

  owns(control: NativeSession): boolean {
    return this.control === control
  }

  finalization(): Promise<void> | null {
    return this.pendingFinalization
  }

  /** Keep disposal pending while an asynchronous start or handoff may return a child. */
  reserveAttachment(): () => void {
    if (this.host.isDisposed())
      throw new Error(`run ${this.host.runId} cannot reserve native session control after disposal`)
    this.attachmentReservations += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.attachmentReservations -= 1
      if (this.attachmentReservations === 0) {
        for (const resolve of this.attachmentWaiters) resolve()
        this.attachmentWaiters.clear()
      }
    }
  }

  /**
   * Surrender a retained provider session to the next native run without
   * letting the completed run close it when its replay window expires. Must
   * be called on the lane.
   */
  releaseForHandoff(control: NativeSession): boolean {
    if (this.control !== control || this.pendingFinalization || control.isClosed()) return false
    this.closeUnsubscribe?.()
    this.closeUnsubscribe = null
    this.control = null
    return true
  }

  /** Inspect retained provider state while close and handoff are excluded. */
  async inspect(control: NativeSession, operation: (native: NativeSession) => Promise<void>): Promise<boolean> {
    return this.lane(async () => {
      const stillOwned = (): boolean => this.control === control && !this.pendingFinalization && !control.isClosed()
      if (!stillOwned()) return false
      try {
        await operation(control)
      } catch (error) {
        if (!stillOwned()) return false
        throw error
      }
      return stillOwned()
    })
  }

  /** Close one retained native session without surrendering retry ownership. */
  async close(control: NativeSession): Promise<boolean> {
    return this.lane(async () => {
      if (this.control !== control || this.pendingFinalization) return false
      // A deliberate close must not look like an unexpected provider loss.
      // Keep the control pointer until close succeeds so a failed attempt can
      // be retried through the same retained-session endpoint.
      this.closeUnsubscribe?.()
      this.closeUnsubscribe = null
      try {
        await control.close()
      } catch (error) {
        if (!control.isClosed()) {
          this.closeUnsubscribe = control.onClose((reason) => {
            this.handleClosed(control, reason)
          })
          if (control.isClosed()) {
            this.handleClosed(control, new Error('native session closed while close retry ownership was restored'))
          }
          throw error
        }
        // The provider reported an error after completing the close. The
        // observable effect won, so do not turn a successful close into an
        // unretryable unknown state.
      }
      if (this.control === control) this.control = null
      return true
    })
  }

  /** Abort when requested, then close one retained child and release its slot once. */
  finalize(abortFirst: boolean): Promise<void> {
    if (this.pendingFinalization) return this.pendingFinalization
    const native = this.control
    if (!native) return Promise.resolve()
    const attempt = this.lane(() => this.finalizeControl(native, abortFirst))
    this.track(attempt)
    return attempt
  }

  track(finalization: Promise<void>): void {
    this.pendingFinalization = finalization
    const clear = (): void => {
      if (this.pendingFinalization === finalization) this.pendingFinalization = null
    }
    void finalization.then(clear, clear)
  }

  /**
   * Wait for every in-flight attachment, surface an already-recorded cleanup
   * failure once, then close the child. Runs as the run's disposal body.
   */
  async dispose(abortFirst: () => boolean): Promise<void> {
    await this.waitForAttachments()
    if (this.cleanupFailure !== null) {
      const failure = this.cleanupFailure
      this.cleanupFailure = null
      throw failure
    }
    await this.finalizeForDisposal(abortFirst())
  }

  async finalizeControl(native: NativeSession, abortFirst: boolean): Promise<void> {
    if (this.control !== native) return
    let abortFailure: unknown
    let closeFailure: unknown
    let closeSucceeded = false
    if (abortFirst) {
      try {
        await native.abort()
      } catch (error) {
        abortFailure = error
      }
    }
    try {
      await native.close()
      closeSucceeded = true
    } catch (error) {
      closeFailure = error
    }
    if (closeSucceeded) {
      this.closeUnsubscribe?.()
      this.closeUnsubscribe = null
      if (this.control === native) this.control = null
      if (this.unexpectedClose === native) this.unexpectedClose = null
      this.cleanupFailure = null
      return
    }
    if (abortFailure !== undefined && closeFailure !== undefined) {
      throw new AggregateError(
        [abortFailure, closeFailure],
        `run ${this.host.runId} native abort and close both failed`,
      )
    }
    throw closeFailure ?? abortFailure ?? new Error(`run ${this.host.runId} native close did not complete`)
  }

  private async finalizeForDisposal(abortFirst: boolean): Promise<void> {
    const inheritedFinalization = this.pendingFinalization
    try {
      await this.finalize(abortFirst)
    } catch (firstFailure) {
      if (this.cleanupFailure === firstFailure) {
        this.cleanupFailure = null
        throw firstFailure
      }
      // A concurrent cancellation can fail just as disposal starts. Its failed
      // ownership marker is cleared before this catch runs, so disposal gets one
      // independent close attempt instead of replaying the same rejection.
      if (!inheritedFinalization || !this.control || this.pendingFinalization) throw firstFailure
      try {
        await this.finalize(abortFirst)
      } catch (retryFailure) {
        throw new AggregateError([firstFailure, retryFailure], `run ${this.host.runId} native cleanup failed twice`)
      }
    }
  }

  private waitForAttachments(): Promise<void> {
    if (this.attachmentReservations === 0) return Promise.resolve()
    return new Promise((resolve) => this.attachmentWaiters.add(resolve))
  }

  private handleClosed(native: NativeSession, reason: Error): void {
    if (this.control !== native) return
    if (this.unexpectedClose === native) return
    this.unexpectedClose = native
    this.closeUnsubscribe?.()
    this.closeUnsubscribe = null
    const alreadyFinalizing = this.pendingFinalization !== null
    const closeObservation = this.pendingFinalization ?? Promise.resolve().then(() => native.whenClosed())
    if (!this.pendingFinalization) this.track(closeObservation)
    void closeObservation.then(
      () => {
        if (this.control === native) this.control = null
        if (this.unexpectedClose === native) this.unexpectedClose = null
        this.cleanupFailure = null
      },
      (error) => {
        this.cleanupFailure = error
        console.error(`[cli-bridge] run ${this.host.runId} native cleanup failed after close:`, error)
      },
    )
    if (alreadyFinalizing || !this.host.shouldReportLoss()) return
    this.host.reportLoss(reason)
  }
}
