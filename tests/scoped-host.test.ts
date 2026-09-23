/**
 * Adversarial tests for scopedHostSpawner.
 *
 * Each test pins a specific regression from the 2026-05-22→05-23
 * cli-bridge.service incident where LLM-invoked test fixtures leaked
 * into the bridge cgroup and exhausted TasksMax (766/768), causing
 * every PR-reviewer run to publish "⚠️ Review Failed".
 *
 * These tests run against the REAL host systemd-user-manager — no
 * mocks, no stubs. Skipped automatically on machines without
 * systemd-run + a user manager (Docker CI, macOS).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  defaultScopeMemoryMax,
  isOwnedScopeControlGroup,
  resolveScopeMemoryMax,
  resolveScopedSpawnEnv,
  scopedHostExecutorSnapshot,
  scopedHostSpawner,
} from '../src/executors/scoped-host.js'
import { killTree } from '../src/executors/process-tree.js'

const systemdRunAvailable =
  (existsSync('/usr/bin/systemd-run') || existsSync('/bin/systemd-run')) &&
  !!process.env.XDG_RUNTIME_DIR &&
  existsSync(`${process.env.XDG_RUNTIME_DIR}/systemd/private`)

// Real cgroup teardown can kill the invoking interactive scope when a developer
// runs this suite from tmux through another agent service. Keep it out of the
// default test command; CI or a disposable host must opt in explicitly.
const describeReal = systemdRunAvailable && process.env.CLI_BRIDGE_REAL_CGROUP_TESTS === '1'
  ? describe
  : describe.skip

describe('scopedHostSpawner — the wrapper environment', () => {
  it('leaves an absent env absent, because undefined means INHERIT and PATH lives there', () => {
    // The regression this pins took the whole bridge down: spreading an undefined base into an
    // object turned "inherit the bridge environment" into "these two transport variables only", so
    // systemd-run had no PATH and answered `Failed to find executable pi: No such file or
    // directory` for pi, claude, codex and opencode at the same moment — four healthy CLIs
    // reported missing.
    expect(
      resolveScopedSpawnEnv(undefined, {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      }),
    ).toBeUndefined()
  })

  it('still re-injects the bus transport into an explicit env that stripped it', () => {
    // The case #126 fixed: a backend with a strict child-env allowlist drops the transport vars,
    // and without them systemd-run cannot reach the user manager at all.
    expect(
      resolveScopedSpawnEnv(
        { PATH: '/usr/bin', HOME: '/home/drew' },
        { XDG_RUNTIME_DIR: '/run/user/1000' },
      ),
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/drew', XDG_RUNTIME_DIR: '/run/user/1000' })
  })

  it('does not invent transport variables the bridge itself does not have', () => {
    expect(resolveScopedSpawnEnv({ PATH: '/usr/bin' }, {})).toEqual({ PATH: '/usr/bin' })
  })
})

const GiB = 1024 ** 3

/** systemd's MemoryMax= syntax (base-1024 K/M/G/T suffix, or bytes) → bytes. */
function systemdBytes(value: string): number {
  const m = /^(\d+)([KMGT]?)$/.exec(value)
  if (!m) throw new Error(`unparseable MemoryMax: ${value}`)
  const exp = ['', 'K', 'M', 'G', 'T'].indexOf(m[2]!)
  return Number(m[1]) * 1024 ** exp
}

