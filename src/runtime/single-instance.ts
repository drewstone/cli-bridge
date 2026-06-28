/**
 * Single-instance guard — one cli-bridge per BRIDGE_PORT.
 *
 * Two bridges bound to the same port is the silent-corruption failure
 * mode: the second `serve()` either EADDRINUSE-crashes (loud, fine) or —
 * worse, under a racing restart — both processes spawn subprocesses,
 * both write the SAME `sessions.sqlite`, and runs get killed out from
 * under each other. The job/connection decoupling and the durable run
 * buffer both assume exactly one owner of the run registry; this guard
 * enforces that assumption before we ever listen.
 *
 * Mechanism: an atomic `O_CREAT | O_EXCL` pidfile keyed by port. Node
 * ships no `flock`, so we use the portable, dependency-free pidfile
 * pattern with a liveness reclaim:
 *
 *   - Create the pidfile exclusively. Win → we own the port.
 *   - On EEXIST, read the holder pid and probe it with `kill(pid, 0)`.
 *       - Holder alive  → throw PortAlreadyBoundError (refuse to start).
 *       - Holder dead    → the file is STALE (predecessor SIGKILL'd,
 *                          never ran its release). Reclaim atomically.
 *
 * The liveness reclaim is what makes this safe under systemd
 * `Restart=always`: a SIGKILL'd predecessor leaves the pidfile behind,
 * but its pid is gone, so the restart reclaims instead of wedging. A
 * graceful exit removes the file in `release()`.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface InstanceLock {
  /** Absolute path to the pidfile this lock holds. */
  path: string
  /** Remove the pidfile. Idempotent — safe to call from shutdown + atexit. */
  release(): void
}

export class PortAlreadyBoundError extends Error {
  constructor(
    public readonly port: number,
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `cli-bridge is already running on port ${port}` +
        (holderPid ? ` (pid ${holderPid})` : '') +
        `. Lockfile ${lockPath} is held by a live process. ` +
        `Stop the other instance or set BRIDGE_PORT to a free port.`,
    )
    this.name = 'PortAlreadyBoundError'
  }
}

/**
 * Acquire the per-port single-instance lock. Throws
 * `PortAlreadyBoundError` (a fatal startup error — see
 * `isFatalServerStartupError`) when a LIVE process already holds it.
 * Reclaims a stale lockfile left by a crashed predecessor. Returns a
 * handle whose `release()` removes the pidfile.
 *
 * `dir` defaults to the OS temp dir — a writable location even under
 * systemd `ProtectSystem=strict`. PrivateTmp gives each unit its own
 * /tmp namespace, which is correct: the guard is per-host-port within
 * one namespace, and systemd never runs two instances of the same
 * templated unit on the same port.
 */
export function acquireInstanceLock(port: number, dir: string = tmpdir()): InstanceLock {
  const path = join(dir, `cli-bridge-${port}.pid`)
  claim(path, port)

  let released = false
  return {
    path,
    release(): void {
      if (released) return
      released = true
      // Only remove the file if it still carries OUR pid — never delete
      // a lock a successor reclaimed after we were declared dead.
      try {
        if (readHolderPid(path) === process.pid) unlinkSync(path)
      } catch { /* already gone */ }
    },
  }
}

/**
 * Try to create the pidfile exclusively; on collision, reclaim iff the
 * recorded holder is dead. Retries once after a reclaim to close the
 * (vanishingly small) race where two reclaimers fight — the second sees
 * the first's fresh pid and correctly refuses.
 */
function claim(path: string, port: number, attempt = 0): void {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const holderPid = readHolderPid(path)
    if (holderPid !== null && isAlive(holderPid)) {
      throw new PortAlreadyBoundError(port, path, holderPid)
    }
    // Stale lockfile (holder dead or unreadable). Reclaim atomically.
    if (attempt >= 2) {
      // A live successor reclaimed faster than us — treat as bound.
      throw new PortAlreadyBoundError(port, path, holderPid)
    }
    try { unlinkSync(path) } catch { /* someone else reclaimed first */ }
    claim(path, port, attempt + 1)
    return
  }
  writeSync(fd, `${process.pid}\n`)
  closeSync(fd)
}

function readHolderPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** `kill(pid, 0)` probes existence without delivering a signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but not ours to signal (still alive). ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
