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
 *   4. Optional slot-hold watchdog — when an operator configures
 *      `slotMaxHoldMs`, every acquired slot must release within it. If not, the slot is recycled
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
 *   6. Vanished-container self-healing — a slot whose container was removed
 *      or stopped outside the bridge (a host /tmp sweep, a manual
 *      `docker rm`, an OOM kill) is RECREATED on the next acquire rather
 *      than serving a dead container id for the rest of the process
 *      lifetime. Liveness is re-checked at most once per
 *      `livenessTtlMs` so the common warm path costs nothing, and the
 *      executor can force a check by reporting an exec failure. Without
 *      this, one swept container turned into a permanent `No such
 *      container` on /health that only a restart cleared — observed on a
 *      bridge that had been up ten days. Env: BRIDGE_SLOT_LIVENESS_TTL_MS.
 *
 *   7. Start-scoped setup, re-armed across restarts — see {@link
 *      ContainerPoolOptions.afterCreate}. `afterCreate` writes state into the
 *      container's KERNEL NAMESPACES, which Docker destroys and recreates on
 *      every restart, so that state belongs to a container START, not to a
 *      container. A slot is therefore never handed out until `afterCreate` has
 *      been run against the incarnation the request will actually execute in,
 *      and a pool that uses it never carries a Docker restart policy — a
 *      container revived behind the pool's back is one the pool never re-armed.
 *      Measured before this existed: a worker exited non-zero, the executor
 *      restarted its slot to kill the process tree, and the next request pulled
 *      339,598 bytes of github.com from that slot through the Docker host.
 *
 * Sticky session routing is unchanged: when sessionId is passed, prefer
 * the slot that last served that session.
 */

import { createHash } from 'node:crypto'
import { assertDockerNetworkName } from './docker-network.js'
import { dockerCli, type DockerCli } from './docker-cli.js'
import { buildCommandFor } from './docker-preflight.js'
import { ExecutorSaturatedError } from './types.js'

import { provisionSlot, destroySlot, armContainerStart, START_FORMAT } from './container-slot.js'
export { buildContainerRunArgs } from './container-slot.js'

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
  /** Keep a retained session on one credential slot across turns and restarts. */
  strictSessionAffinity?: boolean
  /** Bind paths for the `share` mode. Each entry is `host:container`. */
  shareMounts?: string[]
  /**
   * Per-slot credential volumes. Each entry becomes
   * `<volumePrefix>-<slotIndex>:<target>`, so slot N's credentials are its own.
   * A LIST, not one pair: a CLI can read credentials from more than one
   * directory (opencode keeps config in ~/.config/opencode and auth.json in
   * ~/.local/share/opencode), and mounting only the first gives every slot a
   * volume with nothing to authenticate with.
   */
  perSlotVolumes?: Array<{ volumePrefix: string; target: string }>
  /**
   * Optional canonical host workspace root. It is bind-mounted read-write
   * at the identical absolute path in every slot, independently of OAuth.
   */
  workspaceRoot?: string
  /** Existing Docker network joined by every pool container. */
  network?: string
  /** Optional numeric non-root identity, e.g. `1000:1000`. */
  containerUser?: string
  /** Writable absolute HOME for the configured container identity. */
  containerHome?: string
  /** Per-container memory cap, e.g. '4g'. Default 4g. */
  memory?: string
  /** Per-container CPU cap, e.g. '2'. Default 2. */
  cpus?: string
  /** Max queued waiters across all acquires. Default 4 × size. */
  maxQueueDepth?: number
  /** Per-acquire deadline in ms. Default 60_000. */
  acquireDeadlineMs?: number
  /** Ceiling on a request-supplied acquire deadline in ms. Default 900_000. */
  maxAcquireDeadlineMs?: number
  /** Optional operator safety cap for one slot hold. Zero disables it (default). */
  slotMaxHoldMs?: number
  /** Consecutive provision failures that take a slot permanently out. Default 3. */
  maxConsecutiveFailures?: number
  /**
   * How long a slot's container liveness is trusted before the next acquire
   * re-checks it with `docker inspect`. Default 30_000. Set 0 to check every
   * acquire (correct but adds a docker round-trip per request).
   *
   * IGNORED when {@link ContainerPoolOptions.afterCreate} is set: start-scoped
   * state cannot be cached across a window in which the container may have
   * started again. See the constructor.
   */
  livenessTtlMs?: number
  /** Injectable docker command runner. Tests replace this; production uses the real CLI. */
  cli?: DockerCli
  /**
   * Run against a slot's container after it exists and BEFORE the slot is
   * usable. The net-jail installs its egress filter here: a filter belongs to a
   * network namespace, so it cannot be set by `docker run` arguments and has to
   * be written into the namespace once the container is up.
   *
   * A rejection is fatal for that slot — the container is destroyed and the
   * slot fails to provision. That is deliberate: the alternative is a pool slot
   * serving requests with an egress policy nobody applied, which is the exact
   * shape of the leak the net-jail exists to close.
   *
   * THIS HOOK IS SCOPED TO A CONTAINER START, NOT TO A CONTAINER. Docker
   * destroys and recreates a container's network namespace on every restart, so
   * anything written into that namespace is gone the moment the container comes
   * back — and the container id, the mounts and the filesystem are all
   * unchanged, so nothing about the slot looks different afterwards. Setting
   * this therefore changes three things about the pool:
   *
   *   - the container carries NO Docker restart policy, so a dead container is
   *     replaced by `provisionSlot` (which re-runs this hook) instead of being
   *     revived in place with a fresh, empty namespace;
   *   - `livenessTtlMs` is forced to 0, because a cached "alive" answer cannot
   *     tell one incarnation from the next;
   *   - every handout compares the container's `StartedAt` against the start
   *     this hook was last run for, and re-runs it before the slot is usable.
   */
  afterCreate?: (containerId: string, index: number) => Promise<void>
  /** Optional progress hook. */
  onProgress?: (msg: string) => void
}