describe('scopedHostSpawner — host-sized memory cap', () => {
  it.each([
    // The regression: the 128 GB GTR (MemTotal 127396944 kB) had a fixed 3G cap and the kernel
    // OOM-killed ~3.0 GB python review lanes inside their scopes on 2026-09-22.
    ['the 128 GB GTR as os.totalmem() reports it', 127_396_944 * 1024, '8G'],
    ['a 64 GB host with nothing reserved', 64 * GiB, '8G'],
    ['a 64 GB host whose firmware reserves ~6%, as the GTR does', 60.5 * GiB, '8G'],
    ['a 64 GB host with just under 8 GiB reserved', Math.round(56.1 * GiB), '8G'],
    ['a 512 GiB host, held at the ceiling', 512 * GiB, '8G'],
    ['a 64 GB host with a full 8 GiB carve-out, which leaves 56 GiB', 56 * GiB, '7G'],
    ['a 48 GB host', Math.round(46.8 * GiB), '6G'],
    ['a 32 GB host', 31 * GiB, '4G'],
    ['a 24 GB host', 23 * GiB, '3G'],
    ['a 16 GB host, raised to the floor', 15.5 * GiB, '3G'],
    ['an 8 GiB VM, raised to the floor', 8 * GiB, '3G'],
  ])('gives %s (%d bytes) a %s cap', (_host, bytes, expected) => {
    expect(defaultScopeMemoryMax(bytes)).toBe(expected)
  })

  it('never lowers a host below the old fixed 3G default', () => {
    for (let gib = 1; gib <= 1024; gib += 1) {
      expect(systemdBytes(defaultScopeMemoryMax(gib * GiB))).toBeGreaterThanOrEqual(3 * GiB)
    }
  })

  it('falls back to the floor when the host reports no usable memory size', () => {
    expect(defaultScopeMemoryMax(0)).toBe('3G')
    expect(defaultScopeMemoryMax(-1)).toBe('3G')
    expect(defaultScopeMemoryMax(Number.NaN)).toBe('3G')
    expect(defaultScopeMemoryMax(Number.POSITIVE_INFINITY)).toBe('3G')
  })

  it('lets CLI_BRIDGE_SCOPE_MEMORY_MAX override the host-sized default verbatim', () => {
    expect(resolveScopeMemoryMax({ CLI_BRIDGE_SCOPE_MEMORY_MAX: '12G' }, '8G')).toBe('12G')
    expect(resolveScopeMemoryMax({ CLI_BRIDGE_SCOPE_MEMORY_MAX: '2G' }, '8G')).toBe('2G')
    expect(resolveScopeMemoryMax({ CLI_BRIDGE_SCOPE_MEMORY_MAX: 'infinity' }, '8G')).toBe('infinity')
  })

  it('treats an unset or empty override as absent', () => {
    expect(resolveScopeMemoryMax({}, '8G')).toBe('8G')
    expect(resolveScopeMemoryMax({ CLI_BRIDGE_SCOPE_MEMORY_MAX: '' }, '8G')).toBe('8G')
  })

  it('reports the cap the next scope receives, and null when spawns fall back unscoped', () => {
    // Without a systemd user manager (macOS, Docker CI) spawns go to hostSpawner with no MemoryMax,
    // so reporting a cap there would tell /health consumers a runaway child is bounded when it is not.
    expect(scopedHostExecutorSnapshot().memory_max).toBe(systemdRunAvailable ? resolveScopeMemoryMax() : null)
  })
})

