import {
  describeCliExit,
  formatExecutorFindings,
  probeExecutorReadiness,
  type Spawner,
} from '../executors/types.js'
import type { BackendHealth } from './types.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'

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
): Promise<BackendHealth> {
  let release = (): void => {}
  try {
    // The request path, taken first: a request that cannot resolve a cwd or
    // whose slot holds no credentials fails no matter what `--version` prints,
    // so reporting `ready` on the strength of `--version` alone is the defect.
    const readiness = await probeExecutorReadiness(spawner)
    if (readiness.findings.length > 0) {
      return { name, state: 'error', detail: formatExecutorFindings(readiness.findings) }
    }
    const spawned = await spawner(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
