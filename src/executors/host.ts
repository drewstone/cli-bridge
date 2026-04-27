/**
 * Host spawner — node's `spawn` with a no-op release.
 *
 * This is the default for every backend; it preserves the current
 * "spawn the CLI on the host" behavior. Backends that don't opt into a
 * pooled Docker executor get this.
 */

import { spawn } from 'node:child_process'
import type { SpawnOpts, SpawnResult, Spawner } from './types.js'

export const hostSpawner: Spawner = async (bin, args, opts) => {
  const child = spawn(bin, args, {
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: opts.env,
  })
  const result: SpawnResult = {
    child,
    release: () => {},
  }
  return result
}
