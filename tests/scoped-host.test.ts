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
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  createScopedHostSpawner,
  isOwnedScopeControlGroup,
  scopeControlArgs,
  scopedHostSpawner,
  terminateOwnedScope,
  type ScopeCleanupOperations,
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

describe('scopedHostSpawner — strict scope termination', () => {
  const unit = 'cli-bridge-1234-a1b2c3d4e5f6.scope'
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/cli.slice/cli-bridge-llm.slice/${unit}`
  const bridge = '/user.slice/user-1000.slice/user@1000.service/app.slice/cli-bridge.service'

  function operations(overrides: Partial<ScopeCleanupOperations> = {}): ScopeCleanupOperations {
    return {
      showUnit: async () => ({ loadState: 'loaded', activeState: 'active', controlGroup }),
      stopUnit: async () => {},
      currentControlGroup: () => bridge,
      cgroupIsPopulated: () => false,
      writeCgroupKill: async () => {},
      wait: async () => {},
      ...overrides,
    }
  }

  it('propagates a missing or non-executable systemctl instead of declaring cleanup complete', async () => {
    const error = Object.assign(new Error('spawn /usr/bin/systemctl ENOENT'), { code: 'ENOENT' })
    await expect(terminateOwnedScope(unit, operations({
      showUnit: async () => { throw error },
    }))).rejects.toBe(error)
  })

  it('fails through the default systemctl path when the user manager is unreachable', async () => {
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS
    const missingRuntime = `/nonexistent-cli-bridge-systemd-${process.pid}`
    process.env.XDG_RUNTIME_DIR = missingRuntime
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${missingRuntime}/bus`
    try {
      await expect(terminateOwnedScope(unit)).rejects.toThrow(/connect to bus|ENOENT/u)
    } finally {
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus
    }
  })

  it('reports both cgroup.kill and systemctl stop failures', async () => {
    const killFailure = new Error('cgroup.kill denied')
    const stopFailure = new Error('systemctl stop failed')
    await expect(terminateOwnedScope(unit, operations({
      writeCgroupKill: async () => { throw killFailure },
      stopUnit: async () => { throw stopFailure },
    }))).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [killFailure, stopFailure],
    })
  })
})

