/**
 * Scoped host spawner — wraps node `spawn` in a transient systemd
 * `--user --scope` so the entire process tree lives in its own cgroup.
 *
 * Why this exists:
 *
 *   The default hostSpawner relies on `detached: true` + `kill(-pgid)`
 *   to reap the spawned CLI and its descendants. That works as long
 *   as descendants stay in the original process group. It does not
 *   work for grandchildren that call `setsid()` to escape — e.g.
 *   vitest workers, `pnpm dev` child servers, or test fixtures that
 *   intentionally install `process.on('SIGTERM', () => {})` and keep
 *   themselves alive with `setInterval(() => {}, 1000)`.
 *
 *   Production failure mode this addresses (2026-05-22 → 2026-05-23):
 *   LLM CLIs invoked via cli-bridge ran `pnpm test` inside PR
 *   review worktrees. The vitest children of those test runs
 *   detached into their own process groups, survived `killTree()`,
 *   and accumulated in the cli-bridge.service cgroup. Over ~36 hours
 *   the bridge's TasksMax saturated (766/768) and every subsequent
 *   spawn returned EAGAIN. The pr-reviewer aggregator published
 *   "⚠️ Review Failed — All review passes errored" on every open PR
 *   across six repos.
 *
 * Strategy:
 *
 *   For each spawn, ask the user systemd manager to create a
 *   transient scope under `cli-bridge-llm.slice`:
 *
 *     systemd-run --user --scope --collect --quiet
 *                 --unit=cli-bridge-<rand>.scope
 *                 --slice=cli-bridge-llm.slice
 *                 -- <bin> <args...>
 *
 *   The scope owns its own cgroup. On chat() finally we write `1`
 *   to the scope's `cgroup.kill` — a Linux 5.14+ kernel feature
 *   that SIGKILLs every task in the cgroup atomically, regardless
 *   of pgid manipulation. `--collect` removes the unit once empty.
 *
 *   killTree() still runs first to give the direct child a chance
 *   to flush stdout and exit cleanly; the cgroup-kill in release()
 *   is the belt-and-suspenders backstop that catches escapees.
 *
 * Fallback:
 *
 *   If systemd-run is unavailable (running outside a systemd user
 *   manager, in a minimal container, etc.) this spawner degrades
 *   to hostSpawner. Detection is a one-shot synchronous probe at
 *   module load — cheap and definitive.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { hostSpawner, sanitizeHostEnv } from './host.js'
import type { Spawner, SpawnResult } from './types.js'

const SLICE = 'cli-bridge-llm.slice'
const DEFAULT_SCOPE_TASKS_MAX = 128
const DEFAULT_SCOPE_MEMORY_MAX = '3G'
const DEFAULT_SCOPE_RUNTIME_MAX_SEC = 7200

/** Result of the one-shot probe. `null` until first call, then cached. */
let systemdRunUsable: boolean | null = null

function probeSystemdRun(): boolean {
  if (systemdRunUsable !== null) return systemdRunUsable
  try {
    // systemd-run is at a stable path on every distro we support.
    // We probe by spawning `systemd-run --user --scope --quiet -- /bin/true`
    // synchronously is awkward, so probe by file existence + a cheap
    // env check. The actual call site catches spawn errors and falls
    // back per-invocation; this just avoids the overhead of trying
    // when we know systemd-run can't work.
    if (!existsSync('/usr/bin/systemd-run') && !existsSync('/bin/systemd-run')) {
      systemdRunUsable = false
      return false
    }
    // User systemd manager must be reachable. XDG_RUNTIME_DIR
    // pointing at a directory with systemd/private is the canonical
    // signal that `--user` will work.
    const xdg = process.env.XDG_RUNTIME_DIR
    if (!xdg) { systemdRunUsable = false; return false }
    if (!existsSync(`${xdg}/systemd/private`)) { systemdRunUsable = false; return false }
    systemdRunUsable = true
    return true
  } catch {
    systemdRunUsable = false
    return false
  }
}

