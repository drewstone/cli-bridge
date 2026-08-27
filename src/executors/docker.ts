/** Docker-backed executor: acquire one exclusive container slot per request. */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ContainerPool } from './container-pool.js'
import { dockerCli, type DockerCli } from './docker-cli.js'
import { diagnoseDockerExecFailure, isAmbiguousDockerExit } from './docker-exec-diagnosis.js'
import { preflightDockerSlot, type DockerPreflightTarget } from './docker-preflight.js'
import { killTree } from './process-tree.js'
import { grantPrivateTreeToUid, grantTemporaryTreeToUid } from './private-path-access.js'
import {
  cwdPolicyFinding,
  ExecutorConfigurationError,
  throwIfExecutorAborted,
  type ExecutorFinding,
  type ExecutorReadiness,
  type SpawnResult,
  type Spawner,
} from './types.js'
import { assertDockerWorkspaceCwd, buildDockerExecArgs, type WorkspaceCwdContext } from './docker-paths.js'

export { assertDockerWorkspaceCwd, buildDockerExecArgs, type WorkspaceCwdContext } from './docker-paths.js'

const execFileAsync = promisify(execFile)

export interface DockerSpawnerOptions {
  pool: ContainerPool
  binPrefixInContainer?: string
  pathInContainer?: string
  homeInContainer?: string
  containerUser?: string
  workspaceRoot?: string
  pathMappings?: Array<{ host: string; container: string }>
  backend?: string
  envPrefix?: string
  restartContainer?: (containerId: string) => Promise<void>
  spawnProcess?: typeof spawn
  cli?: DockerCli
  preflightTarget?: (slotIndex: number) => DockerPreflightTarget
}