describe('scopedHostSpawner — cgroup ownership proof', () => {
  const unit = 'cli-bridge-1234-a1b2c3d4e5f6.scope'
  const owned = `/user.slice/user-1000.slice/user@1000.service/cli.slice/cli-bridge.slice/cli-bridge-llm.slice/${unit}`
  const bridge = '/user.slice/user-1000.slice/user@1000.service/app.slice/cli-bridge.service'

  it('accepts only the exact random unit directly under the dedicated slice', () => {
    expect(isOwnedScopeControlGroup(owned, unit, bridge)).toBe(true)
    expect(isOwnedScopeControlGroup(owned.replace(unit, 'cli-bridge-1234-ffffffffffff.scope'), unit, bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(owned.replace('cli-bridge-llm.slice', 'app.slice'), unit, bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(`${owned}/child`, unit, bridge)).toBe(false)
  })

  it('rejects malformed, relative, traversal, and unverifiable paths', () => {
    expect(isOwnedScopeControlGroup(owned.slice(1), unit, bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(`${owned}/../${unit}`, unit, bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(`${owned}\n`, unit, bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(owned, 'not-our-unit.scope', bridge)).toBe(false)
    expect(isOwnedScopeControlGroup(owned, unit, null)).toBe(false)
    expect(isOwnedScopeControlGroup(owned, unit, `${bridge}/../other.service`)).toBe(false)
  })

  it('never authorizes the bridge current cgroup or any ancestor of it', () => {
    expect(isOwnedScopeControlGroup(owned, unit, owned)).toBe(false)
    expect(isOwnedScopeControlGroup(owned, unit, `${owned}/nested-child`)).toBe(false)
  })
})

/** Read /proc/<pid>/cgroup → "/user.slice/.../cli-bridge-...scope" or null. */
function cgroupOf(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    const line = raw.split('\n').find((l) => l.startsWith('0::'))
    return line ? line.slice(3) : null
  } catch {
    return null
  }
}

/** Wait until predicate is true or `timeoutMs` elapses. */
async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(stepMs)
  }
  return pred()
}

describeReal('scopedHostSpawner — real cgroup isolation', () => {
  it('places the spawned process in a transient scope under cli-bridge-llm.slice', async () => {
    const r = await scopedHostSpawner('/bin/sleep', ['5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      // systemd-run takes a moment to set up the scope before exec'ing
      // the target. Wait until the cgroup path resolves.
      const cgroup = await waitUntil(
        () => {
          const c = cgroupOf(r.child.pid!)
          return c !== null && c.includes('cli-bridge-llm.slice')
        },
        2000,
      )
      expect(cgroup, `process is not in cli-bridge-llm.slice; cgroup=${cgroupOf(r.child.pid!)}`)
        .toBe(true)
    } finally {
      r.release()
      await killTree(r.child)
    }
  })

  it('reaps a SIGTERM-ignoring descendant via cgroup.kill', async () => {
    // Reproduces the leak from the incident: a grandchild that
    // installs `process.on('SIGTERM', () => {})` and keeps itself
    // alive with a setInterval. pgid-based kill cannot reach it
    // because the harness layer between it and the bridge has
    // setsid'd into a new group. Only cgroup.kill works.
    //
    // We model the harness as `sh -c` spawning a backgrounded node
    // process that intentionally:
    //   1. ignores SIGTERM
    //   2. starts a new session (setsid via Node `detached: true` is
    //      simulated here by passing the daemonised pid back via stdout)
    //   3. keeps itself alive via setInterval
    // The parent `sh` exits as soon as the child is spawned, so the
    // grandchild is reparented to PID 1 if not contained by cgroup.
    const script = `
      node -e "
        process.on('SIGTERM', () => {});
        process.stdout.write(String(process.pid) + '\\n');
        setInterval(() => {}, 1000);
      " &
      child=$!
      # Detach: close stdin/stdout/stderr of the parent shell so it
      # exits, leaving the node grandchild orphaned-to-init unless
      # cgroup contains it.
      disown $child
      # Print the grandchild pid then exit so the wrapper sees EOF.
      sleep 0.5
    `
    const r = await scopedHostSpawner('/bin/sh', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let grandchildPid = 0
    r.child.stdout?.on('data', (b) => {
      const m = b.toString().match(/(\d+)/)
      if (m) grandchildPid = Number(m[1])
    })

    // Wait for the grandchild to print its pid.
    await waitUntil(() => grandchildPid > 0, 3000)
    expect(grandchildPid, 'grandchild did not report its pid').toBeGreaterThan(0)

    // Sanity: the grandchild IS in our scope's cgroup despite being
    // backgrounded and `disown`ed.
    const gcCgroup = cgroupOf(grandchildPid)
    expect(gcCgroup, `grandchild cgroup=${gcCgroup}`).toMatch(/cli-bridge-llm\.slice/)

    // Sanity: it really ignores SIGTERM.
    try { process.kill(grandchildPid, 'SIGTERM') } catch {}
    await sleep(300)
    expect(() => process.kill(grandchildPid, 0), 'grandchild died to SIGTERM — fixture broken').not.toThrow()

    // Now the real test: release() should reap the entire cgroup
    // via cgroup.kill, including the SIGTERM-ignoring grandchild.
    r.release()
    await killTree(r.child)

    const reaped = await waitUntil(() => {
      try { process.kill(grandchildPid, 0); return false } catch { return true }
    }, 3000)
    expect(reaped, `grandchild pid=${grandchildPid} survived release()`).toBe(true)
  })

  it('applies the resolved memory cap to the scope cgroup', async () => {
    const r = await scopedHostSpawner('/bin/sleep', ['5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const inScope = await waitUntil(
        () => cgroupOf(r.child.pid!)?.includes('cli-bridge-llm.slice') ?? false,
        2000,
      )
      expect(inScope, `process is not in cli-bridge-llm.slice; cgroup=${cgroupOf(r.child.pid!)}`).toBe(true)
      const memoryMax = readFileSync(`/sys/fs/cgroup${cgroupOf(r.child.pid!)}/memory.max`, 'utf8').trim()
      const expected = resolveScopeMemoryMax()
      expect(memoryMax).toBe(expected === 'infinity' ? 'max' : String(systemdBytes(expected)))
    } finally {
      r.release()
      await killTree(r.child)
    }
  })

  it('release() is idempotent', async () => {
    const r = await scopedHostSpawner('/bin/sleep', ['1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    r.release()
    expect(() => r.release()).not.toThrow()
    await killTree(r.child)
  })

  it('does not leave scope units after the spawn completes', async () => {
    const r = await scopedHostSpawner('/bin/true', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve) => r.child.on('exit', () => resolve()))
    r.release()

    // The `--collect` flag removes the unit once empty. Give systemd
    // a beat to garbage-collect, then confirm nothing under our
    // slice references this PID.
    await sleep(500)
    const sliceCgroup =
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service' +
      '/cli.slice/cli-bridge.slice/cli-bridge-llm.slice'
    if (existsSync(sliceCgroup)) {
      const remaining = readdirSync(sliceCgroup).filter((n) => n.endsWith('.scope'))
      // Other tests may have concurrent scopes; we only assert OUR
      // pid is gone, not that the slice is empty.
      for (const scope of remaining) {
        try {
          const procs = readFileSync(`${sliceCgroup}/${scope}/cgroup.procs`, 'utf8').trim()
          expect(procs, `our pid still in ${scope}`).not.toContain(String(r.child.pid))
        } catch {
          // scope may have just been collected — race is benign
        }
      }
    }
  })
})