/**
 * Resolve the cgroup filesystem path for our spawned wrapper by
 * reading `/proc/<pid>/cgroup`. Works for cgroup v2 unified hierarchy
 * (the only mode systemd 250+ supports for user managers).
 *
 * Returns `null` if the process is gone or the cgroup couldn't be
 * resolved; callers degrade to `systemctl --user stop <unit>`.
 */
function resolveCgroupPath(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    // cgroup v2 line format: "0::/user.slice/.../scope-unit.scope"
    const line = raw.split('\n').find((l) => l.startsWith('0::'))
    if (!line) return null
    const rel = line.slice(3)
    const abs = `/sys/fs/cgroup${rel}`
    return statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

async function killCgroup(pid: number, unitName: string): Promise<void> {
  const cgPath = resolveCgroupPath(pid)
  if (cgPath) {
    try {
      // cgroup.kill (Linux 5.14+) SIGKILLs every task in the cgroup
      // atomically. Faster than walking cgroup.procs and ignores
      // pgid manipulation by descendants.
      await writeFile(`${cgPath}/cgroup.kill`, '1')
      return
    } catch {
      // fall through to systemctl
    }
  }
  // Fallback: ask systemd to stop the unit. Slower (DBus round-trip)
  // but works on kernels older than 5.14 or when /proc/<pid> is
  // already gone.
  await new Promise<void>((resolve) => {
    const p = spawn('systemctl', ['--user', '--quiet', 'stop', unitName], {
      stdio: 'ignore',
      detached: true,
    })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
    // Don't block shutdown forever on a hung systemctl.
    setTimeout(() => { try { p.kill('SIGKILL') } catch {}; resolve() }, 3000).unref?.()
  })
}

export const scopedHostSpawner: Spawner = async (bin, args, opts) => {
  if (!probeSystemdRun()) {
    return hostSpawner(bin, args, opts)
  }

  // Unit name MUST be unique per spawn; collisions would refuse to
  // start. Include pid + 12 random hex chars (96 bits of entropy).
  const unitName = `cli-bridge-${process.pid}-${randomBytes(6).toString('hex')}.scope`
  const tasksMax = positiveIntEnv('CLI_BRIDGE_SCOPE_TASKS_MAX', DEFAULT_SCOPE_TASKS_MAX)
  const runtimeMaxSec = positiveIntEnv('CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC', DEFAULT_SCOPE_RUNTIME_MAX_SEC)
  const memoryMax = process.env.CLI_BRIDGE_SCOPE_MEMORY_MAX || DEFAULT_SCOPE_MEMORY_MAX

  const wrapped: string[] = [
    '--user',
    '--scope',
    '--collect',           // auto-remove the scope unit once empty
    '--quiet',
    `--unit=${unitName}`,
    `--slice=${SLICE}`,
    `--property=TasksMax=${tasksMax}`,
    `--property=MemoryMax=${memoryMax}`,
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    '--property=OOMPolicy=stop',
    '--',
    bin,
    ...args,
  ]

  const child = spawn('/usr/bin/systemd-run', wrapped, {
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: sanitizeHostEnv(opts.env),
    // `detached: true` makes the wrapper a process-group leader, so
    // existing killTree() (kill -pgid) still works as the graceful
    // first signal. The cgroup-kill in release() is the hard backstop.
    detached: true,
  })

  let spawnError: Error | null = null
  child.on('error', (err) => { spawnError = err })

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    // Fire-and-forget: writing 1 to cgroup.kill is synchronous from
    // the kernel's perspective; the actual SIGKILLs cascade
    // asynchronously and we don't need to await them. Errors are
    // swallowed because by the time release() runs the scope may
    // have already auto-collected if the child exited cleanly.
    const pid = child.pid
    if (pid !== undefined) {
      void killCgroup(pid, unitName).catch(() => {})
    }
  }

  const result: SpawnResult = {
    child,
    release,
    spawnError: () => spawnError,
  }
  return result
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}