export interface AcquiredSlot {
  containerId: string
  slotIndex: number
  release(): void
}

export interface SlotState {
  containerId: string
  index: number
  busy: boolean
  draining?: boolean
  maintenance?: boolean
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
  /** Epoch ms of the last positive liveness observation for `containerId`. */
  lastVerifiedAt: number
  /**
   * `.State.StartedAt` of the container incarnation `afterCreate` was last run
   * against. Empty when the pool has no `afterCreate`. A slot whose container
   * reports a different value has been restarted, which means its namespaces —
   * and everything `afterCreate` wrote into them — were recreated empty.
   */
  armedStart: string
}

const DEFAULTS = {
  ACQUIRE_DEADLINE_MS: 60_000,
  MAX_ACQUIRE_DEADLINE_MS: 900_000,
  SLOT_MAX_HOLD_MS: 0,
  MAX_CONSECUTIVE_FAILURES: 3,
  LIVENESS_TTL_MS: 30_000,
}

interface Waiter {
  sessionId: string | undefined
  slotIndex?: number
  resolve: (slot: SlotState) => boolean
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  settled: boolean
}

export class ContainerPool {
  private readonly slots: SlotState[]
  private readonly waiters: Waiter[] = []
  private readonly opts: ContainerPoolOptions
  private readonly maxQueueDepth: number
  private readonly acquireDeadlineMs: number
  private readonly maxAcquireDeadlineMs: number
  private readonly slotMaxHoldMs: number
  private readonly maxConsecutiveFailures: number
  private readonly livenessTtlMs: number
  private readonly cli: DockerCli
  private destroyed = false
  private adopted = false

  /** Counters for /metrics. */
  private counters = {
    acquires: 0,
    queue_full_rejects: 0,
    acquire_timeouts: 0,
    slot_force_releases: 0,
    slot_reprovisions: 0,
    slots_marked_dead: 0,
    /** Slots recreated because their container had vanished or stopped. */
    slot_liveness_recoveries: 0,
    /** Handouts that found a restarted container and re-ran `afterCreate` first. */
    slot_rearms: 0,
    /** Re-arms that failed, so the container was replaced instead of served. */
    slot_rearm_failures: 0,
  }

