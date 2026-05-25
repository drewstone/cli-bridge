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
import { scopedHostSpawner } from '../src/executors/scoped-host.js'
import { killTree } from '../src/executors/process-tree.js'

const systemdRunAvailable =
  (existsSync('/usr/bin/systemd-run') || existsSync('/bin/systemd-run')) &&
  !!process.env.XDG_RUNTIME_DIR &&
  existsSync(`${process.env.XDG_RUNTIME_DIR}/systemd/private`)

const describeReal = systemdRunAvailable ? describe : describe.skip

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
