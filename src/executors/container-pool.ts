/**
 * ContainerPool — fixed pool of pre-warmed Docker containers, each
 * running an idle entrypoint (`tail -f /dev/null`). Backends `acquire`
 * a slot, `docker exec` the CLI inside, and `release` when done.
 *
 * Anti-fragility layers (every one defends a real failure mode that
 * has wedged a remote box at least once):
 *
 *   1. Per-container resource caps — `--memory`, `--memory-swap`,
 *      `--cpus`. Caps blast radius if a CLI invocation runs away
 *      (e.g. claude with a pathological prompt eating all host RAM).
 *      Defaults: 4g / 2 cpus. Env: BRIDGE_POOL_MEMORY, BRIDGE_POOL_CPUS.
 *
 *   2. Bounded waiter queue — accepts at most `maxQueueDepth` queued
 *      acquires (default 4 × poolSize). Over the cap, acquire rejects
 *      immediately with `queue full` so the HTTP layer 503s instead of
 *      stacking work that will never drain. Env: BRIDGE_POOL_MAX_QUEUE.
 *
 *   3. Per-acquire deadline — a waiter that doesn't get a slot in
 *      `acquireDeadlineMs` (default 60s) rejects with `acquire timeout`.
 *      Env: BRIDGE_POOL_ACQUIRE_DEADLINE_MS.
 *
 *   4. Slot-hold watchdog — every acquired slot must release within
 *      `slotMaxHoldMs` (default 10min). If not, the slot is recycled
 *      (container `docker rm -f` + reprovision) and the holder's release
 *      becomes a no-op. Defends against a CLI inside the container that
 *      wedges forever and starves the pool from the inside.
 *      Env: BRIDGE_SLOT_MAX_HOLD_MS.
 *
 *   5. Restart-loop circuit breaker — `docker run --restart on-failure:3`
 *      so Docker stops retrying after 3 crashes (was unless-stopped =
 *      infinite). In-process, after 3 consecutive provision failures a
 *      slot is marked permanently dead and the pool shrinks gracefully.
 *
 * Sticky session routing is unchanged: when sessionId is passed, prefer
 * the slot that last served that session.
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
  /** Bind paths for the `share` mode. Each entry is `host:container`. */
  shareMounts?: string[]
  perSlotVolumePrefix?: string
  perSlotMountTarget?: string
  /**
   * Optional canonical host workspace root. It is bind-mounted read-write
   * at the identical absolute path in every slot, independently of OAuth.
   */
  workspaceRoot?: string
  /** Per-container memory cap, e.g. '4g'. Default 4g. */
  memory?: string
  /** Per-container CPU cap, e.g. '2'. Default 2. */
  cpus?: string
  /** Max queued waiters across all acquires. Default 4 × size. */
  maxQueueDepth?: number
  /** Per-acquire deadline in ms. Default 60_000. */
  acquireDeadlineMs?: number
  /** Per-slot-hold deadline in ms. Default 600_000 (10min). */
  slotMaxHoldMs?: number
  /** Consecutive provision failures that take a slot permanently out. Default 3. */
  maxConsecutiveFailures?: number
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
  /** Slot is dead (provision keeps failing). Not routed to. */
  dead: boolean
  /** Last sessionId served (for sticky routing). */
  lastSession: string | null
  /** Holder watchdog timer; cleared on release(). */
  holdTimer: NodeJS.Timeout | null
  /** Generation token — bumped on each acquire so a stale release is a no-op. */
  generation: number
  /** Consecutive provisioning failures since last success. */
  consecutiveFailures: number
}

const DEFAULTS = {
  ACQUIRE_DEADLINE_MS: 60_000,
  SLOT_MAX_HOLD_MS: 600_000,
  MAX_CONSECUTIVE_FAILURES: 3,
}

