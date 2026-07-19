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

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ContainerPool } from './container-pool.js'
import { killTree } from './process-tree.js'
import type { SpawnOpts, SpawnResult, Spawner } from './types.js'

const execFileAsync = promisify(execFile)

export interface DockerSpawnerOptions {
  pool: ContainerPool
  /**
   * If the CLI binary lives at a non-standard path inside the
   * container, set this prefix. Most images install /usr/local/bin/...
   * so the default is empty.
   */
  binPrefixInContainer?: string
  /** Host workspace root mounted into each slot at the same path. */
  workspaceRoot?: string
  /** Test-only replacement for the real `docker restart` operation. */
  restartContainer?: (containerId: string) => Promise<void>
  /** Test-only replacement for spawning the local Docker attach client. */
  spawnProcess?: typeof spawn
}

export function createDockerSpawner(opts: DockerSpawnerOptions): Spawner {
  const spawner: Spawner = async (bin, args, spawnOpts) => {
    const cwd = assertDockerWorkspaceCwd(opts.workspaceRoot, spawnOpts.cwd)
    const slot = await opts.pool.acquire(spawnOpts.sessionId)
    let released = false
    let terminationFinished = false
    let terminationPromise: Promise<void> | null = null
    const releaseNow = (): void => {
      if (released) return
      released = true
      slot.release()
    }
    try {
      const dockerArgs = buildDockerExecArgs(
        slot.containerId,
        bin,
        args,
        { ...spawnOpts, ...(cwd ? { cwd } : {}) },
        opts.binPrefixInContainer,
      )
      const child = (opts.spawnProcess ?? spawn)('docker', dockerArgs, {
        stdio: spawnOpts.stdio ?? ['ignore', 'pipe', 'pipe'],
      })
      const terminate = (): Promise<void> => {
        if (terminationPromise) return terminationPromise
        terminationPromise = terminateDockerExecution(
          child,
          slot.containerId,
          opts.restartContainer ?? restartDockerContainer,
        ).then(() => {
          terminationFinished = true
        }).catch((error) => {
          terminationPromise = null
          throw error
        })
        return terminationPromise
      }
      const release = (): void => {
        if (released) return
        if (terminationFinished) {
          releaseNow()
          return
        }
        // A local `docker exec` close is not proof that the command inside
        // the container stopped. Delay slot reuse until executor-owned
        // termination has completed. On failure the slot remains busy and
        // the pool watchdog recycles it instead of routing work into a
        // contaminated container.
        void terminate().then(releaseNow).catch(() => {})
      }
      child.once('close', release)
      child.once('error', release)
      const result: SpawnResult = { child, terminate, release }
      return result
    } catch (err) {
      releaseNow()
      throw err
    }
  }
  spawner.resolveCwd = (cwd) => assertDockerWorkspaceCwd(opts.workspaceRoot, cwd)
  return spawner
}

/**
 * Stop one Docker-backed request with container-level certainty.
 *
 * The local child is only the attached `docker exec` client. Sending it a
 * signal closes the pipes but leaves the actual CLI and its descendants alive
 * inside the container. Each pool slot is exclusive to one request, so an
 * awaited zero-timeout restart is the smallest reliable unit that kills every
 * descendant, including children that created their own process group. Docker
 * restart preserves the container filesystem and mounted authentication data.
 */
export async function terminateDockerExecution(
  child: ChildProcess,
  containerId: string,
  restartContainer: (containerId: string) => Promise<void> = restartDockerContainer,
): Promise<void> {
  const cleanExit = child.exitCode === 0 && child.signalCode === null
  if (!cleanExit) {
    await restartContainer(containerId)
  }
  // Reap the local attach client too. After restart it normally exits on its
  // own; killTree is the bounded fallback and waits for the close event.
  await killTree(child)
}

async function restartDockerContainer(containerId: string): Promise<void> {
  try {
    await execFileAsync('docker', ['restart', '--time', '0', containerId], {
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`docker executor could not terminate container ${containerId}: ${detail}`)
  }
}

/**
 * Fail before acquiring a slot when a request points outside the only host
 * workspace exposed to the container. Calls without cwd (for example
 * `<cli> --version` health checks) run against the container filesystem.
 */
export function assertDockerWorkspaceCwd(
  workspaceRoot: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!workspaceRoot || !cwd) return cwd
  if (!isAbsolute(cwd)) {
    throw new Error(`Docker executor cwd must be absolute when workspace root is configured: ${cwd}`)
  }
  let canonicalCwd: string
  try {
    canonicalCwd = realpathSync(cwd)
  } catch {
    throw new Error(`Docker executor cwd does not exist: ${cwd}`)
  }
  if (!statSync(canonicalCwd).isDirectory()) {
    throw new Error(`Docker executor cwd is not a directory: ${cwd}`)
  }
  const rel = relative(workspaceRoot, canonicalCwd)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Docker executor cwd ${cwd} is outside configured workspace root ${workspaceRoot}`)
  }
  return canonicalCwd
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
