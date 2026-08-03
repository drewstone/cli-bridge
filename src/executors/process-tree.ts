/**
 * Process-tree teardown helpers.
 *
 * Why this module exists:
 *
 *   CLI harnesses we drive (`opencode run`, `claude --print`, `kimi
 *   --print`) frequently fork their OWN subprocesses — model API
 *   clients, MCP servers, tool runners. When the bridge sends
 *   SIGTERM to the harness, only the direct child gets the signal.
 *   Grand-children (ripgrep, MCP servers, the model HTTP client)
 *   keep running and either consume RAM forever or write to
 *   the now-closed stdout pipe and SIGPIPE.
 *
 *   Worse: when the watchdog SIGKILLs the bridge itself, the
 *   bridge cannot reap anything — every direct child is reparented
 *   to init (pid 1) and survives until the box reboots. Production
 *   evidence: 9+ orphan `opencode run` processes accumulated over
 *   24h with PPID=1, each holding 300–600 MB RSS.
 *
 * Strategy:
 *
 *   On every subprocess we spawn, we record the pid AND set the
 *   subprocess as the leader of its own process group (`detached:
 *   true` on Node's spawn). That gives us a pgid we can signal as a
 *   unit — `kill(-pgid, SIGTERM)` reaches every descendant the
 *   harness forked, no matter how many levels deep.
 *
 *   On client abort / timeout / chat()-finally / bridge shutdown,
 *   we call `killTree(child)`:
 *
 *     1. Send SIGTERM to the negative pgid (= whole group).
 *     2. Wait up to `gracefulMs`.
 *     3. If still alive, send SIGKILL to the negative pgid.
 *
 *   The kill-to-pgid trick only works if the child was spawned
 *   with `detached: true` (its own pgid). We force that for every
 *   host-spawned process. A Docker-backed child is only the local
 *   `docker exec` attach client, so its executor overrides termination
 *   and awaits restart of the request's exclusive container slot.
 */

import type { ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import type { SpawnResult } from './types.js'

/** Time we give a subprocess to exit gracefully before SIGKILL. */
export const DEFAULT_GRACEFUL_TERMINATION_MS = 2000

/**
 * Kill a child and every descendant it spawned. Idempotent — safe to
 * call multiple times. Returns once the child has actually exited (or
 * the grace+kill window has elapsed).
 *
 * Requires the child was spawned with `detached: true` so it owns its
 * own process group. If `child.pid` is undefined (spawn never
 * succeeded) the call is a no-op.
 */
export async function killTree(
  child: ChildProcess,
  opts: { gracefulMs?: number } = {},
): Promise<void> {
  const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_TERMINATION_MS
  const pid = child.pid
  if (pid === undefined) return

  // A direct child can exit before a helper it forked. Its ChildProcess then
  // looks terminal while the process group still owns live work. Always judge
  // both, and signal the group even after the leader has exited.
  signalOwnedTree(child, pid, 'SIGTERM')

  if (await waitForOwnedTreeGone(child, pid, gracefulMs)) return

  signalOwnedTree(child, pid, 'SIGKILL')
  if (!await waitForOwnedTreeGone(child, pid, 1_000)) {
    throw new Error(`process group ${pid} remained alive after SIGKILL`)
  }
}

const terminationBySpawn = new WeakMap<SpawnResult, Promise<void>>()

/**
 * Ask the executor to terminate the workload it owns, then wait for proof of
 * termination. A host child PID is sufficient for host executors. Docker must
 * override this because that PID belongs to the local `docker exec` client,
 * not to the command that continues running inside the container.
 */
export function terminateSpawned(spawned: SpawnResult): Promise<void> {
  const active = terminationBySpawn.get(spawned)
  if (active) return active

  // A terminal response is only true after the executor proves its workload is
  // gone. Returning success after this promise rejects can release a pool slot
  // while a child still owns credentials or keeps mutating the workspace.
  const termination = spawned.terminate?.() ?? killTree(spawned.child)
  terminationBySpawn.set(spawned, termination)
  termination.then(
    () => terminationBySpawn.delete(spawned),
    error => {
      terminationBySpawn.delete(spawned)
      console.error('[cli-bridge] termination proof failed:', error)
    },
  )
  return termination
}

/**
 * Finish one executor-owned workload, remove all request-owned files, then
 * return its capacity. A failed termination preserves both capacity and files.
 * A failed file rollback keeps that path's own lock, is retried in-process, and
 * does not strand capacity after the workload is already proven stopped.
 */
export async function finalizeSpawned(
  spawned: SpawnResult,
  cleanups: ReadonlyArray<(() => Promise<void> | void) | null | undefined> = [],
): Promise<void> {
  await terminateSpawned(spawned)
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    if (!cleanup) continue
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
      retryCleanupUntilSuccessful(cleanup)
    }
  }
  // Capacity belongs to the terminated workload, not to its files. A failed
  // rollback keeps its own path lock and is retried below, but must not strand
  // a host permit or an already-stopped Docker slot.
  try { spawned.release() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'request cleanup failed')
}

