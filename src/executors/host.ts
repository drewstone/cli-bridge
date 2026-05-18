/**
 * Host spawner — node's `spawn` wrapped in a counting semaphore.
 *
 * Why the semaphore: the host executor is the default for every backend
 * that doesn't opt into a Docker pool. With no upper bound, a parallel
 * client (e.g. a benchmark harness with --parallel 16) can fork-bomb the
 * host — every `claude --print` is ~500MB-2GB resident and the host
 * OOM-thrashes until sshd itself can't allocate a new shell.
 *
 * Default cap is intentionally low: 4 concurrent host spawns. Operators
 * with beefy boxes can raise via env `BRIDGE_HOST_MAX_CONCURRENCY`. The
 * cap applies PROCESS-WIDE across all backends sharing the host spawner;
 * a single number is the right granularity because the constraint is
 * RAM on the box, not "fairness between backends."
 *
 * Bounded wait: an acquire that can't get a slot within
 * `BRIDGE_HOST_ACQUIRE_DEADLINE_MS` (default 60s) rejects with a clear
 * error rather than queueing forever. The HTTP layer turns that into a
 * 503 so the caller's retry loop sees real backpressure.
 */

import { spawn } from 'node:child_process'
import type { SpawnResult, Spawner } from './types.js'

const DEFAULT_MAX = 4
const DEFAULT_ACQUIRE_DEADLINE_MS = 60_000

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class HostSemaphore {
  private inFlight = 0
  private readonly waiters: Waiter[] = []

  constructor(
    private readonly max: number,
    private readonly acquireDeadlineMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(
          new Error(
            `host-executor: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(in_flight=${this.inFlight}/${this.max}, queued=${this.waiters.length}). ` +
              `Reduce parallel callers or raise BRIDGE_HOST_MAX_CONCURRENCY.`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      this.waiters.push({ resolve, reject, timer })
    })
    this.inFlight += 1
  }

  release(): void {
    this.inFlight -= 1
    const next = this.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve()
    }
  }

  snapshot(): { in_flight: number; max: number; queued: number } {
    return { in_flight: this.inFlight, max: this.max, queued: this.waiters.length }
  }
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const hostSemaphore = new HostSemaphore(
  readEnvInt('BRIDGE_HOST_MAX_CONCURRENCY', DEFAULT_MAX),
  readEnvInt('BRIDGE_HOST_ACQUIRE_DEADLINE_MS', DEFAULT_ACQUIRE_DEADLINE_MS),
)

export const hostSpawner: Spawner = async (bin, args, opts) => {
  await hostSemaphore.acquire()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    hostSemaphore.release()
  }
  try {
    const child = spawn(bin, args, {
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
    })
    // Release the semaphore slot when the child exits, regardless of
    // whether the backend remembered to call release(). Double-release
    // is idempotent.
    child.once('exit', release)
    child.once('error', release)
    const result: SpawnResult = {
      child,
      release,
    }
    return result
  } catch (err) {
    release()
    throw err
  }
}

/** Diagnostics for /metrics or status logging. */
export function hostExecutorSnapshot(): { in_flight: number; max: number; queued: number } {
  return hostSemaphore.snapshot()
}