  private constructor(slots: SlotState[], opts: ContainerPoolOptions) {
    this.slots = slots
    this.opts = opts
    this.maxQueueDepth = opts.maxQueueDepth ?? slots.length * 4
    this.acquireDeadlineMs = opts.acquireDeadlineMs ?? DEFAULTS.ACQUIRE_DEADLINE_MS
    this.maxAcquireDeadlineMs = opts.maxAcquireDeadlineMs ?? DEFAULTS.MAX_ACQUIRE_DEADLINE_MS
    this.slotMaxHoldMs = opts.slotMaxHoldMs ?? DEFAULTS.SLOT_MAX_HOLD_MS
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULTS.MAX_CONSECUTIVE_FAILURES
    // A pool whose slots carry start-scoped state cannot cache liveness. The TTL
    // exists to skip a `docker inspect` on a warm path, and the very thing the
    // inspect now reads — which START this container is on — is what changes
    // inside that window. A 30-second cache is 30 seconds in which a restarted
    // container is handed out with the setup its previous incarnation had.
    this.livenessTtlMs = opts.afterCreate ? 0 : (opts.livenessTtlMs ?? DEFAULTS.LIVENESS_TTL_MS)
    this.cli = opts.cli ?? dockerCli
  }

  static async create(opts: ContainerPoolOptions): Promise<ContainerPool> {
    if (opts.size < 1) throw new Error('pool size must be >= 1')
    if (opts.network !== undefined) assertDockerNetworkName(opts.network)
    const onProgress = opts.onProgress ?? (() => {})
    onProgress(`provisioning container pool size=${opts.size} image=${opts.image} (parallel)`)

    const slotIndices = Array.from({ length: opts.size }, (_, i) => i)
    const slots = await Promise.all(
      slotIndices.map((i) => provisionSlot(opts, i, onProgress)),
    )
    return new ContainerPool(slots, opts)
  }

  /** Adopt explicit idle identities without provisioning or removing any container. */
  static adopt(opts: ContainerPoolOptions, ids: string[]): ContainerPool {
    if (ids.length !== opts.size || !ids.length) throw new Error('invalid adoption size')
    const pool = new ContainerPool(ids.map((containerId, index) => ({ containerId, index,
      busy: false, draining: true, dead: false, lastSession: null, holdTimer: null,
      generation: 0, consecutiveFailures: 0, lastVerifiedAt: Date.now(), armedStart: '' })), opts)
    pool.adopted = true
    return pool
  }

  slotSnapshot() {
    return this.slots.map(({ index, containerId, busy, draining, maintenance }) =>
      ({ index, containerId, busy, draining: Boolean(draining), maintenance: Boolean(maintenance) }))
  }

  drainSlot(index: number, expectedId: string): void {
    const slot = this.slots[index]
    if (!slot || slot.containerId !== expectedId) throw new Error('slot identity changed')
    slot.draining = true
  }

  /** Exclusive maintenance reservation; never terminates an acquired lease. */
  async rollSlot(index: number, expectedId: string, image: string, replace: (id: string, arm: (id: string) => Promise<void>) => Promise<string>): Promise<string> {
    const slot = this.slots[index]
    if (!slot || slot.containerId !== expectedId || !slot.draining || slot.busy || slot.maintenance) {
      throw new Error('slot must be drained, idle and match expected identity')
    }
    slot.maintenance = true
    try {
      const id = await replace(slot.containerId, async (candidate) => {
        await armContainerStart(this.opts, candidate, index, this.cli)
      })
      this.opts.image = image
      slot.containerId = id
      slot.generation += 1
      slot.lastVerifiedAt = 0
      slot.armedStart = await armContainerStart(this.opts, id, index, this.cli)
      slot.draining = false
      this.serveWaiterWith(slot)
      return id
    } finally { slot.maintenance = false }
  }

  get size(): number { return this.slots.length }

  /**
   * Container ids of every non-dead slot. The startup preflight probes these
   * — the same containers that will serve traffic, so a passing preflight is
   * evidence about production and not about a throwaway probe container.
   */
  liveContainerIds(): string[] {
    return this.slots.filter((s) => !s.dead).map((s) => s.containerId)
  }

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
    slot_liveness_recoveries: number
    slot_rearms: number
    slot_rearm_failures: number
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

