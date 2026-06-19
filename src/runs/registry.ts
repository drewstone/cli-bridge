/**
 * Durable run registry — decouples a CLI job from any one client
 * connection, mirroring the @tangle-network/sandbox SessionGateway
 * primitive (per-session monotonic `seq`, replay by `lastEventId`,
 * idempotent dispatch by run id).
 *
 * The flaw this fixes: today a mere client disconnect aborts the route's
 * AbortController, which the backend contract interprets as "kill the
 * subprocess" — 30 min of work destroyed by a transport blip or the
 * client's own retry. Here, a `Run` owns the subprocess lifecycle
 * INDEPENDENTLY of any HTTP request:
 *
 *   - The backend stream is consumed by the registry ONCE, into a
 *     server-side buffer where every delta gets a monotonic `seq`.
 *   - Any number of clients attach/detach freely. A drop costs nothing.
 *   - On reconnect with `Last-Event-ID: <seq>`, the client replays the
 *     missed deltas from the buffer, then tails live — no cold restart.
 *   - A retry that reuses the same run id RE-ATTACHES to the same live
 *     run (idempotent dispatch) instead of spawning a second subprocess.
 *   - The job is killed ONLY on an explicit cancel — never on socket
 *     close (Pillar 1 + Pillar 4 of the resilience plan).
 *
 * Buffering is in-memory and per-run. A run is reaped a bounded time
 * after it finishes (so a reconnecting client can still drain the tail),
 * or immediately on explicit cancel.
 */

import type { ChatDelta } from '../backends/types.js'

/** A buffered delta plus its per-run monotonic sequence number. */
export interface SeqDelta {
  seq: number
  delta: ChatDelta
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface RunSnapshot {
  id: string
  status: RunStatus
  /** Highest seq emitted so far. 0 = nothing buffered yet. */
  lastSeq: number
  startedAt: number
  endedAt: number | null
}

interface Waiter {
  resolve: () => void
}

/**
 * A single durable run. Owns the subprocess (via `abort`), buffers every
 * delta with a monotonic seq, and fans out to any number of attached
 * readers via a seq cursor.
 */
export class Run {
  readonly id: string
  readonly startedAt = Date.now()
  private readonly buffer: SeqDelta[] = []
  private seq = 0
  private status: RunStatus = 'running'
  private endedAt: number | null = null
  private readonly waiters = new Set<Waiter>()
  private reapTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set when the registry reaps this run and clears the buffer. A reader
   * that is still attached at reap time must terminate rather than wait
   * forever for deltas that no longer exist.
   */
  private disposed = false

  /** Aborts the OWNED job (subprocess). Distinct from any socket signal. */
  private readonly ac = new AbortController()
  /** Fires when the job is finished (any terminal status). */
  private settled?: Promise<void>

  /**
   * A typed error thrown at DISPATCH time — before the backend emitted a
   * single delta (seq 0). E.g. `ModeNotSupportedError`, or a `BackendError`
   * from spawn/config. These are request rejections, not mid-stream
   * failures: the fresh dispatcher surfaces them as a real HTTP status
   * (501/502/…) instead of a 200 with a buffered error delta. A re-attaching
   * client (run already known) reads the buffered terminal error instead.
   */
  private setupError: unknown

  constructor(
    id: string,
    private readonly onReap: (id: string) => void,
    private readonly reapDelayMs: number,
  ) {
    this.id = id
  }

  /** The signal a backend's `chat()` consumes — aborted only on cancel. */
  get signal(): AbortSignal {
    return this.ac.signal
  }