interface Waiter {
  sessionId: string | undefined
  resolve: (slot: SlotState) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class ContainerPool {
  private readonly slots: SlotState[]
  private readonly waiters: Waiter[] = []
  private readonly opts: ContainerPoolOptions
  private readonly maxQueueDepth: number
  private readonly acquireDeadlineMs: number
  private readonly slotMaxHoldMs: number
  private readonly maxConsecutiveFailures: number
  private destroyed = false

  /** Counters for /metrics. */
  private counters = {
    acquires: 0,
    queue_full_rejects: 0,
    acquire_timeouts: 0,
    slot_force_releases: 0,
    slot_reprovisions: 0,
    slots_marked_dead: 0,
  }

  private constructor(slots: SlotState[], opts: ContainerPoolOptions) {
    this.slots = slots
    this.opts = opts
    this.maxQueueDepth = opts.maxQueueDepth ?? slots.length * 4
    this.acquireDeadlineMs = opts.acquireDeadlineMs ?? DEFAULTS.ACQUIRE_DEADLINE_MS
    this.slotMaxHoldMs = opts.slotMaxHoldMs ?? DEFAULTS.SLOT_MAX_HOLD_MS
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULTS.MAX_CONSECUTIVE_FAILURES
  }

  static async create(opts: ContainerPoolOptions): Promise<ContainerPool> {
    if (opts.size < 1) throw new Error('pool size must be >= 1')
    const onProgress = opts.onProgress ?? (() => {})
    onProgress(`provisioning container pool size=${opts.size} image=${opts.image} (parallel)`)

    const slotIndices = Array.from({ length: opts.size }, (_, i) => i)
    const slots = await Promise.all(
      slotIndices.map((i) => provisionSlot(opts, i, onProgress)),
    )
    return new ContainerPool(slots, opts)
  }

  get size(): number { return this.slots.length }

  snapshot(): {
    size: number
    in_flight: number
    queued: number
    max_queue: number
    dead: number
    acquires: number
    queue_full_rejects: number
    acquire_timeouts: number
    slot_force_releases: number
    slot_reprovisions: number
    slots_marked_dead: number
  } {
    return {
      size: this.slots.length,
      in_flight: this.slots.filter((s) => s.busy).length,
      queued: this.waiters.length,
      max_queue: this.maxQueueDepth,
      dead: this.slots.filter((s) => s.dead).length,
      ...this.counters,
    }
  }

  async acquire(sessionId?: string): Promise<AcquiredSlot> {
    if (this.destroyed) throw new Error('container pool destroyed')
    this.counters.acquires += 1

    // Sticky preference: prefer a free, non-dead slot that last served
    // this session.
    if (sessionId) {
      const sticky = this.slots.find((s) => !s.busy && !s.dead && s.lastSession === sessionId)
      if (sticky) return this.markAcquired(sticky, sessionId)
    }
    const free = this.slots.find((s) => !s.busy && !s.dead)
    if (free) return this.markAcquired(free, sessionId)

    // All slots busy or dead — count alive slots so we don't queue
    // against a permanently-dead pool.
    const aliveCount = this.slots.filter((s) => !s.dead).length
    if (aliveCount === 0) {
      throw new Error(
        `container-pool: all ${this.slots.length} slots dead after repeated provisioning failures. ` +
          `Inspect docker daemon + image health, then restart the bridge.`,
      )
    }

    if (this.waiters.length >= this.maxQueueDepth) {
      this.counters.queue_full_rejects += 1
      throw new Error(
        `container-pool: queue full (depth=${this.waiters.length}/${this.maxQueueDepth}, ` +
          `in_flight=${this.slots.filter((s) => s.busy).length}/${aliveCount}). ` +
          `Reduce parallel callers or raise BRIDGE_POOL_MAX_QUEUE.`,
      )
    }

    return new Promise<AcquiredSlot>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        this.counters.acquire_timeouts += 1
        reject(
          new Error(
            `container-pool: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(in_flight=${this.slots.filter((s) => s.busy).length}/${aliveCount}, ` +
              `queued=${this.waiters.length}).`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      this.waiters.push({
        sessionId,
        resolve: (slot) => {
          clearTimeout(timer)
          resolve(this.markAcquired(slot, sessionId))
        },
        reject,
        timer,
      })
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('container pool destroyed'))
    }
    this.waiters.length = 0
    for (const s of this.slots) {
      if (s.holdTimer) clearTimeout(s.holdTimer)
    }
    await Promise.all(this.slots.map((s) => destroySlot(s.containerId)))
  }

  private markAcquired(slot: SlotState, sessionId: string | undefined): AcquiredSlot {
    slot.busy = true
    slot.generation += 1
    const generationAtAcquire = slot.generation
    if (sessionId) slot.lastSession = sessionId
    // Slot-hold watchdog: if the holder doesn't release within
    // slotMaxHoldMs, recycle the slot. The release() closure binds to
    // generationAtAcquire so a late release becomes a no-op.
    slot.holdTimer = setTimeout(() => {
      if (slot.generation !== generationAtAcquire) return
      this.counters.slot_force_releases += 1
      this.recycleSlot(slot).catch(() => {/* swallowed; counters track it */})
    }, this.slotMaxHoldMs).unref()
    return {
      containerId: slot.containerId,
      slotIndex: slot.index,
      release: () => {
        if (slot.generation !== generationAtAcquire) return // stale
        if (slot.holdTimer) { clearTimeout(slot.holdTimer); slot.holdTimer = null }
        this.releaseSlot(slot)
      },
    }
  }

  private releaseSlot(slot: SlotState): void {
    slot.busy = false
    if (this.waiters.length === 0) return
    const stickyIdx = this.waiters.findIndex((w) => w.sessionId && w.sessionId === slot.lastSession)
    const waiterIdx = stickyIdx >= 0 ? stickyIdx : 0
    const waiter = this.waiters.splice(waiterIdx, 1)[0]
    if (!waiter) return
    slot.busy = true
    slot.generation += 1
    if (waiter.sessionId) slot.lastSession = waiter.sessionId
    waiter.resolve(slot)
  }

  /**
   * Recycle a wedged slot: tear down the container, reprovision a fresh
   * one, hand the slot back to the pool. If reprovision fails too many
   * times in a row, mark the slot permanently dead so we don't burn
   * cycles routing acquires to a busted image/daemon.
   */
  private async recycleSlot(slot: SlotState): Promise<void> {
    if (slot.holdTimer) { clearTimeout(slot.holdTimer); slot.holdTimer = null }
    this.counters.slot_reprovisions += 1
    // Force-destroy the wedged container.
    await destroySlot(slot.containerId)
    try {
      const reborn = await provisionSlot(this.opts, slot.index, this.opts.onProgress ?? (() => {}))
      slot.containerId = reborn.containerId
      slot.busy = false
      slot.lastSession = null
      slot.generation += 1
      slot.consecutiveFailures = 0
      // Wake a waiter if any.
      if (this.waiters.length > 0) this.releaseSlot(slot)
    } catch (err) {
      slot.consecutiveFailures += 1
      slot.busy = false
      if (slot.consecutiveFailures >= this.maxConsecutiveFailures) {
        slot.dead = true
        this.counters.slots_marked_dead += 1
      }
      // Wake any waiter that still has work to do; they'll be routed to
      // another alive slot.
      if (this.waiters.length > 0) {
        const w = this.waiters.shift()!
        clearTimeout(w.timer)
        // Try to give them ANY alive slot; if none, reject.
        const free = this.slots.find((s) => !s.busy && !s.dead)
        if (free) {
          slot.busy = false
          this.markAcquired(free, w.sessionId).release // tickle through markAcquired
          // Re-call: just resolve with the alive slot.
          w.resolve(free)
        } else {
          w.reject(new Error(`container-pool: no alive slots after recycle (${err instanceof Error ? err.message : String(err)})`))
        }
      }
    }
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

  const args = buildContainerRunArgs(opts, index, name)

  onProgress(`[slot ${index}] docker run ${name}`)
  const r = await execFileAsync('docker', args)
  const containerId = r.stdout.trim()
  if (!containerId) {
    throw new Error(`failed to start container slot ${index}: ${r.stderr}`)
  }
  onProgress(`[slot ${index}] ready @ ${containerId.slice(0, 12)}`)
  return {
    containerId,
    index,
    busy: false,
    dead: false,
    lastSession: null,
    holdTimer: null,
    generation: 0,
    consecutiveFailures: 0,
  }
}

/** Compose `docker run` argv without invoking Docker. */
export function buildContainerRunArgs(
  opts: ContainerPoolOptions,
  index: number,
  name = `${opts.namePrefix}-${index}`,
): string[] {
  const memory = opts.memory ?? '4g'
  const cpus = opts.cpus ?? '2'
  // restart=on-failure:3 instead of unless-stopped — caps the docker-level
  // restart loop so a poisoned image can't churn the daemon forever.
  const args = [
    'run', '-d',
    '--name', name,
    '--restart', 'on-failure:3',
    '--memory', memory, '--memory-swap', memory,
    '--cpus', cpus,
  ]
  if (opts.workspaceRoot) {
    if (!isSafeWorkspaceBindPath(opts.workspaceRoot)) {
      throw new Error(`invalid Docker workspace root: ${opts.workspaceRoot}`)
    }
    // Docker bind mounts are read-write unless `readonly` is present.
    // Source and target intentionally match so request cwd needs no rewrite.
    args.push(
      '--mount',
      `type=bind,source=${opts.workspaceRoot},target=${opts.workspaceRoot}`,
    )
  }
  if (opts.oauthMode === 'share') {
    for (const m of opts.shareMounts ?? []) args.push('-v', m)
  } else {
    if (!opts.perSlotVolumePrefix || !opts.perSlotMountTarget) {
      throw new Error('per-slot oauthMode requires perSlotVolumePrefix + perSlotMountTarget')
    }
    args.push('-v', `${opts.perSlotVolumePrefix}-${index}:${opts.perSlotMountTarget}`)
  }
  args.push(opts.image, 'tail', '-f', '/dev/null')
  return args
}

function isSafeWorkspaceBindPath(path: string): boolean {
  return path.startsWith('/') && path !== '/' && !path.includes(',')
}

async function destroySlot(containerId: string): Promise<void> {
  if (!containerId) return
  await execFileAsync('docker', ['rm', '-f', containerId]).catch(() => {})
}