export function createDockerSpawner(opts: DockerSpawnerOptions): Spawner {
  const naming: WorkspaceCwdContext = {
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.envPrefix ? { envPrefix: opts.envPrefix } : {}),
  }
  const cli = opts.cli ?? dockerCli
  const pathMappings = [
    ...(opts.pathMappings ?? []),
    ...(opts.workspaceRoot ? [{ host: opts.workspaceRoot, container: opts.workspaceRoot }] : []),
  ].map(mapping => ({ host: resolvePath(mapping.host), container: resolvePath(mapping.container) }))
    .sort((a, b) => b.host.length - a.host.length)
  const mapPath = (value: string): string => {
    if (!isAbsolutePath(value)) return value
    const host = resolvePath(value)
    const mapping = pathMappings.find(candidate => host === candidate.host || host.startsWith(`${candidate.host}/`))
    if (!mapping) throw new ExecutorConfigurationError(
      `${naming.backend ?? 'Docker'} cannot expose host-only path ${value} inside the container. ` +
      `Add it to the backend's explicit credential/workspace mounts or set ${naming.envPrefix ?? '<BACKEND>'}_EXECUTOR=host.`,
    )
    return `${mapping.container}${host.slice(mapping.host.length)}`
  }
  const spawner: Spawner = async (bin, args, spawnOpts) => {
    const cwd = assertDockerWorkspaceCwd(opts.workspaceRoot, spawnOpts.cwd, naming)
    const slot = await opts.pool.acquire(spawnOpts.sessionId, spawnOpts.signal)
    let released = false
    let terminationFinished = false
    let terminationPromise: Promise<void> | null = null
    const releaseNow = (): void => { if (!released) { released = true; slot.release() } }
    try {
      throwIfExecutorAborted(spawnOpts.signal)
      const dockerArgs = buildDockerExecArgs(slot.containerId, bin, args, { ...spawnOpts, ...(cwd ? { cwd } : {}) }, opts.binPrefixInContainer, opts.pathInContainer, opts.homeInContainer, mapPath)
      const child = (opts.spawnProcess ?? spawn)('docker', dockerArgs, { stdio: spawnOpts.stdio ?? ['ignore', 'pipe', 'pipe'] })
      let onAbort: (() => void) | undefined
      const terminate = (): Promise<void> => {
        if (terminationPromise) return terminationPromise
        terminationPromise = terminateDockerExecution(child, slot.containerId, opts.restartContainer ?? restartDockerContainer, cli)
          .then(() => { terminationFinished = true; if (onAbort) spawnOpts.signal?.removeEventListener('abort', onAbort) })
          .catch(error => { terminationPromise = null; throw error })
        return terminationPromise
      }
      const release = (): void => {
        if (released) return
        if (terminationFinished) { releaseNow(); return }
        void terminate().then(releaseNow).catch(terminationError => {
          void opts.pool.recycleHeldSlot(slot.containerId).then(
            () => { released = true },
            recycleError => console.error('[cli-bridge] Docker termination and replacement both failed:', { terminationError, recycleError }),
          )
        })
      }
      const startTermination = (): void => { void terminate().catch(() => {}) }
      child.once('close', startTermination)
      child.once('error', startTermination)
      onAbort = (): void => { void terminate() }
      spawnOpts.signal?.addEventListener('abort', onAbort, { once: true })
      if (spawnOpts.signal?.aborted) onAbort()
      const result: SpawnResult = {
        child,
        terminate,
        release,
        diagnoseExit: async (exitCode, stderr) => {
          if (!isAmbiguousDockerExit(exitCode, stderr)) return null
          const diagnosis = await diagnoseDockerExecFailure({
            containerId: slot.containerId, bin, ...(cwd ? { workdir: cwd } : {}), exitCode, stderr,
            ...(opts.envPrefix ? { envPrefix: opts.envPrefix } : {}),
          }, cli)
          if (!diagnosis) return null
          if (diagnosis.cause === 'container-missing' || diagnosis.cause === 'container-not-running') await opts.pool.reportContainerUnusable(slot.containerId).catch(() => {})
          return diagnosis.message
        },
      }
      return result
    } catch (error) {
      releaseNow()
      throw error
    }
  }
  spawner.mapPath = mapPath
  spawner.preparePrivatePath = async path => {
    const runtimePath = mapPath(path)
    const uid = opts.containerUser ? Number(opts.containerUser.split(':')[0]) : null
    if (uid !== null) await grantPrivateTreeToUid(path, uid)
    return runtimePath
  }
  spawner.prepareWorkspacePath = async path => {
    const runtimePath = mapPath(path)
    const uid = opts.containerUser ? Number(opts.containerUser.split(':')[0]) : null
    const access = uid === null ? { cleanup: async () => {} } : await grantTemporaryTreeToUid(path, uid)
    return { path: runtimePath, cleanup: access.cleanup }
  }
  spawner.resolveCwd = cwd => cwd === undefined ? opts.workspaceRoot : assertDockerWorkspaceCwd(opts.workspaceRoot, cwd, naming)
  spawner.probeRequestPath = async (signal?: AbortSignal): Promise<ExecutorReadiness> => {
    throwIfExecutorAborted(signal)
    let cwd: string | undefined
    try { cwd = spawner.resolveCwd!(undefined) }
    catch (error) { return { cwd: undefined, findings: [cwdPolicyFinding(error)] } }
    const preflightTarget = opts.preflightTarget
    if (!preflightTarget) return { cwd, findings: [] }
    const liveContainers = opts.pool.liveContainerIds()
    if (liveContainers.length === 0) return {
      cwd,
      findings: [{ check: 'pool-slots', detail: `the ${naming.backend ?? 'docker'} container pool has no live slot, so every request would fail to acquire one`, remedy: 'check the Docker daemon and the bridge log for the pool recreate attempts' }],
    }
    const perSlot = await Promise.all(liveContainers.map(({ containerId, slotIndex }) => preflightDockerSlot(preflightTarget(slotIndex), containerId, cli, [], { scope: 'request-path', signal })))
    throwIfExecutorAborted(signal)
    return { cwd, findings: perSlot.flat() }
  }
  return spawner
}

export async function terminateDockerExecution(
  child: ChildProcess,
  containerId: string,
  restartContainer: (containerId: string) => Promise<void> = restartDockerContainer,
  cli: DockerCli = dockerCli,
): Promise<void> {
  try { await restartContainer(containerId) }
  catch (error) { if (!isMissingContainerError(error) && await containerStillExists(containerId, cli)) throw error }
  await killTree(child)
}

function isMissingContainerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /No such container|no such object|is not running|marked for removal|is being removed|removal of container/i.test(message)
}

async function containerStillExists(containerId: string, cli: DockerCli): Promise<boolean> {
  const state = await cli(['inspect', '-f', '{{.State.Status}}', containerId])
  if (state.code === 0) return !/^(removing|dead)$/u.test(state.stdout.trim())
  if (state.spawnError) return true
  return !/No such object|No such container/i.test(state.stderr)
}

async function restartDockerContainer(containerId: string): Promise<void> {
  try {
    await execFileAsync('docker', ['restart', '--time', '0', containerId], { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
  } catch (error) {
    throw new Error(`docker executor could not terminate container ${containerId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolvePath(value: string): string {
  return resolve(value)
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value)
}