  snapshot(): RunSnapshot {
    return {
      id: this.id,
      status: this.status,
      lastSeq: this.seq,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }

  isTerminal(): boolean {
    return this.status !== 'running'
  }

  /**
   * The dispatch-time typed error (see `setupError`), or undefined. Only
   * ever set when the backend failed before emitting any delta. A fresh
   * dispatcher awaits the run settling, then consults this to choose
   * between a proper HTTP error and a normal streamed response.
   */
  dispatchError(): unknown {
    return this.setupError
  }

  /**
   * Resolves once the run has either emitted its first delta or reached a
   * terminal status. Lets the fresh dispatcher decide whether dispatch
   * failed (setup error, seq still 0 + terminal) WITHOUT waiting for a
   * healthy long-running job to complete — it returns the moment real
   * output starts flowing.
   */
  async whenStarted(): Promise<void> {
    while (this.seq === 0 && !this.isTerminal() && !this.disposed) {
      await this.waitForChange()
    }
  }

  /**
   * Drive the backend stream into the buffer, exactly once. The run keeps
   * pulling deltas even with zero attached clients — that IS the
   * decoupling. Marks terminal status when the source completes, errors,
   * or is cancelled, then schedules reaping.
   */
  pump(source: AsyncIterable<ChatDelta>): Promise<void> {
    if (this.settled) return this.settled
    this.settled = (async () => {
      try {
        for await (const delta of source) {
          this.append(delta)
        }
        // A backend that yields no terminal finish_reason still ended the
        // stream — record completion so readers stop tailing.
        this.finish('done')
      } catch (err) {
        // Cancel surfaces here as an aborted stream; classify it as such.
        if (this.ac.signal.aborted) {
          this.finish('cancelled')
        } else {
          // A typed error before any delta (seq 0) is a dispatch-time
          // rejection — record it so the fresh dispatcher can return the
          // right HTTP status. The error delta still lands in the buffer so
          // re-attaching readers see a terminal frame.
          if (this.seq === 0) this.setupError = err
          this.append({ finish_reason: 'error' })
          this.finish('error')
          console.error(`[cli-bridge] run ${this.id} failed:`, err)
        }
      }
    })()
    return this.settled
  }

  private append(delta: ChatDelta): void {
    this.seq += 1
    this.buffer.push({ seq: this.seq, delta })
    this.wakeAll()
  }

  private finish(status: RunStatus): void {
    if (this.status !== 'running') return
    this.status = status
    this.endedAt = Date.now()
    this.wakeAll()
    // Keep the buffer around briefly so a reconnecting client can still
    // drain the tail (and the final finish_reason). Cancelled runs are
    // reaped on the same delay — the client asked for them gone, but a
    // racing reader may still want the cancellation notice.
    this.scheduleReap()
  }

  private scheduleReap(): void {
    if (this.reapTimer) return
    this.reapTimer = setTimeout(() => this.onReap(this.id), this.reapDelayMs)
    this.reapTimer.unref?.()
  }

  /**
   * Explicit cancel — the ONLY path that kills the subprocess. Aborts the
   * owned controller, which the backend's `chat()` honors via its
   * `signal.addEventListener('abort', killTree)` wiring.
   */
  cancel(): void {
    if (this.status !== 'running') return
    this.ac.abort()
    // pump() observes the aborted signal and records 'cancelled'.
  }

  /** Drop all buffered deltas + timers. Called by the registry on reap. */
  dispose(): void {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer)
      this.reapTimer = null
    }
    this.disposed = true
    this.buffer.length = 0
    this.wakeAll()
  }

  private wakeAll(): void {
    for (const w of this.waiters) w.resolve()
    this.waiters.clear()
  }

  private waitForChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve }
      this.waiters.add(waiter)
    })
  }

  /**
   * Attach a reader. Replays every buffered delta with `seq > afterSeq`
   * (0 = from the start), then tails live deltas until the run reaches a
   * terminal status and the buffer is drained.
   *
   * `afterSeq` is the client's `Last-Event-ID`: a reconnecting client
   * passes the last seq it saw and gets EXACTLY the deltas it missed —
   * no gap, no duplicate, no cold restart.
   */
  async *attach(afterSeq = 0): AsyncGenerator<SeqDelta> {
    let cursor = afterSeq
    while (true) {
      // The buffer is append-only with contiguous seqs starting at 1, so
      // the first un-yielded delta lives at index `cursor` (seq N is at
      // index N-1). Slicing from there keeps tailing linear in deltas
      // produced rather than re-scanning the whole buffer on every wake —
      // a 30-min run emits thousands of deltas, and O(n²) there would
      // dominate the run.
      for (let i = cursor; i < this.buffer.length; i++) {
        const item = this.buffer[i]
        if (!item) break
        cursor = item.seq
        yield item
      }
      if (this.isTerminal() && cursor >= this.seq) return
      // The run was reaped while we were still attached: the buffer is
      // gone and no further deltas will ever arrive. Stop rather than
      // wait on a wake that will never come.
      if (this.disposed) return
      await this.waitForChange()
    }
  }
}

export interface RunRegistryOptions {
  /**
   * How long a finished run's buffer survives so a reconnecting client
   * can drain the tail. Default 60s.
   */
  reapDelayMs?: number
}

/**
 * Process-wide registry of durable runs, keyed by run id. Idempotent:
 * `getOrCreate` returns the live run for a known id (retry re-attaches)
 * and only invokes the factory for a genuinely new id.
 */
export class RunRegistry {
  private readonly runs = new Map<string, Run>()
  private readonly reapDelayMs: number

  constructor(opts: RunRegistryOptions = {}) {
    this.reapDelayMs = opts.reapDelayMs ?? 60_000
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /**
   * Idempotent dispatch. If `id` names a known run, return it WITHOUT
   * calling `start` — a retry re-attaches to the same subprocess. For a
   * new id, create the run, hand it to `start` (which wires the backend
   * source and begins pumping), and register it.
   *
   * `start` receives the run so it can read `run.signal` for the backend
   * call and call `run.pump(source)`.
   */
  getOrCreate(id: string, start: (run: Run) => void): Run {
    const existing = this.runs.get(id)
    if (existing) return existing
    const run = new Run(id, (rid) => this.reap(rid), this.reapDelayMs)
    this.runs.set(id, run)
    start(run)
    return run
  }

  /** Explicit cancel by id. Returns true if a live run was cancelled. */
  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.isTerminal()) return false
    run.cancel()
    return true
  }

  private reap(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    this.runs.delete(id)
    run.dispose()
  }

  /** Test/shutdown aid — cancel + drop every run. */
  clear(): void {
    for (const run of this.runs.values()) {
      run.cancel()
      run.dispose()
    }
    this.runs.clear()
  }
}
