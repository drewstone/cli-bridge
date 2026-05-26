/**
 * Shared CLI health probe — self-limiting so it can NEVER leak a host-executor
 * slot (resilience #529).
 *
 * The bug it fixes: every backend's `health()` spawned `<bin> --version` through
 * the task spawner (acquiring a semaphore slot) and released the slot in a
 * `finally`. But `/health`'s outer `Promise.race` (boundedProbe, 3.5s) abandons
 * a slow `health()` on timeout — and the abandoned promise never resolves while
 * the `--version` child is still running, so its `finally { release() }` never
 * runs. Under load (cold `--version` > timeout) or repeated `/health` polling,
 * those un-released slots pile up until the bridge wedges at `in_flight=max` and
 * every real task fails with `acquire timeout`. Observed: 10/13 acquires timed
 * out; a probe-spawned CLI stuck at 39s holding a slot.
 *
 * The fix: a hard SELF-timeout (< boundedProbe's) that `killTree`s the child and
 * resolves, so `health()` always completes and ALWAYS frees its slot. A probe is
 * a liveness check, not a task — it must self-limit, never starve real work.
 */

import { killTree } from '../executors/process-tree.js'
import type { Spawner } from '../executors/types.js'
import type { BackendHealth } from './types.js'

const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 3_000

export interface ProbeCliVersionOpts {
  spawner: Spawner
  bin: string
  name: string
  args?: string[]
  /** Self-timeout. Keep < boundedProbe's PROBE_TIMEOUT_MS so health() releases
   *  its slot before /health abandons it. Env: BRIDGE_HEALTH_SPAWN_TIMEOUT_MS. */
  timeoutMs?: number
  /** Map a successful (exit 0) probe's stdout to the backend's ready health. */
  onReady: (stdout: string) => BackendHealth
}

export async function probeCliVersion(opts: ProbeCliVersionOpts): Promise<BackendHealth> {
  const envMs = Number(process.env.BRIDGE_HEALTH_SPAWN_TIMEOUT_MS)
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_HEALTH_PROBE_TIMEOUT_MS)
  let release = (): void => {}
  try {
    const spawned = await opts.spawner(opts.bin, opts.args ?? ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    release = spawned.release
    const child = spawned.child
    return await new Promise<BackendHealth>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (h: BackendHealth): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(h)
      }
      // SELF-LIMIT: a probe that overruns kills its child and releases its slot
      // (via the finally below) — never leaks it.
      const timer = setTimeout(() => {
        void killTree(child, { reason: 'health-probe-timeout' })
        finish({ name: opts.name, state: 'error', detail: `health probe self-timeout after ${timeoutMs}ms` })
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on('data', (b) => { stdout += b.toString() })
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => finish({ name: opts.name, state: 'unavailable', detail: `spawn failed: ${err.message}` }))
      child.on('close', (code) => {
        if (code === 0) finish(opts.onReady(stdout))
        else finish({ name: opts.name, state: 'error', detail: `exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}` })
      })
    })
  } catch (err) {
    return { name: opts.name, state: 'unavailable', detail: (err as Error).message }
  } finally {
    release()
  }
}
