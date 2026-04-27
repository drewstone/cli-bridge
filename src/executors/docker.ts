/**
 * Docker spawner — runs the CLI inside a container slot acquired from a
 * pool. Each call:
 *
 *   1. ContainerPool.acquire(sessionId)        — sticky on session id
 *   2. spawn('docker', ['exec', '-i', ...args]) — stream stdio over the
 *      docker-exec attached pipes
 *   3. when the child closes → release the slot
 *
 * This gives the CLI subprocess full filesystem isolation (per-container
 * /tmp, /home/user, etc.) while keeping the OAuth state mountable from
 * the host. K parallel chat() calls can run on K different containers
 * without stomping on each other's working directories or ~/.tmp scratch.
 */

import { spawn } from 'node:child_process'
import type { ContainerPool } from './container-pool.js'
import type { SpawnOpts, SpawnResult, Spawner } from './types.js'

export interface DockerSpawnerOptions {
  pool: ContainerPool
  /**
   * If the CLI binary lives at a non-standard path inside the
   * container, set this prefix. Most images install /usr/local/bin/...
   * so the default is empty.
   */
  binPrefixInContainer?: string
}

export function createDockerSpawner(opts: DockerSpawnerOptions): Spawner {
  return async (bin, args, spawnOpts) => {
    const slot = await opts.pool.acquire(spawnOpts.sessionId)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      slot.release()
    }
    try {
      const dockerArgs = buildDockerExecArgs(slot.containerId, bin, args, spawnOpts, opts.binPrefixInContainer)
      const child = spawn('docker', dockerArgs, {
        stdio: spawnOpts.stdio ?? ['ignore', 'pipe', 'pipe'],
      })
      child.once('close', release)
      child.once('error', release)
      const result: SpawnResult = { child, release }
      return result
    } catch (err) {
      release()
      throw err
    }
  }
}

/**
 * Compose argv for `docker exec`. Exposed so tests can verify flag
 * composition without a real Docker daemon.
 */
export function buildDockerExecArgs(
  containerId: string,
  bin: string,
  args: string[],
  spawnOpts: SpawnOpts,
  binPrefix = '',
): string[] {
  const out: string[] = ['exec', '-i']
  if (spawnOpts.cwd) {
    out.push('--workdir', spawnOpts.cwd)
  }
  if (spawnOpts.env) {
    for (const [k, v] of Object.entries(spawnOpts.env)) {
      if (typeof v !== 'string' || v.length === 0) continue
      // Filter out obviously-host-only keys that would break things in
      // the container (PATH, HOME, NODE_*). Preserve domain env we
      // actually need passed through.
      if (PROXIED_ENV_KEYS.has(k) || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k.startsWith('CODEX_') || k.startsWith('KIMI_') || k.startsWith('OPENCODE_')) {
        out.push('-e', `${k}=${v}`)
      }
    }
  }
  out.push(containerId, binPrefix ? `${binPrefix}${bin}` : bin, ...args)
  return out
}

const PROXIED_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'MOONSHOT_API_KEY',
])
