/**
 * ContainerPool — fixed pool of pre-warmed Docker containers, each
 * running an idle entrypoint (`tail -f /dev/null`). Backends `acquire`
 * a slot, `docker exec` the CLI inside, and `release` when done.
 *
 * Sticky session routing: when the caller passes a sessionId, we try
 * to hand out the same container that served the previous call for
 * that session. That keeps:
 *   - Claude Code's `--resume <internalId>` reading the same on-disk
 *     transcript across calls.
 *   - File-based scratch (CLI's tmp, .opencode/state, etc.) consistent
 *     turn-to-turn.
 *
 * Sticky is best-effort — if the preferred slot is busy we fall back
 * to any free slot. Backends that need strict pinning should drive
 * their own pool partitioning.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ContainerPoolOptions {
  /** Number of containers in the pool. */
  size: number
  /** Image to run, e.g. 'cli-bridge-cli-runtime:latest'. */
  image: string
  /** Container name prefix; slots are `<prefix>-<i>`. */
  namePrefix: string
  /**
   * Volume mounts. Either:
   *   - 'share'    — all slots mount the same host paths (oauth shared).
   *   - 'per-slot' — each slot gets its own named docker volume so OAuth
   *                  state is isolated per slot. Better parallelism;
   *                  requires re-`claude /login` per slot on first run.
   */
  oauthMode: 'share' | 'per-slot'
  /**
   * Bind paths for the `share` mode. Each entry is `host:container`.
   * For Claude Code: `~/.claude:/root/.claude`.
   */
  shareMounts?: string[]
  /**
   * Per-slot volume name prefix. Slot i gets `<prefix>-<i>`. The volume
   * mount target is fixed; pass it as `mountTarget`.
   */
  perSlotVolumePrefix?: string
  perSlotMountTarget?: string
  /** Optional progress hook. */
  onProgress?: (msg: string) => void
}

export interface AcquiredSlot {
  containerId: string
  slotIndex: number
  release(): void
}

interface SlotState {
  containerId: string
  index: number
  busy: boolean
  /** Last sessionId served (for sticky routing). */
  lastSession: string | null
}

export class ContainerPool {
  private readonly slots: SlotState[]
  private readonly waiters: Array<{
    sessionId: string | undefined
    resolve: (slot: SlotState) => void
  }> = []
  private destroyed = false

  private constructor(slots: SlotState[]) {
    this.slots = slots
  }

  static async create(opts: ContainerPoolOptions): Promise<ContainerPool> {
    if (opts.size < 1) throw new Error('pool size must be >= 1')
    const onProgress = opts.onProgress ?? (() => {})
    onProgress(`provisioning container pool size=${opts.size} image=${opts.image} (parallel)`)

    const slotIndices = Array.from({ length: opts.size }, (_, i) => i)
    const slots = await Promise.all(
      slotIndices.map((i) => provisionSlot(opts, i, onProgress)),
    )
    return new ContainerPool(slots)
  }

  get size(): number { return this.slots.length }

  async acquire(sessionId?: string): Promise<AcquiredSlot> {
    if (this.destroyed) throw new Error('container pool destroyed')

    // Sticky preference: if any free slot served the same session id
    // before, prefer it.
    if (sessionId) {
      const sticky = this.slots.find((s) => !s.busy && s.lastSession === sessionId)
      if (sticky) return this.markAcquired(sticky, sessionId)
    }
    const free = this.slots.find((s) => !s.busy)
    if (free) return this.markAcquired(free, sessionId)

    // No free slot — queue.
    return new Promise<AcquiredSlot>((resolve) => {
      this.waiters.push({
        sessionId,
        resolve: (slot) => resolve(this.markAcquired(slot, sessionId)),
      })
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    for (const w of this.waiters) {
      // Reject by handing them an "expired" slot stub.
      try {
        w.resolve({
          containerId: '',
          index: -1,
          busy: false,
          lastSession: null,
        })
      } catch {}
    }
    this.waiters.length = 0
    await Promise.all(this.slots.map((s) => destroySlot(s.containerId)))
  }

  private markAcquired(slot: SlotState, sessionId: string | undefined): AcquiredSlot {
    slot.busy = true
    if (sessionId) slot.lastSession = sessionId
    return {
      containerId: slot.containerId,
      slotIndex: slot.index,
      release: () => this.releaseSlot(slot),
    }
  }

  private releaseSlot(slot: SlotState): void {
    slot.busy = false
    if (this.waiters.length === 0) return
    // Sticky-first dequeue: if any waiter prefers a session id this slot
    // recently served, give the slot to that waiter. Otherwise FIFO.
    const stickyIdx = this.waiters.findIndex((w) => w.sessionId && w.sessionId === slot.lastSession)
    const waiterIdx = stickyIdx >= 0 ? stickyIdx : 0
    const waiter = this.waiters.splice(waiterIdx, 1)[0]
    if (!waiter) return
    slot.busy = true
    if (waiter.sessionId) slot.lastSession = waiter.sessionId
    waiter.resolve(slot)
  }
}

async function provisionSlot(
  opts: ContainerPoolOptions,
  index: number,
  onProgress: (m: string) => void,
): Promise<SlotState> {
  const name = `${opts.namePrefix}-${index}`
  // Tear down any stale container with the same name (idempotent).
  await execFileAsync('docker', ['rm', '-f', name]).catch(() => {})

  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped']
  if (opts.oauthMode === 'share') {
    for (const m of opts.shareMounts ?? []) {
      args.push('-v', m)
    }
  } else {
    if (!opts.perSlotVolumePrefix || !opts.perSlotMountTarget) {
      throw new Error('per-slot oauthMode requires perSlotVolumePrefix + perSlotMountTarget')
    }
    args.push('-v', `${opts.perSlotVolumePrefix}-${index}:${opts.perSlotMountTarget}`)
  }
  args.push(opts.image, 'tail', '-f', '/dev/null')

  onProgress(`[slot ${index}] docker run ${name}`)
  const r = await execFileAsync('docker', args)
  const containerId = r.stdout.trim()
  if (!containerId) {
    throw new Error(`failed to start container slot ${index}: ${r.stderr}`)
  }
  onProgress(`[slot ${index}] ready @ ${containerId.slice(0, 12)}`)
  return { containerId, index, busy: false, lastSession: null }
}

async function destroySlot(containerId: string): Promise<void> {
  if (!containerId) return
  await execFileAsync('docker', ['rm', '-f', containerId]).catch(() => {})
}