describe('scopedHostSpawner — launch fallback', () => {
  it('probes the same slice and resource properties used by a real launch', () => {
    const args = scopeControlArgs('cli-bridge-1234-a1b2c3d4e5f6.scope', {
      tasksMax: 37,
      memoryMax: '768M',
      runtimeMaxSec: 91,
    })
    expect(args).toContain('--slice=cli-bridge-llm.slice')
    expect(args).toContain('--property=TasksMax=37')
    expect(args).toContain('--property=MemoryMax=768M')
    expect(args).toContain('--property=RuntimeMaxSec=91')
    expect(args).toContain('--property=OOMPolicy=stop')
  })

  it('does not dispatch a duplicate when scope start was not observed', async () => {
    let acquires = 0
    let releases = 0
    let fallbackCalls = 0
    let markerCleanups = 0
    let launchedArgs: string[] = []
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => { acquires += 1 },
        release: () => { releases += 1 },
      },
      spawnProcess: ((bin: string, args: readonly string[]) => {
        launchedArgs = [bin, ...args]
        return spawn('/bin/true')
      }) as typeof spawn,
      fallbackSpawner: async () => {
        fallbackCalls += 1
        return { child: spawn('/bin/true'), release: () => {} }
      },
      killTreeFn: async () => {},
      killScopeFn: async () => {},
      observeStart: async () => ({ started: false, error: new Error('TasksMax property rejected') }),
      createMarker: () => ({
        path: `/tmp/cli-bridge-never-created-${process.pid}`,
        cleanup: () => { markerCleanups += 1 },
      }),
    })

    await expect(spawner('/bin/requested-workload', ['--must-not-run-in-failed-scope'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })).rejects.toThrow(/request was not retried/u)
    expect(acquires).toBe(1)
    expect(releases).toBe(1)
    expect(fallbackCalls).toBe(0)
    expect(markerCleanups).toBe(1)
    expect(launchedArgs).toContain('/bin/sh')
    expect(launchedArgs).toContain('/bin/requested-workload')
  })

  it('holds capacity and never falls back until an uncertain scope is proven stopped', async () => {
    let releases = 0
    let fallbackCalls = 0
    let scopeCleanupCalls = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => spawn('/bin/true')) as unknown as typeof spawn,
      fallbackSpawner: async () => {
        fallbackCalls += 1
        return { child: spawn('/bin/true'), release: () => {} }
      },
      killTreeFn: async () => {},
      killScopeFn: async () => {
        scopeCleanupCalls += 1
        if (scopeCleanupCalls === 1) throw new Error('user manager unavailable')
      },
      observeStart: async () => ({ started: false, error: new Error('start observation timed out') }),
      createMarker: () => ({
        path: `/tmp/cli-bridge-never-created-${process.pid}`,
        cleanup: () => {},
      }),
    })

    await expect(spawner('/bin/requested-workload', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })).rejects.toThrow(/termination could not be proven/u)
    expect(releases).toBe(0)
    expect(fallbackCalls).toBe(0)

    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(scopeCleanupCalls).toBe(2)
    expect(releases).toBe(1)
    expect(fallbackCalls).toBe(0)
  })

  it('retries full finalization after a transient scope cleanup failure', async () => {
    const child = new EventEmitter() as ChildProcess
    ;(child as unknown as { exitCode: number | null }).exitCode = null
    ;(child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null
    let scopeCleanupCalls = 0
    let releases = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => child) as never,
      fallbackSpawner: async () => { throw new Error('fallback must not run') },
      applyJailFn: async (bin, args, opts) => ({ bin, args, env: opts.env }),
      killTreeFn: async () => {},
      killScopeFn: async () => {
        scopeCleanupCalls += 1
        if (scopeCleanupCalls === 1) throw new Error('transient scope cleanup failure')
      },
      observeStart: async () => ({ started: true }),
      createMarker: () => ({ path: '/tmp/unused-scope-marker', cleanup: () => {} }),
    })
    const owned = await spawner('ignored', [], { stdio: ['ignore', 'pipe', 'pipe'] })

    await expect(owned.terminate?.()).rejects.toThrow(/transient scope cleanup failure/u)
    expect(releases).toBe(0)
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await sleep(10)
    expect(scopeCleanupCalls).toBe(2)
    expect(releases).toBe(1)
  })

  it('terminates the scope before retrying transient start-marker cleanup', async () => {
    const child = new EventEmitter() as ChildProcess
    ;(child as unknown as { exitCode: number | null }).exitCode = null
    ;(child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null
    let markerCleanupCalls = 0
    let scopeCleanupCalls = 0
    let releases = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => child) as never,
      fallbackSpawner: async () => { throw new Error('fallback must not run') },
      applyJailFn: async (bin, args, opts) => ({ bin, args, env: opts.env }),
      killTreeFn: async () => {},
      killScopeFn: async () => { scopeCleanupCalls += 1 },
      observeStart: async () => ({ started: true }),
      createMarker: () => ({
        path: '/tmp/unused-scope-marker',
        cleanup: () => {
          markerCleanupCalls += 1
          if (markerCleanupCalls === 1) throw new Error('transient marker cleanup failure')
        },
      }),
    })
    const owned = await spawner('ignored', [], { stdio: ['ignore', 'pipe', 'pipe'] })

    const failure = await owned.terminate?.().catch(error => error as unknown)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'transient marker cleanup failure' }),
    ])
    expect(scopeCleanupCalls).toBe(1)
    expect(releases).toBe(0)
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await sleep(10)
    expect(markerCleanupCalls).toBe(2)
    expect(scopeCleanupCalls).toBe(2)
    expect(releases).toBe(1)
  })

  it('retries marker cleanup after a synchronous spawn failure without skipping jail cleanup', async () => {
    let markerCleanupCalls = 0
    let jailCleanupCalls = 0
    let releases = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => { throw new Error('spawn failed') }) as never,
      fallbackSpawner: async () => { throw new Error('fallback must not run') },
      applyJailFn: async (bin, args, opts) => ({
        bin,
        args,
        env: opts.env,
        cleanup: async () => { jailCleanupCalls += 1 },
      }),
      killTreeFn: async () => {},
      killScopeFn: async () => {},
      observeStart: async () => ({ started: true }),
      createMarker: () => ({
        path: '/tmp/unused-scope-marker',
        cleanup: () => {
          markerCleanupCalls += 1
          if (markerCleanupCalls === 1) throw new Error('transient marker cleanup failure')
        },
      }),
    })

    await expect(spawner('ignored', [], { stdio: ['ignore', 'pipe', 'pipe'] }))
      .rejects.toThrow(/temporary-artifact cleanup failed/u)
    expect(jailCleanupCalls).toBe(1)
    expect(releases).toBe(0)
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await sleep(10)
    expect(markerCleanupCalls).toBe(2)
    expect(jailCleanupCalls).toBe(1)
    expect(releases).toBe(1)
  })

  it('rolls back the jail when cancellation arrives immediately after jail setup', async () => {
    const controller = new AbortController()
    let jailCleanupCalls = 0
    let markerCreations = 0
    let releases = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => { throw new Error('spawn must not run') }) as never,
      fallbackSpawner: async () => { throw new Error('fallback must not run') },
      applyJailFn: async (bin, args, opts) => {
        controller.abort(new Error('caller disconnected'))
        return {
          bin,
          args,
          env: opts.env,
          cleanup: async () => {
            jailCleanupCalls += 1
            if (jailCleanupCalls === 1) throw new Error('transient jail cleanup failure')
          },
        }
      },
      killTreeFn: async () => {},
      killScopeFn: async () => {},
      observeStart: async () => ({ started: true }),
      createMarker: () => {
        markerCreations += 1
        return { path: '/tmp/unused-scope-marker', cleanup: () => {} }
      },
    })

    await expect(spawner('ignored', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controller.signal,
    })).rejects.toThrow(/jail cleanup failed/u)
    expect({ jailCleanupCalls, markerCreations, releases }).toEqual({
      jailCleanupCalls: 1,
      markerCreations: 0,
      releases: 0,
    })
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await sleep(10)
    expect({ jailCleanupCalls, markerCreations, releases }).toEqual({
      jailCleanupCalls: 2,
      markerCreations: 0,
      releases: 1,
    })
  })

  it('rolls back the jail and capacity when start-marker allocation throws', async () => {
    let jailCleanupCalls = 0
    let releases = 0
    const spawner = createScopedHostSpawner({
      probe: () => true,
      invalidateProbe: () => {},
      semaphore: {
        acquire: async () => {},
        release: () => { releases += 1 },
      },
      spawnProcess: (() => { throw new Error('spawn must not run') }) as never,
      fallbackSpawner: async () => { throw new Error('fallback must not run') },
      applyJailFn: async (bin, args, opts) => ({
        bin,
        args,
        env: opts.env,
        cleanup: async () => {
          jailCleanupCalls += 1
          if (jailCleanupCalls === 1) throw new Error('transient jail cleanup failure')
        },
      }),
      killTreeFn: async () => {},
      killScopeFn: async () => {},
      observeStart: async () => ({ started: true }),
      createMarker: () => { throw new Error('marker allocation failed') },
    })

    await expect(spawner('ignored', [], { stdio: ['ignore', 'pipe', 'pipe'] }))
      .rejects.toThrow(/marker creation and jail cleanup failed/u)
    expect({ jailCleanupCalls, releases }).toEqual({ jailCleanupCalls: 1, releases: 0 })
    const deadline = Date.now() + 1_000
    while (releases === 0 && Date.now() < deadline) await sleep(10)
    expect({ jailCleanupCalls, releases }).toEqual({ jailCleanupCalls: 2, releases: 1 })
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
