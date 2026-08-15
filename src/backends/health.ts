import {
  describeCliExit,
  formatExecutorFindings,
  probeExecutorReadiness,
  type Spawner,
} from '../executors/types.js'
import type { Backend, BackendHealth } from './types.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'

const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 3_500

/** Run one backend health probe with a bounded caller-owned wait. */
export async function boundedProbe(
  backend: Backend,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BackendHealth> {
  let active = activeBackendProbes.get(backend)
  if (!active) {
    const controller = new AbortController()
    const created: ActiveBackendProbe = {
      controller,
      promise: undefined as unknown as Promise<BackendHealth>,
      waiters: 0,
      settled: false,
    }
    const promise = Promise.resolve()
      .then(async () => await backend.health(controller.signal))
      .catch((error): BackendHealth => ({
        name: backend.name,
        state: 'error',
        detail: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        created.settled = true
        if (activeBackendProbes.get(backend) === created) activeBackendProbes.delete(backend)
      })
    created.promise = promise
    active = created
    activeBackendProbes.set(backend, created)
  }

  active.waiters += 1
  let waiterReleased = false
  const releaseWaiter = (): void => {
    if (waiterReleased) return
    waiterReleased = true
    active!.waiters -= 1
    if (active!.waiters === 0 && !active!.settled) {
      if (activeBackendProbes.get(backend) === active) activeBackendProbes.delete(backend)
      active!.controller.abort(new Error('health probe has no waiting callers'))
    }
  }

  if (timeoutMs <= 0 && !signal) {
    try {
      return await active.promise
    } finally {
      releaseWaiter()
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let interruptedAlready = false
  const interruption = new Promise<BackendHealth>((resolve) => {
    const stop = (detail: string): void => {
      if (interruptedAlready) return
      interruptedAlready = true
      resolve({ name: backend.name, state: 'error', detail })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => stop(`health probe timed out after ${timeoutMs}ms`), timeoutMs)
      timer.unref?.()
    }
    if (signal) {
      onAbort = () => stop('health probe aborted by caller')
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
  try {
    return await Promise.race([active.promise, interruption])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    releaseWaiter()
  }
}

interface ActiveBackendProbe {
  controller: AbortController
  promise: Promise<BackendHealth>
  waiters: number
  settled: boolean
}

const activeBackendProbes = new WeakMap<Backend, ActiveBackendProbe>()

export function resolveHealthProbeTimeoutMs(): number {
  const raw = process.env.BRIDGE_HEALTH_PROBE_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_HEALTH_PROBE_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HEALTH_PROBE_TIMEOUT_MS
}

/**
 * Probe a CLI-backed agent's readiness by TAKING THE REQUEST PATH: the
 * executor's own cwd policy, its own mount assertions against a real slot, and
 * then `<bin> --version` in the directory a cwd-less request resolves to.
 *
 * A health check that does not exercise the request path is not a health check.
 * Measured on this host, before this function asked the executor anything:
 *
 *   - The probe spawned `<bin> --version` with NO cwd, so
 *     `assertDockerWorkspaceCwd` returned early and the workspace assertion
 *     every real request crosses was never reached. There was even a test
 *     asserting this ("still allows cwd-less calls, which is how /health probes
 *     run") — the probe took a path no request could take, and therefore could
 *     not detect the failure requests hit.
 *   - `--version` needs no credentials, so :3414 with per-slot volumes holding
 *     no auth.json answered `/health` 200 `ready` `version 1.18.9` while every
 *     request answered 502. The startup log knew — it printed the warning — and
 *     /health never learned.
 *   - Nothing re-checked the workspace bind or the credential mounts after
 *     startup, so a mount removed at hour three stayed invisible until traffic.
 *
 * So readiness is no longer a list of checks maintained here. It is delegated to
 * the executor, which is the only thing that knows the request path; a new
 * request-path assertion reaches /health without anyone remembering to add it.
 *
 * Verdicts: executor findings → `error` (with each finding's remedy), exit 0 →
 * `ready` (version = trimmed stdout), non-zero exit → `error`, spawn failure →
 * `unavailable`. The spawner lease is always released.
 *
 * A non-zero exit goes through `describeCliExit` so an executor-level failure
 * is named as one. /health reporting `exit 1: Error response from daemon: No
 * such container: 20e4aee6…` is what a swept pool container looked like for ten
 * days on this host: a container id, in a field the reader takes to be about
 * the CLI, with no statement of what to do about it.
 *
 * EVERY docker-capable backend must probe through here. claude, codex, kimi,
 * opencode and pi each carried their own byte-identical copy of this function,
 * so the first version of the diagnosis fix reached none of them and /health
 * still printed the raw daemon text — caught only by removing a container under
 * a live bridge. One implementation is the only way that stays fixed.
 */
export async function versionHealth(
  name: string,
  bin: string,
  spawner: Spawner,
  /** Extra context for the `ready` verdict, e.g. the base URL a proxy is using. */
  readyDetail?: string,
  signal?: AbortSignal,
): Promise<BackendHealth> {
  let release = (): void => {}
  try {
    // The request path, taken first: a request that cannot resolve a cwd or
    // whose slot holds no credentials fails no matter what `--version` prints,
    // so reporting `ready` on the strength of `--version` alone is the defect.
    const readiness = await probeExecutorReadiness(spawner, signal)
    if (readiness.findings.length > 0) {
      return { name, state: 'error', detail: formatExecutorFindings(readiness.findings) }
    }
    const spawned = await spawner(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
      // Spawn where a cwd-less REQUEST spawns. Passing no cwd is what let the
      // probe skip the executor's workspace assertion and run in the image's
      // own WORKDIR instead of the mount a request depends on.
      ...(readiness.cwd !== undefined ? { cwd: readiness.cwd } : {}),
    })
    release = spawned.release
    const child = spawned.child
    const closed = await new Promise<{ code: number | null; stdout: string; stderr: string } | { spawnFailure: string }>((resolve) => {
      const stdout = new BoundedDiagnosticBuffer()
      const stderr = new BoundedDiagnosticBuffer()
      child.stdout?.on('data', (b) => { stdout.append(b) })
      child.stderr?.on('data', (b) => { stderr.append(b) })
      child.on('error', (err) => { resolve({ spawnFailure: err.message }) })
      child.on('close', (code) => {
        resolve({ code, stdout: stdout.render(), stderr: stderr.render() })
      })
    })
    if ('spawnFailure' in closed) {
      return { name, state: 'unavailable', detail: `spawn failed: ${closed.spawnFailure}` }
    }
    if (closed.code === 0) {
      return {
        name,
        state: 'ready',
        version: closed.stdout.trim() || undefined,
        ...(readyDetail ? { detail: readyDetail } : {}),
      }
    }
    return {
      name,
      state: 'error',
      detail: await describeCliExit(spawned, bin, closed.code, closed.stderr || closed.stdout),
    }
  } catch (err) {
    return { name, state: 'unavailable', detail: (err as Error).message }
  } finally {
    release()
  }
}
