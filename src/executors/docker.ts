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
import { dockerCli, type DockerCli } from './docker-cli.js'
import { diagnoseDockerExecFailure, isAmbiguousDockerExit } from './docker-exec-diagnosis.js'
import { killTree } from './process-tree.js'
import { ExecutorConfigurationError, type SpawnOpts, type SpawnResult, type Spawner } from './types.js'

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
  /** Backend name, quoted in configuration errors: 'opencode', 'claude', … */
  backend?: string
  /** Env-var prefix named in remedies: 'OPENCODE', 'CLAUDE', … */
  envPrefix?: string
  /** Test-only replacement for the real `docker restart` operation. */
  restartContainer?: (containerId: string) => Promise<void>
  /** Test-only replacement for spawning the local Docker attach client. */
  spawnProcess?: typeof spawn
  /** Injectable docker command runner used by exec-failure diagnosis. */
  cli?: DockerCli
}

export function createDockerSpawner(opts: DockerSpawnerOptions): Spawner {
  const naming: WorkspaceCwdContext = {
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.envPrefix ? { envPrefix: opts.envPrefix } : {}),
  }
  const cli = opts.cli ?? dockerCli
  const spawner: Spawner = async (bin, args, spawnOpts) => {
    const cwd = assertDockerWorkspaceCwd(opts.workspaceRoot, spawnOpts.cwd, naming)
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
          cli,
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
        // termination has completed.
        void terminate().then(releaseNow).catch(() => {
          // Termination genuinely failed, so the container may still be running
          // work and must not be reused. Recycling replaces it, which is both
          // safer than reuse and — unlike the old behaviour of leaving the slot
          // busy for the pool watchdog — does not strand the slot for ten
          // minutes. Measured: a swept container made `docker restart` fail
          // here, so the slot was never returned and /health could not recover
          // even though the pool knew how to rebuild it.
          void opts.pool.recycleHeldSlot(slot.containerId)
            .catch(() => {})
            .finally(releaseNow)
        })
      }
      child.once('close', release)
      child.once('error', release)
      const result: SpawnResult = {
        child,
        terminate,
        release,
        /**
         * Name the real cause of an ambiguous `docker exec` status before the
         * backend turns it into a message. Returns null when the status came
         * from the CLI itself, so callers keep their own wording for genuine
         * CLI failures.
         */
        diagnoseExit: async (exitCode, stderr) => {
          if (!isAmbiguousDockerExit(exitCode, stderr)) return null
          const diagnosis = await diagnoseDockerExecFailure({
            containerId: slot.containerId,
            bin,
            ...(cwd ? { workdir: cwd } : {}),
            exitCode,
            stderr,
            ...(opts.envPrefix ? { envPrefix: opts.envPrefix } : {}),
          }, cli)
          if (!diagnosis) return null
          // A vanished or stopped container is repairable: tell the pool so the
          // next request or /health probe gets a fresh container instead of the
          // same dead id for the rest of the process lifetime.
          if (diagnosis.cause === 'container-missing' || diagnosis.cause === 'container-not-running') {
            await opts.pool.reportContainerUnusable(slot.containerId).catch(() => {})
          }
          return diagnosis.message
        },
      }
      return result
    } catch (err) {
      releaseNow()
      throw err
    }
  }
  // A caller that named no directory gets the container-visible workspace, not
  // the bridge's own working directory. Measured before this existed: the
  // backend pre-filled `process.cwd()`, so a cwd-less request was refused with
  // "this request asks to run in /home/drew/code/cli-bridge-preflight" — the
  // bridge's directory — and the remedy it offered ("send it without a cwd")
  // was already what the caller had done. With no workspace mounted the answer
  // is `undefined`: no `--workdir`, so the CLI runs in the image's own WORKDIR.
  spawner.resolveCwd = (cwd) => cwd === undefined
    ? opts.workspaceRoot
    : assertDockerWorkspaceCwd(opts.workspaceRoot, cwd, naming)
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
  cli: DockerCli = dockerCli,
): Promise<void> {
  const cleanExit = child.exitCode === 0 && child.signalCode === null
  if (!cleanExit) {
    try {
      await restartContainer(containerId)
    } catch (error) {
      // A container that no longer exists has nothing left to terminate, so
      // treat it as terminated. Reporting failure here made the caller hold the
      // slot: `docker restart` cannot succeed against a removed container, and
      // the removal is precisely the case the pool must recover from.
      //
      // The wording is checked first because it is free, then CONFIRMED with the
      // daemon, because the wording set was incomplete: a removal in flight says
      // "container is marked for removal and cannot be started", which matched
      // nothing, so a swept container was reported to the caller as a failure to
      // terminate. Asking whether the container is still there does not depend on
      // Docker's phrasing staying the same.
      if (!isMissingContainerError(error) && await containerStillExists(containerId, cli)) throw error
    }
  }
  // Reap the local attach client too. After restart it normally exits on its
  // own; killTree is the bounded fallback and waits for the close event.
  await killTree(child)
}

