/** Fixed Docker container pool with bounded waiting and start-state checks. */

import { assertDockerNetworkName } from './docker-network.js'
import { buildCommandFor } from './docker-preflight.js'
import { dockerCli } from './docker-cli.js'
import { ExecutorAbortedError, throwIfExecutorAborted } from './types.js'
import { armContainerStart, destroySlot, provisionSlot } from './container-pool-provision.js'
import {
  DEFAULTS,
  type AcquiredSlot,
  type ContainerPoolOptions,
  type PoolCounters,
  type PoolWaiter,
  type SlotState,
} from './container-pool-types.js'

export type { AcquiredSlot, ContainerPoolOptions, SlotState } from './container-pool-types.js'
export { buildContainerRunArgs } from './container-pool-args.js'
const START_FORMAT = '{{.State.Running}} {{.State.StartedAt}}'

export class ContainerPool {
  private readonly slots: SlotState[]
  private readonly waiters: PoolWaiter[] = []
  private readonly activeWaiters = new Set<PoolWaiter>()
  private readonly opts: ContainerPoolOptions
  private readonly maxQueueDepth: number
  private readonly acquireDeadlineMs: number
  private readonly slotMaxHoldMs: number
  private readonly maxConsecutiveFailures: number
  private readonly reprovisionBackoffMs: number
  private readonly livenessTtlMs: number
  private readonly cli
  private destroyed = false
  private readonly counters: PoolCounters = {
    acquires: 0, queue_full_rejects: 0, acquire_timeouts: 0, slot_force_releases: 0,
    slot_reprovisions: 0, slots_marked_dead: 0, slot_liveness_recoveries: 0, slot_rearms: 0, slot_rearm_failures: 0,
  }

  private constructor(slots: SlotState[], opts: ContainerPoolOptions) {
    this.slots = slots
    this.opts = opts
    this.maxQueueDepth = opts.maxQueueDepth ?? slots.length * 4
    this.acquireDeadlineMs = opts.acquireDeadlineMs ?? DEFAULTS.ACQUIRE_DEADLINE_MS
    this.slotMaxHoldMs = opts.slotMaxHoldMs ?? DEFAULTS.SLOT_MAX_HOLD_MS
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULTS.MAX_CONSECUTIVE_FAILURES
    this.reprovisionBackoffMs = opts.reprovisionBackoffMs ?? DEFAULTS.REPROVISION_BACKOFF_MS
    this.livenessTtlMs = opts.afterCreate ? 0 : (opts.livenessTtlMs ?? DEFAULTS.LIVENESS_TTL_MS)
    this.cli = opts.cli ?? dockerCli
  }

