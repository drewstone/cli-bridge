import type { Spawner } from '../executors/types.js'
import type { BackendHealth } from './types.js'

/**
 * Probe a CLI-backed agent's readiness by spawning `<bin> --version`
 * through the backend's own spawner and mapping the result to a
 * `BackendHealth`. Shared by every backend whose readiness is simply "the
 * binary runs and prints a version": exit 0 → `ready` (version = trimmed
 * stdout), non-zero exit → `error` (with captured stderr/stdout), spawn
 * failure → `unavailable`. The spawner lease is always released.
 */
export async function versionHealth(
  name: string,
  bin: string,
  spawner: Spawner,
): Promise<BackendHealth> {
  let release = (): void => {}
  try {
    const spawned = await spawner(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    release = spawned.release
    const child = spawned.child
    return await new Promise<BackendHealth>((resolve) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (b) => { stdout += b.toString() })
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => {
        resolve({ name, state: 'unavailable', detail: `spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ name, state: 'ready', version: stdout.trim() || undefined })
        } else {
          resolve({
            name,
            state: 'error',
            detail: `exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
          })
        }
      })
    })
  } catch (err) {
    return { name, state: 'unavailable', detail: (err as Error).message }
  } finally {
    release()
  }
}
