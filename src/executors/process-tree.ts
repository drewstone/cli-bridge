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
 *   host-spawned process. For docker-pooled spawns the equivalent
 *   is `docker stop <container>`, but harness sub-trees there are
 *   confined by the container so they cannot escape — no separate
 *   tree-kill needed inside the container.
 */

import type { ChildProcess } from 'node:child_process'

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
  if (child.exitCode !== null || child.signalCode !== null) return

  // Send SIGTERM to the negative pgid. Node's `process.kill(-pid, sig)`
  // dispatches the signal to every process in the group. We try the
  // group first; if it errors (ESRCH = no such group, EPERM = not the
  // leader) fall back to the direct child.
  trySignal(-pid, 'SIGTERM') || trySignal(pid, 'SIGTERM')

  // Wait for exit OR grace period. Whichever comes first.
  await waitForExitOrTimeout(child, gracefulMs)

  if (child.exitCode === null && child.signalCode === null) {
    trySignal(-pid, 'SIGKILL') || trySignal(pid, 'SIGKILL')
    // SIGKILL is uncatchable — process dies on the next scheduler tick.
    // Wait briefly so child.exitCode is populated before we return.
    await waitForExitOrTimeout(child, 500)
  }
}

/**
 * Synchronously kill the child group. Used in shutdown handlers where
 * we cannot await — best-effort, returns immediately. Pair with the
 * async killTree at the chat() finally.
 */
export function killTreeSync(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  trySignal(-pid, signal) || trySignal(pid, signal)
}

function trySignal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig)
    return true
  } catch {
    return false
  }
}

function waitForExitOrTimeout(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      child.off('exit', finish)
      child.off('close', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    child.once('exit', finish)
    child.once('close', finish)
  })
}
