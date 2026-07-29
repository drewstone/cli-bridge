import { describeCliExit, type Spawner } from '../executors/types.js'
import type { BackendHealth } from './types.js'

/**
 * Probe a CLI-backed agent's readiness by spawning `<bin> --version`
 * through the backend's own spawner and mapping the result to a
 * `BackendHealth`. Shared by every backend whose readiness is simply "the
 * binary runs and prints a version": exit 0 → `ready` (version = trimmed
 * stdout), non-zero exit → `error`, spawn failure → `unavailable`. The
 * spawner lease is always released.
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
    const spawned = await spawner(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    release = spawned.release
    const child = spawned.child
    const closed = await new Promise<{ code: number | null; stdout: string; stderr: string } | { spawnFailure: string }>((resolve) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (b) => { stdout += b.toString() })
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => { resolve({ spawnFailure: err.message }) })
      child.on('close', (code) => { resolve({ code, stdout, stderr }) })
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