  resolveAcquireDeadlineMs(requestedDeadlineMs?: number): number {
    return requestedDeadlineMs === undefined
      ? this.acquireDeadlineMs
      : Math.max(1, Math.min(requestedDeadlineMs, this.maxAcquireDeadlineMs))
  }

  /**
   * Take a slot, waiting up to `requestedDeadlineMs` capped by the pool ceiling.
   */
  async acquire(sessionId?: string, requestedDeadlineMs?: number, signal?: AbortSignal): Promise<AcquiredSlot> {
    if (this.destroyed) throw new Error('container pool destroyed')
    signal?.throwIfAborted()
    this.counters.acquires += 1
    const deadlineMs = this.resolveAcquireDeadlineMs(requestedDeadlineMs)
    const strictSlot = this.opts.strictSessionAffinity && sessionId
      ? this.slots[createHash('sha256').update(sessionId).digest().readUInt32BE(0) % this.slots.length]
      : undefined
    if (strictSlot?.dead) throw new Error(`container-pool: retained session slot ${strictSlot.index} is dead`)
    if (strictSlot && !strictSlot.busy && !strictSlot.draining) return await this.handOut(strictSlot, sessionId, signal)

    // Sticky preference: prefer a free, non-dead slot that last served
    // this session.
    if (!strictSlot && sessionId) {
      const sticky = this.slots.find((s) => !s.busy && !s.dead && !s.draining && s.lastSession === sessionId)
      if (sticky) return await this.handOut(sticky, sessionId, signal)
    }
    const free = strictSlot ? undefined : this.slots.find((s) => !s.busy && !s.dead && !s.draining)
    if (free) return await this.handOut(free, sessionId, signal)

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
      throw new ExecutorSaturatedError(
        'container-pool',
        {
          in_flight: this.slots.filter((s) => s.busy).length,
          max: aliveCount,
          queued: this.waiters.length,
          deadline_ms: 0,
        },
        `container-pool: queue full (depth=${this.waiters.length}/${this.maxQueueDepth}, ` +
          `in_flight=${this.slots.filter((s) => s.busy).length}/${aliveCount})`,
      )
    }