  static async create(opts: ContainerPoolOptions): Promise<ContainerPool> {
    if (opts.size < 1) throw new Error('pool size must be >= 1')
    if (!/^[a-f0-9]{64}$/u.test(opts.resourceOwner)) throw new Error('container pool resourceOwner must be a 64-character lowercase sha256')
    if (opts.network !== undefined) assertDockerNetworkName(opts.network)
    const onProgress = opts.onProgress ?? (() => {})
    onProgress(`provisioning container pool size=${opts.size} image=${opts.image} (parallel)`)
    const results = await Promise.allSettled(Array.from({ length: opts.size }, (_, index) => provisionSlot(opts, index, onProgress)))
    const slots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      const cleanup = await Promise.allSettled(slots.map(slot => destroySlot(opts, slot.containerId)))
      const cleanupFailures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length === 1 && cleanupFailures.length === 0) throw failures[0]
      const detail = [...failures, ...cleanupFailures].map(failure => failure instanceof Error ? failure.message : String(failure)).join('; ')
      throw new AggregateError([...failures, ...cleanupFailures], `container-pool: ${failures.length}/${opts.size} slots failed to provision; ${slots.length - cleanupFailures.length}/${slots.length} successful slots were removed — ${detail}`)
    }
    return new ContainerPool(slots, opts)
  }

  get size(): number { return this.slots.length }
  liveContainerIds(): Array<{ slotIndex: number; containerId: string }> {
    return this.slots.filter(slot => !slot.dead && !slot.recovering).map(slot => ({ slotIndex: slot.index, containerId: slot.containerId }))
  }
  snapshot(): { size: number; in_flight: number; queued: number; max_queue: number; dead: number; recovering: number } & PoolCounters {
    return {
      size: this.slots.length, in_flight: this.slots.filter(slot => slot.busy).length, queued: this.waiters.length,
      max_queue: this.maxQueueDepth, dead: this.slots.filter(slot => slot.dead).length,
      recovering: this.slots.filter(slot => slot.recovering).length, ...this.counters,
    }
  }

  async acquire(sessionId?: string, signal?: AbortSignal): Promise<AcquiredSlot> {
    if (this.destroyed) throw new Error('container pool destroyed')
    this.counters.acquires += 1
    throwIfExecutorAborted(signal)
    const sticky = sessionId && this.slots.find(slot => !slot.busy && !slot.dead && !slot.recovering && slot.lastSession === sessionId)
    if (sticky) return this.handOut(sticky, sessionId, signal)
    const free = this.slots.find(slot => !slot.busy && !slot.dead && !slot.recovering)
    if (free) return this.handOut(free, sessionId, signal)
    const aliveCount = this.slots.filter(slot => !slot.dead).length
    if (aliveCount === 0) throw new Error(`container-pool: all ${this.slots.length} slots dead after repeated provisioning failures. Inspect docker daemon + image health, then restart the bridge.`)
    if (this.waiters.length >= this.maxQueueDepth) {
      this.counters.queue_full_rejects += 1
      throw new Error(`container-pool: queue full (depth=${this.waiters.length}/${this.maxQueueDepth}, in_flight=${this.slots.filter(slot => slot.busy).length}/${aliveCount}). Reduce parallel callers or raise BRIDGE_POOL_MAX_QUEUE.`)
    }
    return new Promise<AcquiredSlot>((resolve, reject) => {
      let waiter: PoolWaiter
      const timer = setTimeout(() => {
        if (waiter.state === 'settled') return
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        this.counters.acquire_timeouts += 1
        this.rejectWaiter(waiter, new Error(`container-pool: acquire timeout after ${this.acquireDeadlineMs}ms (in_flight=${this.slots.filter(slot => slot.busy).length}/${aliveCount}, queued=${this.waiters.length}).`))
      }, this.acquireDeadlineMs).unref()
      waiter = { sessionId, signal, resolve, reject, timer, state: 'queued' }
      const onAbort = (): void => {
        if (waiter.state === 'settled') return
        if (waiter.state === 'queued') {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
        }
        this.rejectWaiter(waiter, new ExecutorAbortedError(signal?.reason))
      }
      waiter.onAbort = onAbort
      this.activeWaiters.add(waiter); this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    for (const waiter of this.activeWaiters) this.rejectWaiter(waiter, new Error('container pool destroyed'))
    this.waiters.length = 0
    for (const slot of this.slots) {
      if (slot.holdTimer) clearTimeout(slot.holdTimer)
      if (slot.recoveryTimer) clearTimeout(slot.recoveryTimer)
    }
    await Promise.all(this.slots.map(slot => destroySlot(this.opts, slot.containerId)))
  }

  async reportContainerUnusable(containerId: string): Promise<void> {
    const slot = this.slots.find(candidate => candidate.containerId === containerId)
    if (!slot || this.destroyed) return
    this.counters.slot_liveness_recoveries += 1; slot.lastVerifiedAt = 0
    if (slot.busy) return
    const error = await this.recycleSlot(slot)
    if (error) throw error
  }

  async recycleHeldSlot(containerId: string): Promise<void> {
    const slot = this.slots.find(candidate => candidate.containerId === containerId)
    if (!slot || this.destroyed) return
    this.counters.slot_liveness_recoveries += 1
    const error = await this.recycleSlot(slot)
    if (error) throw error
  }

  private async handOut(slot: SlotState, sessionId: string | undefined, signal?: AbortSignal): Promise<AcquiredSlot> {
    slot.busy = true
    try { await this.ensureSlotUsable(slot); throwIfExecutorAborted(signal) }
    catch (error) {
      if (!slot.dead && !slot.recovering) slot.busy = false
      if (!slot.recovering) this.serveWaiterWith(slot)
      throw error
    }
    slot.busy = false
    return this.markAcquired(slot, sessionId)
  }

  private async ensureSlotUsable(slot: SlotState): Promise<void> {
    if (this.livenessTtlMs > 0 && Date.now() - slot.lastVerifiedAt < this.livenessTtlMs) return
    const state = await this.cli(['inspect', '-f', START_FORMAT, slot.containerId])
    const [running = '', startedAt = ''] = state.stdout.trim().split(/\s+/u)
    if (state.code === 0 && running === 'true') {
      if (this.opts.afterCreate && startedAt !== slot.armedStart) { await this.rearmSlot(slot, startedAt); return }
      slot.lastVerifiedAt = Date.now(); return
    }
    const reason = state.code === 0 ? 'container is not running' : 'container no longer exists'
    this.counters.slot_liveness_recoveries += 1
    ;(this.opts.onProgress ?? (() => {}))(`[slot ${slot.index}] ${reason} (${slot.containerId.slice(0, 12)}) — recreating`)
    const error = await this.reprovisionSlot(slot)
    if (error) {
      this.quarantineSlot(slot)
      throw new Error(`container-pool: slot ${slot.index} ${reason} and could not be recreated — ${error.message}. Verify the Docker daemon is up and image ${this.opts.image} still exists (build: ${buildCommandFor(this.opts.image)}).`)
    }
  }

  private async rearmSlot(slot: SlotState, observedStart: string): Promise<void> {
    this.counters.slot_rearms += 1
    ;(this.opts.onProgress ?? (() => {}))(`[slot ${slot.index}] container restarted (${slot.containerId.slice(0, 12)}, start ${slot.armedStart || 'unknown'} -> ${observedStart}) — re-running afterCreate before use`)
    try { slot.armedStart = await armContainerStart(this.opts, slot.containerId, slot.index, this.cli); slot.lastVerifiedAt = Date.now(); return }
    catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      this.counters.slot_rearm_failures += 1
      ;(this.opts.onProgress ?? (() => {}))(`[slot ${slot.index}] could not re-arm the restarted container — ${cause}; replacing it`)
      const replacement = await this.reprovisionSlot(slot)
      if (replacement) { this.quarantineSlot(slot); throw new Error(`container-pool: slot ${slot.index} restarted, its afterCreate setup could not be re-applied (${cause}), and the container could not be replaced either — ${replacement.message}. Refusing to hand out a container whose per-start setup is absent.`) }
    }
  }

  private markAcquired(slot: SlotState, sessionId: string | undefined): AcquiredSlot {
    slot.busy = true; slot.generation += 1
    const generation = slot.generation
    if (sessionId) slot.lastSession = sessionId
    slot.holdTimer = setTimeout(() => {
      if (slot.generation !== generation) return
      this.counters.slot_force_releases += 1
      this.recycleSlot(slot).catch(() => {})
    }, this.slotMaxHoldMs).unref()
    return { containerId: slot.containerId, slotIndex: slot.index, release: () => {
      if (slot.generation !== generation) return
      if (slot.holdTimer) { clearTimeout(slot.holdTimer); slot.holdTimer = null }
      this.releaseSlot(slot)
    } }
  }

  private releaseSlot(slot: SlotState): void { slot.busy = false; this.serveWaiterWith(slot) }

  private serveWaiterWith(slot: SlotState): void {
    if (this.destroyed || slot.dead || slot.busy || slot.recovering) return
    const waiter = this.takeWaiterFor(slot)
    if (!waiter) return
    slot.busy = true
    void this.ensureSlotUsable(slot).then(() => {
      slot.busy = false
      if (waiter.state !== 'checking') { this.serveWaiterWith(slot); return }
      this.resolveWaiter(waiter, slot)
    }, (error: Error) => {
      if (!slot.dead && !slot.recovering) slot.busy = false
      if (waiter.state !== 'checking') { if (!slot.recovering) this.serveWaiterWith(slot); return }
      const alternative = this.slots.find(candidate => candidate !== slot && !candidate.busy && !candidate.dead && !candidate.recovering)
      if (alternative) { waiter.state = 'queued'; this.waiters.unshift(waiter); this.serveWaiterWith(alternative); return }
      this.rejectWaiter(waiter, error)
    })
  }

  private takeWaiterFor(slot: SlotState): PoolWaiter | undefined {
    if (this.waiters.length === 0) return undefined
    const stickyIndex = this.waiters.findIndex(waiter => waiter.sessionId && waiter.sessionId === slot.lastSession)
    const waiter = this.waiters.splice(stickyIndex >= 0 ? stickyIndex : 0, 1)[0]
    if (waiter) waiter.state = 'checking'
    return waiter
  }

  private resolveWaiter(waiter: PoolWaiter, slot: SlotState): void {
    if (waiter.state !== 'checking') return
    waiter.state = 'settled'; clearTimeout(waiter.timer); if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    this.activeWaiters.delete(waiter); waiter.resolve(this.markAcquired(slot, waiter.sessionId))
  }

  private rejectWaiter(waiter: PoolWaiter, error: Error): void {
    if (waiter.state === 'settled') return
    waiter.state = 'settled'; clearTimeout(waiter.timer); if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    this.activeWaiters.delete(waiter); waiter.reject(error)
  }

  private async recycleSlot(slot: SlotState): Promise<Error | null> {
    let error: Error | null
    try { error = await this.reprovisionSlot(slot) }
    catch (cause) { error = cause instanceof Error ? cause : new Error(String(cause)) }
    if (!error) { slot.busy = false; slot.recovering = false; if (this.waiters.length > 0) this.serveWaiterWith(slot); return null }
    this.quarantineSlot(slot)
    if (this.waiters.length > 0) {
      const free = this.slots.find(candidate => !candidate.busy && !candidate.dead && !candidate.recovering)
      if (free) this.serveWaiterWith(free)
      else if (this.slots.every(candidate => candidate.dead)) this.rejectWaiter(this.waiters.shift()!, new Error(`container-pool: no alive slots after recycle (${error.message})`))
    }
    return error
  }

  private quarantineSlot(slot: SlotState): void {
    if (slot.dead || this.destroyed) return
    slot.busy = false; slot.recovering = true
    if (slot.recoveryTimer) return
    const delay = Math.min(this.reprovisionBackoffMs * (2 ** Math.max(0, slot.consecutiveFailures - 1)), 5_000)
    slot.recoveryTimer = setTimeout(() => { slot.recoveryTimer = null; void this.retryRecoveringSlot(slot) }, delay).unref()
  }

  private async retryRecoveringSlot(slot: SlotState): Promise<void> {
    if (this.destroyed || slot.dead || !slot.recovering) return
    slot.busy = true
    const error = await this.reprovisionSlot(slot).catch(cause => cause instanceof Error ? cause : new Error(String(cause)))
    slot.busy = false
    if (!error) { slot.recovering = false; this.serveWaiterWith(slot); return }
    if (slot.dead) {
      slot.recovering = false
      const free = this.slots.find(candidate => !candidate.busy && !candidate.dead && !candidate.recovering)
      if (free) this.serveWaiterWith(free)
      if (this.slots.every(candidate => candidate.dead)) for (const waiter of [...this.waiters]) this.rejectWaiter(waiter, new Error(`container-pool: all slots dead (${error.message})`))
      return
    }
    this.quarantineSlot(slot)
  }

  private markSlotDead(slot: SlotState): void {
    if (slot.dead) return
    slot.dead = true; slot.busy = false; slot.recovering = false
    if (slot.recoveryTimer) clearTimeout(slot.recoveryTimer)
    slot.recoveryTimer = null; this.counters.slots_marked_dead += 1
  }

  private async reprovisionSlot(slot: SlotState): Promise<Error | null> {
    if (slot.holdTimer) { clearTimeout(slot.holdTimer); slot.holdTimer = null }
    this.counters.slot_reprovisions += 1
    try {
      await destroySlot(this.opts, slot.containerId)
      const reborn = await provisionSlot(this.opts, slot.index, this.opts.onProgress ?? (() => {}))
      slot.containerId = reborn.containerId; slot.armedStart = reborn.armedStart; slot.lastSession = null; slot.generation += 1
      slot.consecutiveFailures = 0; slot.dead = false; slot.recovering = false; slot.lastVerifiedAt = Date.now()
      return null
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      slot.consecutiveFailures += 1; slot.lastVerifiedAt = 0; slot.armedStart = ''
      if (slot.consecutiveFailures >= this.maxConsecutiveFailures) this.markSlotDead(slot)
      return error
    }
  }
}
