/**
 * Executor — the abstraction over "how do we spawn a CLI subprocess for
 * a chat() call?".
 *
 * Backends use a `Spawner` rather than calling node's `spawn` directly.
 * That lets us swap in a Docker-backed spawner without each backend
 * caring whether the CLI lives on the host or inside an isolated
 * container.
 *
 *   Spawner = (bin, args, opts) → ChildLike + release()
 *
 * Why async + a `release()` callback?
 *   - Docker variants ACQUIRE a pool slot before spawning. Acquisition
 *     can block waiting for a free slot; that's intrinsically async.
 *   - When the chat() call finishes, the slot must be returned to the
 *     pool. The backend doesn't know about pools, so it just calls
 *     `release()` in its `finally` block.
 *
 * Host (non-pooled) spawners are still trivially async — they wrap
 * node's sync spawn and return a no-op release.
 */

import type { ChildProcess } from 'node:child_process'

/** What the spawner produces. Compatible with node's ChildProcess. */
export type SpawnedChild = ChildProcess

export interface SpawnOpts {
  /** Working directory inside the executor's filesystem. */
  cwd?: string
  /** Env to set on the child. */
  env?: NodeJS.ProcessEnv
  /** Stdio config — defaults to ['ignore', 'pipe', 'pipe']. */
  stdio?: ['ignore' | 'pipe' | 'inherit', 'pipe' | 'inherit', 'pipe' | 'inherit']
  /** Sticky session id (Docker variant uses this to route to a warm slot). */
  sessionId?: string
}

export interface SpawnResult {
  child: SpawnedChild
  /**
   * Release the executor's resources (e.g. pool slot). MUST be called
   * exactly once when the backend's chat() call completes — success,
   * failure, or abort. The implementation is idempotent so double-call
   * is safe but unnecessary.
   */
  release(): void
}

export type Spawner = (bin: string, args: string[], opts: SpawnOpts) => Promise<SpawnResult>