interface CleanupRetry {
  cleanup: () => Promise<void> | void
  attempts: number
  timer: NodeJS.Timeout | null
}

const cleanupRetries = new Map<() => Promise<void> | void, CleanupRetry>()
const CLEANUP_RETRY_BASE_MS = 250
const CLEANUP_RETRY_MAX_MS = 30_000

export function retryCleanupUntilSuccessful(cleanup: () => Promise<void> | void): void {
  const retry = cleanupRetries.get(cleanup) ?? { cleanup, attempts: 0, timer: null }
  cleanupRetries.set(cleanup, retry)
  if (retry.timer) return
  const delay = Math.min(CLEANUP_RETRY_BASE_MS * (2 ** retry.attempts), CLEANUP_RETRY_MAX_MS)
  retry.timer = setTimeout(() => {
    retry.timer = null
    void retryCleanup(retry)
  }, delay)
  retry.timer.unref()
}

async function retryCleanup(retry: CleanupRetry): Promise<void> {
  try {
    await retry.cleanup()
    cleanupRetries.delete(retry.cleanup)
  } catch (error) {
    retry.attempts += 1
    if (retry.attempts === 1 || retry.attempts % 8 === 0) {
      console.error('[cli-bridge] request cleanup retry still failing:', error)
    }
    retryCleanupUntilSuccessful(retry.cleanup)
  }
}

export function pendingCleanupRetries(): number {
  return cleanupRetries.size
}

/**
 * Synchronously kill the child group. Used in shutdown handlers where
 * we cannot await — best-effort, returns immediately. Pair with the
 * async killTree at the chat() finally.
 */
export function killTreeSync(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid === undefined) return
  signalOwnedTree(child, pid, signal)
}

function trySignal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig)
    return true
  } catch {
    return false
  }
}

function signalOwnedTree(child: ChildProcess, pgid: number, signal: NodeJS.Signals): void {
  const childLive = child.exitCode === null && child.signalCode === null
  if (process.platform !== 'win32' && processGroupMayExist(pgid)) {
    if (trySignal(-pgid, signal)) return
  }
  if (childLive) trySignal(pgid, signal)
}

async function waitForOwnedTreeGone(child: ChildProcess, pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (child.exitCode === null && child.signalCode === null || processGroupMayExist(pgid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return true
}

function processGroupMayExist(pgid: number): boolean {
  if (process.platform === 'linux') return processGroupHasLiveMember(pgid)
  if (process.platform === 'win32') return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processGroupHasLiveMember(pgid: number): boolean {
  let entries: string[]
  try { entries = readdirSync('/proc') } catch { return false }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const match = stat.match(/^\d+ \(.*\) ([A-Z]) \d+ (\d+)/u)
      if (match && Number(match[2]) === pgid && match[1] !== 'Z') return true
    } catch {
      // The process can disappear between /proc enumeration and stat read.
    }
  }
  return false
}
