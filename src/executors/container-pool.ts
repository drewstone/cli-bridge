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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertDockerNetworkName } from './docker-network.js'
import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'
import { buildCommandFor, isInside } from './docker-preflight.js'

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
  SLOT_MAX_HOLD_MS: 0,
  MAX_CONSECUTIVE_FAILURES: 3,
  LIVENESS_TTL_MS: 30_000,
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
  private readonly livenessTtlMs: number
  private readonly cli: DockerCli
  private destroyed = false

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

  async acquire(sessionId?: string): Promise<AcquiredSlot> {
    if (this.destroyed) throw new Error('container pool destroyed')
    this.counters.acquires += 1

    // Sticky preference: prefer a free, non-dead slot that last served
    // this session.
    if (sessionId) {
      const sticky = this.slots.find((s) => !s.busy && !s.dead && s.lastSession === sessionId)
      if (sticky) return await this.handOut(sticky, sessionId)
    }
    const free = this.slots.find((s) => !s.busy && !s.dead)
    if (free) return await this.handOut(free, sessionId)

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
    if (slot.busy) return
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
  private async handOut(slot: SlotState, sessionId: string | undefined): Promise<AcquiredSlot> {
    slot.busy = true
    try {
      await this.ensureSlotUsable(slot)
    } catch (err) {
      slot.busy = false
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
    if (this.destroyed || slot.dead || slot.busy) return
    const waiter = this.takeWaiterFor(slot)
    if (!waiter) return
    slot.busy = true
    void this.ensureSlotUsable(slot).then(
      () => {
        slot.busy = false
        if (waiter.sessionId) slot.lastSession = waiter.sessionId
        // `waiter.resolve` runs markAcquired, which reserves the slot and bumps
        // the generation the waiter's own release() is bound to.
        waiter.resolve(slot)
      },
      (err: Error) => {
        slot.busy = false
        // This slot could not be made usable. Another alive slot may still
        // serve the waiter; only when none exists does the waiter learn why.
        const alternative = this.slots.find((s) => s !== slot && !s.busy && !s.dead)
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
    const stickyIdx = this.waiters.findIndex((w) => w.sessionId && w.sessionId === slot.lastSession)
    return this.waiters.splice(stickyIdx >= 0 ? stickyIdx : 0, 1)[0]
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
      const free = this.slots.find((s) => !s.busy && !s.dead)
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
  const cli = opts.cli ?? dockerCli
  const r = await cli(args, { timeoutMs: 120_000 })
  const containerId = r.stdout.trim()
  if (r.code !== 0 || !containerId) {
    // A missing image is the single most common cause and Docker reports it as
    // a registry/pull problem. Name the image and the build command so this
    // never again surfaces later as a message about a missing CONTAINER.
    const stderr = r.stderr.trim() || r.spawnError || `docker exited ${r.code}`
    const missingImage = /No such image|pull access denied|manifest unknown|not found: manifest|Unable to find image/i.test(stderr)
    throw new Error(
      missingImage
        ? `container-pool: cannot create slot ${index} — image ${opts.image} is not available on this host. ` +
          `Build it: ${buildCommandFor(opts.image)}. (docker: ${firstLine(stderr)})`
        : `container-pool: cannot create slot ${index} — ${firstLine(stderr)}`,
    )
  }
  // Before anything else touches the container, including this bridge's own
  // `docker exec`: the window between `run` and the filter being in place is
  // the only moment a slot has unrestricted egress, and the only thing running
  // in it is the idle `tail -f /dev/null` entrypoint.
  let armedStart = ''
  if (opts.afterCreate) {
    try {
      armedStart = await armContainerStart(opts, containerId, index, cli)
    } catch (error) {
      await cli(['rm', '-f', containerId], { timeoutMs: 30_000 })
      throw error instanceof Error
        ? new Error(`container-pool: slot ${index} was destroyed unused — ${error.message}`, { cause: error })
        : error
    }
  }
  await normalizeContainerHome(opts, containerId, cli)
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
    lastVerifiedAt: Date.now(),
    armedStart,
  }
}

/** Fields that identify one container INCARNATION, in one `docker inspect`. */
const START_FORMAT = '{{.State.Running}} {{.State.StartedAt}}'

/** How many times arming may lose a race with a concurrent restart before it fails. */
const ARM_ATTEMPTS = 3

/**
 * Run `afterCreate` and return the container start it applies to.
 *
 * The start is read BEFORE and AFTER the hook, and the two must match. Reading
 * it only afterwards would record the wrong thing in the one case that matters:
 * a container that restarted DURING the hook would be stamped with the new
 * start while the hook's work went into the namespace that is already gone —
 * a slot that looks armed and is not. Losing the race repeatedly is reported as
 * a failure rather than retried forever, because a container restarting that
 * often is not a container to hand a request.
 */
async function armContainerStart(
  opts: ContainerPoolOptions,
  containerId: string,
  index: number,
  cli: DockerCli,
): Promise<string> {
  const afterCreate = opts.afterCreate
  if (!afterCreate) return ''
  let lastSeen = ''
  for (let attempt = 0; attempt < ARM_ATTEMPTS; attempt++) {
    const before = await readContainerStart(cli, containerId)
    await afterCreate(containerId, index)
    const after = await readContainerStart(cli, containerId)
    if (after === before) return after
    lastSeen = after
  }
  throw new Error(
    `container-pool: slot ${index} restarted during afterCreate ${ARM_ATTEMPTS} times in a row ` +
      `(last observed start ${lastSeen}); its per-start setup cannot be established`,
  )
}

/** `.State.StartedAt` of a running container; throws if it is not running. */
async function readContainerStart(cli: DockerCli, containerId: string): Promise<string> {
  const result = await cli(['inspect', '-f', START_FORMAT, containerId], { timeoutMs: 30_000 })
  const [running = '', startedAt = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || running !== 'true' || !startedAt) {
    const detail = result.stderr.trim() || result.stdout.trim() || `docker exited ${result.code}`
    throw new Error(`container ${containerId.slice(0, 12)} is not running — ${firstLine(detail)}`)
  }
  return startedAt
}

/**
 * Make a configured non-root HOME actually usable, as root inside the container.
 *
 * Docker creates the missing PARENTS of a bind mount as root:root. Mount
 * credentials at `$HOME/.local/share/opencode` in an image that has no
 * `$HOME/.local`, and Docker creates `$HOME/.local` and `$HOME/.local/share`
 * owned by root — after which the uid-1000 CLI cannot create
 * `$HOME/.local/state` and dies with `EACCES: permission denied, mkdir
 * '/home/node/.local/state'`, an error that names a path nobody configured.
 * Reproduced exactly on this host before this fix existed.
 *
 * So: create the XDG directories a CLI initializes and give the configured
 * identity the ancestor chain of every mount target. Ownership is applied
 * per-directory and never recursively, because a recursive chown would walk
 * INTO the bind mounts and rewrite ownership of the operator's host files.
 */
async function normalizeContainerHome(
  opts: ContainerPoolOptions,
  containerId: string,
  cli: DockerCli,
): Promise<void> {
  if (!opts.containerUser || !opts.containerHome) return
  const home = opts.containerHome
  const mountTargets = collectMountTargets(opts)
  const chainDirs = new Set<string>([home])
  for (const rel of ['.local', '.local/state', '.local/share', '.config', '.cache']) {
    chainDirs.add(posixJoin(home, rel))
  }
  for (const target of mountTargets) {
    if (!isInside(home, target) || target === home) continue
    // Every ancestor strictly between $HOME and the mount target, plus $HOME.
    let cursor = posixDirname(target)
    while (cursor.length >= home.length && isInside(home, cursor)) {
      chainDirs.add(cursor)
      if (cursor === home) break
      cursor = posixDirname(cursor)
    }
  }
  // Mount targets themselves are owned by whatever the host/volume provides;
  // chowning them would mutate host files.
  for (const target of mountTargets) chainDirs.delete(target)

  const quoted = [...chainDirs].map(shellQuote).join(' ')
  const script = `set -e; mkdir -p ${quoted}; chown ${opts.containerUser} ${quoted}`
  const result = await cli(containerShell(containerId, script, true), { timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(
      `container-pool: cannot prepare HOME=${home} for ${opts.containerUser} inside ${opts.image} — ` +
        `${firstLine(result.stderr) || `exit ${result.code}`}. Without a writable HOME the CLI fails at ` +
        `request time with EACCES on a path you never configured.`,
    )
  }
}

function collectMountTargets(opts: ContainerPoolOptions): string[] {
  const targets: string[] = []
  if (opts.oauthMode === 'share') {
    for (const m of opts.shareMounts ?? []) {
      const target = m.slice(m.indexOf(':') + 1)
      if (target.startsWith('/')) targets.push(target)
    }
  } else {
    for (const v of opts.perSlotVolumes ?? []) targets.push(v.target)
  }
  if (opts.workspaceRoot) targets.push(opts.workspaceRoot)
  return targets
}

/** Container paths are POSIX regardless of the host platform, so do not use node:path. */
function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function posixJoin(base: string, rel: string): string {
  return `${base.replace(/\/+$/u, '')}/${rel}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/** Compose `docker run` argv without invoking Docker. */
export function buildContainerRunArgs(
  opts: ContainerPoolOptions,
  index: number,
  name = `${opts.namePrefix}-${index}`,
): string[] {
  const memory = opts.memory ?? '4g'
  const cpus = opts.cpus ?? '2'
  const args = [
    'run', '-d',
    '--name', name,
    '--restart', restartPolicyFor(opts),
    '--memory', memory, '--memory-swap', memory,
    '--cpus', cpus,
  ]
  if (opts.network !== undefined) {
    args.push('--network', assertDockerNetworkName(opts.network))
  }
  if (Boolean(opts.containerUser) !== Boolean(opts.containerHome)) {
    throw new Error('container user and home must be configured together')
  }
  if (opts.containerUser && opts.containerHome) {
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(opts.containerUser)) {
      throw new Error('invalid non-root container user')
    }
    if (!isSafeWorkspaceBindPath(opts.containerHome)) {
      throw new Error('invalid non-root container home')
    }
    args.push('--user', opts.containerUser, '--env', `HOME=${opts.containerHome}`)
  }
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
    if (!opts.perSlotVolumes || opts.perSlotVolumes.length === 0) {
      throw new Error('per-slot oauthMode requires at least one perSlotVolumes entry')
    }
    for (const v of opts.perSlotVolumes) args.push('-v', `${v.volumePrefix}-${index}:${v.target}`)
  }
  args.push(opts.image, 'tail', '-f', '/dev/null')
  return args
}

/**
 * The Docker restart policy a slot runs under.
 *
 * Without `afterCreate`, `on-failure:3` instead of `unless-stopped` — it caps
 * the docker-level restart loop so a poisoned image can't churn the daemon
 * forever, and reviving the container in place is a strictly cheaper recovery
 * than rebuilding it.
 *
 * WITH `afterCreate`, none at all. A restart policy revives a container with
 * fresh, empty namespaces — the setup the hook wrote is gone, the container id
 * and every mount are unchanged, and the revival happens with nothing in this
 * process observing it. The pool already models a dead slot correctly (`rm -f`
 * then `provisionSlot`, which re-runs the hook), so the honest configuration is
 * for a dead jailed container to be REPLACED, never revived. `tail -f /dev/null`
 * is the entrypoint, so a slot only dies when something killed it, which is a
 * container to discard rather than to bring back.
 *
 * This is one half of the invariant; the other is `ensureSlotUsable`, which
 * covers the restarts this bridge performs ITSELF — `terminateDockerExecution`
 * restarts a slot to kill a worker's process tree whenever the worker exits
 * non-cleanly, which a worker triggers simply by exiting non-zero. Removing the
 * policy without that gate would have closed the smaller of the two doors.
 */
function restartPolicyFor(opts: ContainerPoolOptions): string {
  return opts.afterCreate ? 'no' : 'on-failure:3'
}

function isSafeWorkspaceBindPath(path: string): boolean {
  return path.startsWith('/') && path !== '/' && !path.includes(',')
}

async function destroySlot(containerId: string): Promise<void> {
  if (!containerId) return
  await execFileAsync('docker', ['rm', '-f', containerId]).catch(() => {})
}
