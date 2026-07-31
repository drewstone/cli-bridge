import type { BackendHealth } from './types.js'
import type { Spawner } from '../executors/types.js'

/**
 * `<bin> --version` exit-code health probe, shared by the spawner-based
 * backends. A zero exit → `ready` with the first `--version` line as the
 * reported version; a non-zero exit → `error` with the captured stderr;
 * a spawn failure (ENOENT/EACCES) → `unavailable`. The spawner's slot is
 * always released.
 */
export async function versionHealth(
  name: string,
  bin: string,
  spawner: Spawner,
): Promise<BackendHealth> {
  let release = (): void => {}
  try {
    const spawned = await spawner(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    release = spawned.release
    const child = spawned.child
    const early = spawned.spawnError?.()
    if (early) return { name, state: 'unavailable', detail: `spawn failed: ${early.message}` }
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
          resolve({ name, state: 'error', detail: `exit ${code}: ${(stderr || stdout).slice(0, 200)}` })
        }
      })
    })
  } catch (err) {
    return { name, state: 'unavailable', detail: (err as Error).message }
  } finally {
    release()
  }
}