/**
 * Docker's wording for "that container is not here or is on its way out",
 * across `restart`/`exec`/`inspect`. A fast path only — `terminateDockerExecution`
 * confirms with the daemon when the wording is unfamiliar, because this set was
 * missing the in-flight-removal phrasing and a swept container was therefore
 * reported to the caller as a failure to terminate.
 */
function isMissingContainerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /No such container|no such object|is not running|marked for removal|is being removed|removal of container/i.test(message)
}

/**
 * Ask the daemon whether the container is still present.
 *
 * Fail CLOSED: only a daemon that positively answers "no such object" proves the
 * container is gone. `docker inspect` also fails when the daemon is unreachable
 * or the call times out, and reading that as "gone" would swallow a genuine
 * termination failure — a container that may still be running the caller's work
 * would be silently reused. Unknown therefore means "still exists", so the real
 * error is reported and the slot is recycled.
 */
async function containerStillExists(containerId: string, cli: DockerCli): Promise<boolean> {
  const state = await cli(['inspect', '-f', '{{.State.Status}}', containerId])
  if (state.code === 0) return !/^(removing|dead)$/u.test(state.stdout.trim())
  if (state.spawnError) return true
  return !/No such object|No such container/i.test(state.stderr)
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

export interface WorkspaceCwdContext {
  backend?: string
  envPrefix?: string
}

/**
 * Fail before acquiring a slot when a request's cwd is not a path the container
 * can actually enter. Calls without cwd (for example `<cli> --version` health
 * checks) run against the container filesystem and are always allowed.
 *
 * Two rejections, both of which used to surface as `<cli> exited 127`:
 *
 *   - No workspace is mounted at all, but the request carries a cwd. The
 *     executor would pass `--workdir <host path>` to a container that has never
 *     heard of it; Docker fails with 127 — byte-identical to "command not
 *     found" — and the caller reads it as a broken CLI install. Worse, if the
 *     host path happens to exist inside the image (/tmp, /root), the CLI runs
 *     against the container's throwaway filesystem and the caller's files are
 *     silently discarded. Both outcomes are worse than refusing.
 *   - The cwd resolves outside the configured workspace root, so it is not
 *     inside the bind mount even though a mount exists.
 */
export function assertDockerWorkspaceCwd(
  workspaceRoot: string | undefined,
  cwd: string | undefined,
  ctx: WorkspaceCwdContext = {},
): string | undefined {
  if (!cwd) return cwd
  if (!workspaceRoot) {
    const backend = ctx.backend ?? 'this backend'
    const envKey = `${ctx.envPrefix ?? '<BACKEND>'}_DOCKER_WORKSPACE_ROOT`
    throw new ExecutorConfigurationError(
      `${backend} runs on a Docker executor with no workspace mounted, but this request asks to run in ${cwd}. ` +
        `That directory does not exist inside the container, so the CLI would never start. ` +
        `Set ${envKey} to an absolute host directory containing ${cwd} — the pool bind-mounts it into every ` +
        `container at the identical path — or send requests without a cwd to run against the container filesystem.`,
    )
  }
  if (!isAbsolute(cwd)) {
    throw new ExecutorConfigurationError(`Docker executor cwd must be absolute when workspace root is configured: ${cwd}`)
  }
  let canonicalCwd: string
  try {
    canonicalCwd = realpathSync(cwd)
  } catch {
    throw new ExecutorConfigurationError(`Docker executor cwd does not exist: ${cwd}`)
  }
  if (!statSync(canonicalCwd).isDirectory()) {
    throw new ExecutorConfigurationError(`Docker executor cwd is not a directory: ${cwd}`)
  }
  const rel = relative(workspaceRoot, canonicalCwd)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    const envKey = `${ctx.envPrefix ?? '<BACKEND>'}_DOCKER_WORKSPACE_ROOT`
    throw new ExecutorConfigurationError(
      `Docker executor cwd ${cwd} is outside configured workspace root ${workspaceRoot}, so it is not inside the ` +
        `bind mount the container can see. Set ${envKey} to a host directory containing ${cwd} — it is bind-mounted ` +
        `at the identical path in every pool container — or send the request without a cwd to run in ${workspaceRoot}.`,
    )
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
  'GEMINI_SYSTEM_MD',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'MOONSHOT_API_KEY',
])