    return new Promise<AcquiredSlot>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error('container-pool acquire aborted'))
      }
      const finish = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        this.counters.acquire_timeouts += 1
        waiter.reject(
          new ExecutorSaturatedError(
            'container-pool',
            {
              in_flight: this.slots.filter((s) => s.busy).length,
              max: aliveCount,
              queued: this.waiters.length,
              deadline_ms: deadlineMs,
            },
            `container-pool: acquire timeout after ${deadlineMs}ms ` +
              `(in_flight=${this.slots.filter((s) => s.busy).length}/${aliveCount}, ` +
              `queued=${this.waiters.length})`,
          ),
        )
      }, deadlineMs).unref()
      this.waiters.push({
        settled: false,
        sessionId,
        ...(strictSlot ? { slotIndex: strictSlot.index } : {}),
        resolve: (slot) => {
          if (waiter.settled) return false
          if (signal?.aborted) {
            onAbort()
            return false
          }
          waiter.settled = true
          finish()
          resolve(this.markAcquired(slot, sessionId))
          return true
        },
        reject: (error) => {
          if (waiter.settled) return
          waiter.settled = true
          finish()
          reject(error)
        },
        timer,
      })
      const waiter = this.waiters.at(-1)!
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
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
    if (!this.adopted) await Promise.all(this.slots.map((s) => destroySlot(s.containerId)))
  }

  /**
   * Report that a `docker exec` against this container failed because the
   * container is gone or stopped. Recreates the slot so the NEXT acquire — a
   * request or a /health probe — gets a working container, instead of the id
   * staying poisoned until the process restarts. Safe to call with an id the
   * pool no longer knows: unmatched ids are ignored.
   */
  async reportContainerUnusable(containerId: string): Promise<void> {
    const slot = this.slots.find((s) => s.containerId === containerId)
    if (!slot || this.destroyed) return
    this.counters.slot_liveness_recoveries += 1
    slot.lastVerifiedAt = 0
    // Busy slots are healed by their holder's release path or the hold
    // watchdog; recycling underneath an in-flight exec would swap the
    // container id out from under it.
    if (slot.busy || slot.draining) return
    await this.recycleSlot(slot)
  }

  /**
   * The current holder could not terminate its container, so the container may
   * still be running work and must not be reused. Replace it and hand the slot
   * back free. Unlike {@link reportContainerUnusable} this recycles a BUSY slot,
   * because the caller is the holder — the alternative, leaving the slot busy
   * for the hold watchdog, took a slot out of service for ten minutes over a
   * container that had merely been removed.
   */
  async recycleHeldSlot(containerId: string): Promise<void> {
    const slot = this.slots.find((s) => s.containerId === containerId)
    if (!slot || this.destroyed) return
    this.counters.slot_liveness_recoveries += 1
    await this.recycleSlot(slot)
  }

  /**
   * Reserve a free slot, prove its container is still usable, then hand it out.
   * Reservation happens BEFORE the async liveness probe so two concurrent
   * acquires cannot both be handed the same slot while one is verifying.
   */
  private async handOut(slot: SlotState, sessionId: string | undefined, signal?: AbortSignal): Promise<AcquiredSlot> {
    slot.busy = true
    try {
      await this.ensureSlotUsable(slot)
      signal?.throwIfAborted()
      if (slot.draining) throw new Error('slot drained during acquisition')
    } catch (err) {
      slot.busy = false
      this.serveWaiterWith(slot)
      throw err
    }
    slot.busy = false
    return this.markAcquired(slot, sessionId)
  }

  /**
   * The gate every handout passes: the slot's container exists, is running, and
   * — when the pool has an `afterCreate` — is on the very START that hook was
   * run for.
   *
   * Both halves recover rather than refuse. A container that is gone or stopped
   * is rebuilt. A container that RESTARTED still has the caller's filesystem and
   * mounts, so it is re-armed in place: `afterCreate` runs again against the new
   * incarnation, and only if that fails is the container replaced.
   *
   * There is no window. The restart is over by the time this runs, the only
   * thing alive in the container is its idle entrypoint, and the slot is
   * reserved (`busy`) across the whole check — so no request can be dispatched
   * into an incarnation that has not been armed. That is the property a Docker
   * event watcher could not have given: a watcher races the next `docker exec`,
   * and the loser of that race is a request running unconfined.
   *
   * Bounded by `livenessTtlMs` so a warm pool serving back-to-back requests does
   * not pay a `docker inspect` per request; a reported exec failure resets the
   * clock so the very next acquire re-checks. The TTL is forced to 0 whenever
   * `afterCreate` is set (see the constructor), because a cached answer cannot
   * tell one incarnation from the next.
   */
  private async ensureSlotUsable(slot: SlotState): Promise<void> {
    if (this.livenessTtlMs > 0 && Date.now() - slot.lastVerifiedAt < this.livenessTtlMs) return
    const state = await this.cli(['inspect', '-f', START_FORMAT, slot.containerId])
    const [running = '', startedAt = ''] = state.stdout.trim().split(/\s+/u)
    if (state.code === 0 && running === 'true') {
      if (this.opts.afterCreate && startedAt !== slot.armedStart) {
        await this.rearmSlot(slot, startedAt)
        return
      }
      slot.lastVerifiedAt = Date.now()
      return
    }
    const reason = state.code === 0 ? 'container is not running' : 'container no longer exists'
    this.counters.slot_liveness_recoveries += 1
    ;(this.opts.onProgress ?? (() => {}))(
      `[slot ${slot.index}] ${reason} (${slot.containerId.slice(0, 12)}) — recreating`,
    )
    // Reprovision WITHOUT the waiter handoff: this caller already reserved the
    // slot, so waking a queued waiter here would hand the same container to two
    // holders. The reservation is held across the whole rebuild.
    const error = await this.reprovisionSlot(slot)
    if (error) {
      throw new Error(
        `container-pool: slot ${slot.index} ${reason} and could not be recreated — ${error.message}. ` +
          `Verify the Docker daemon is up and image ${this.opts.image} still exists ` +
          `(build: ${buildCommandFor(this.opts.image)}).`,
      )
    }
  }

  /**
   * The container restarted, so run `afterCreate` against the incarnation that
   * is up now. On failure the container is REPLACED rather than handed over: a
   * slot whose setup could not be re-applied is precisely a slot running without
   * it, and serving that is the defect. The replacement path is the pool's
   * ordinary one, so it re-runs `afterCreate` too.
   */
  private async rearmSlot(slot: SlotState, observedStart: string): Promise<void> {
    this.counters.slot_rearms += 1
    ;(this.opts.onProgress ?? (() => {}))(
      `[slot ${slot.index}] container restarted (${slot.containerId.slice(0, 12)}, ` +
        `start ${slot.armedStart || 'unknown'} -> ${observedStart}) — re-running afterCreate before use`,
    )
    try {
      slot.armedStart = await armContainerStart(this.opts, slot.containerId, slot.index, this.cli)
      slot.lastVerifiedAt = Date.now()
      return
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      this.counters.slot_rearm_failures += 1
      ;(this.opts.onProgress ?? (() => {}))(
        `[slot ${slot.index}] could not re-arm the restarted container — ${cause}; replacing it`,
      )
      const error = await this.reprovisionSlot(slot)
      if (error) {
        throw new Error(
          `container-pool: slot ${slot.index} restarted, its afterCreate setup could not be re-applied ` +
            `(${cause}), and the container could not be replaced either — ${error.message}. Refusing to hand ` +
            'out a container whose per-start setup is absent.',
        )
      }
    }
  }

  private markAcquired(slot: SlotState, sessionId: string | undefined): AcquiredSlot {
    slot.busy = true
    slot.generation += 1
    const generationAtAcquire = slot.generation
    if (sessionId) slot.lastSession = sessionId
    // An operator may impose a pool safety cap independently from a caller's
    // execution deadline. With the default zero, the caller or explicit run
    // cancellation owns process lifetime.
    slot.holdTimer = this.slotMaxHoldMs > 0
      ? setTimeout(() => {
          if (slot.generation !== generationAtAcquire) return
          this.counters.slot_force_releases += 1
          this.recycleSlot(slot).catch(() => {/* swallowed; counters track it */})
        }, this.slotMaxHoldMs).unref()
      : null
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
    this.serveWaiterWith(slot)
  }

  /**
   * Hand a freed slot to the next waiter — through the SAME liveness gate as the
   * free-slot path in `acquire()`.
   *
   * This is the saturated-pool half of self-healing. Liveness used to be checked
   * only in `handOut`, which `acquire()` reaches when a slot is already free; a
   * QUEUED waiter went straight to `markAcquired` and was handed the container id
   * as-is, at any TTL including 0. So a swept container healed on an idle pool
   * and never on a busy one — the condition the pool exists for. Every waiter in
   * the queue received the same removed id in turn.
   *
   * The slot stays reserved (`busy`) across the probe so no concurrent acquire
   * can take it while it is being verified or rebuilt.
   */
  private serveWaiterWith(slot: SlotState): void {
    if (this.destroyed || slot.dead || slot.busy || slot.draining) return
    const waiter = this.takeWaiterFor(slot)
    if (!waiter) return
    slot.busy = true
    void this.ensureSlotUsable(slot).then(
      () => {
        slot.busy = false
        if (slot.draining) { this.waiters.unshift(waiter); return }
        // `waiter.resolve` runs markAcquired, which reserves the slot and bumps
        // the generation the waiter's own release() is bound to.
        if (waiter.resolve(slot)) {
          if (waiter.sessionId) slot.lastSession = waiter.sessionId
        } else {
          this.serveWaiterWith(slot)
        }
      },
      (err: Error) => {
        slot.busy = false
        if (waiter.settled) {
          this.serveWaiterWith(slot)
          return
        }
        // This slot could not be made usable. Another alive slot may still
        // serve the waiter; only when none exists does the waiter learn why.
        const alternative = waiter.slotIndex === undefined
          ? this.slots.find((s) => s !== slot && !s.busy && !s.dead && !s.draining)
          : undefined
        if (alternative) {
          this.waiters.unshift(waiter)
          this.serveWaiterWith(alternative)
          return
        }
        clearTimeout(waiter.timer)
        waiter.reject(err)
      },
    )
  }

  /** Next waiter for this slot, preferring one whose session it last served. */
  private takeWaiterFor(slot: SlotState): Waiter | undefined {
    if (this.waiters.length === 0) return undefined
    const eligible = (waiter: Waiter): boolean => waiter.slotIndex === undefined || waiter.slotIndex === slot.index
    const stickyIdx = this.waiters.findIndex((w) => eligible(w) && w.sessionId && w.sessionId === slot.lastSession)
    const firstIdx = stickyIdx >= 0 ? stickyIdx : this.waiters.findIndex(eligible)
    return firstIdx >= 0 ? this.waiters.splice(firstIdx, 1)[0] : undefined
  }

  /**
   * Recycle a wedged or vanished slot: tear down the container, reprovision a
   * fresh one, hand the slot back to the pool. Returns the reprovision error
   * instead of swallowing it — a caller that is about to hand this slot to a
   * request has to know whether it actually has a working container, and a
   * `void` return here is how a dead container id used to keep circulating.
   * After `maxConsecutiveFailures` in a row the slot is marked permanently dead
   * so acquires stop being routed to a busted image or daemon.
   */
  private async recycleSlot(slot: SlotState): Promise<Error | null> {
    const error = await this.reprovisionSlot(slot)
    slot.busy = false
    if (!error) {
      // Wake a waiter if any.
      if (this.waiters.length > 0) this.releaseSlot(slot)
      return null
    }
    // Wake any waiter that still has work to do; they'll be routed to another
    // alive slot, through the same liveness gate as every other handoff. The
    // handoff must NOT pre-acquire the slot — `waiter.resolve` runs markAcquired
    // itself (see acquire), so doing so bumped the generation twice and made the
    // waiter's own release() a no-op, leaking the slot as busy until the hold
    // watchdog fired.
    if (this.waiters.length > 0) {
      const free = this.slots.find((s) => !s.busy && !s.dead && !s.draining)
      if (free) {
        this.serveWaiterWith(free)
      } else {
        const w = this.waiters.shift()!
        clearTimeout(w.timer)
        w.reject(new Error(`container-pool: no alive slots after recycle (${error.message})`))
      }
    }
    return error
  }

  /**
   * Destroy and rebuild one slot's container. Touches container identity,
   * failure counters and the liveness clock only — never `busy` and never the
   * waiter queue, so both callers (the free-slot recycle path and the
   * reserved-slot acquire path) can layer their own ownership rules on top.
   */
  private async reprovisionSlot(slot: SlotState): Promise<Error | null> {
    if (this.adopted || slot.draining) return new Error('managed slot requires an explicit runtime roll')
    if (slot.holdTimer) { clearTimeout(slot.holdTimer); slot.holdTimer = null }
    this.counters.slot_reprovisions += 1
    await destroySlot(slot.containerId)
    try {
      const reborn = await provisionSlot(this.opts, slot.index, this.opts.onProgress ?? (() => {}))
      slot.containerId = reborn.containerId
      // The new container has its own start, and `provisionSlot` already armed
      // it. Keeping the old stamp would not be unsafe — it never matches, so
      // every handout re-arms — but it would run a sidecar per request forever
      // on a pool that is working perfectly.
      slot.armedStart = reborn.armedStart
      slot.lastSession = null
      slot.generation += 1
      slot.consecutiveFailures = 0
      slot.lastVerifiedAt = Date.now()
      return null
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      slot.consecutiveFailures += 1
      slot.lastVerifiedAt = 0
      // There is no container this stamp describes. Clearing it means the next
      // handout can only proceed by arming something, never by trusting a
      // stamp left over from a container that no longer exists.
      slot.armedStart = ''
      if (slot.consecutiveFailures >= this.maxConsecutiveFailures) {
        slot.dead = true
        this.counters.slots_marked_dead += 1
      }
      return error
    }
  }
}

