/** Spawn a confined host command inside one owned systemd scope. */

import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { sanitizeHostEnv } from './host.js'
import { retryCleanupUntilSuccessful } from './process-tree.js'
import { throwIfExecutorAborted, type Spawner, type SpawnResult } from './types.js'
import {
  currentScopeLimits,
  defaultScopedDependencies,
  scopeControlArgs,
  scopedSemaphore,
  SYSTEMD_RUN_BIN,
  type ScopeStartObservation,
  type ScopedHostSpawnerDependencies,
} from './scoped-host-primitives.js'

export {
  isOwnedScopeControlGroup,
  scopeControlArgs,
  terminateOwnedScope,
} from './scoped-host-primitives.js'
export type {
  ScopeCleanupOperations,
  ScopeLimits,
  ScopeUnitState,
  ScopedHostSpawnerDependencies,
} from './scoped-host-primitives.js'

export function createScopedHostSpawner(overrides: Partial<ScopedHostSpawnerDependencies> = {}): Spawner {
  const dependencies = { ...defaultScopedDependencies, ...overrides }
  return async (bin, args, opts) => {
    const limits = currentScopeLimits()
    if (!dependencies.probe(limits)) return dependencies.fallbackSpawner(bin, args, opts)

    await dependencies.semaphore.acquire(opts.signal)
    let semaphoreReleased = false
    const releaseSemaphore = (): void => {
      if (semaphoreReleased) return
      semaphoreReleased = true
      dependencies.semaphore.release()
    }
    const unitName = `cli-bridge-${process.pid}-${randomBytes(6).toString('hex')}.scope`

    let jailCleanup: (() => Promise<void> | void) | undefined
    let jailed
    try {
      jailed = await dependencies.applyJailFn(bin, args, opts)
      jailCleanup = jailed.cleanup
    } catch (error) {
      releaseSemaphore()
      throw error
    }
    let jailCleaned = jailCleanup === undefined
    const cleanupJail = async (): Promise<void> => {
      if (jailCleaned) return
      await jailCleanup!()
      jailCleaned = true
    }
    const cleanupJailAndRelease = async (): Promise<void> => {
      await cleanupJail()
      releaseSemaphore()
    }
    const rollbackBeforeSpawn = async (error: unknown, context: string): Promise<never> => {
      try {
        await cleanupJailAndRelease()
      } catch (cleanupError) {
        retryCleanupUntilSuccessful(cleanupJailAndRelease)
        throw new AggregateError([error, cleanupError], context)
      }
      throw error
    }
    try {
      throwIfExecutorAborted(opts.signal)
    } catch (error) {
      return await rollbackBeforeSpawn(error, 'scoped host request was cancelled and jail cleanup failed')
    }

    const exactEnvironment = opts.exactEnv
      ? Object.entries(jailed.env ?? {}).filter(([, value]) => typeof value === 'string' && value.length > 0).map(([key, value]) => `${key}=${value}`)
      : []
    const childCommand = opts.exactEnv ? ['/usr/bin/env', '-i', ...exactEnvironment, jailed.bin, ...jailed.args] : [jailed.bin, ...jailed.args]
    let marker: ReturnType<ScopedHostSpawnerDependencies['createMarker']>
    try {
      marker = dependencies.createMarker()
    } catch (error) {
      return await rollbackBeforeSpawn(error, 'scoped host marker creation and jail cleanup failed')
    }
    let markerCleaned = false
    const cleanupMarker = (): void => {
      if (markerCleaned) return
      marker.cleanup()
      markerCleaned = true
    }
    const cleanupOwnedArtifacts = async (): Promise<void> => {
      const failures: unknown[] = []
      try { cleanupMarker() } catch (error) { failures.push(error) }
      try { await cleanupJail() } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'failed to remove scoped host temporary artifacts')
    }
    const cleanupArtifactsAndRelease = async (): Promise<void> => {
      await cleanupOwnedArtifacts()
      releaseSemaphore()
    }
    const wrapped = [
      ...scopeControlArgs(unitName, limits), '--', '/bin/sh', '-c',
      'set -eu; marker=$1; shift; (umask 077; : > "$marker"); exec "$@"',
      'cli-bridge-scope', marker.path, ...childCommand,
    ]

    let child: ChildProcess
    try {
      jailed.verify?.()
      child = dependencies.spawnProcess(SYSTEMD_RUN_BIN, wrapped, {
        stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: opts.exactEnv ? jailed.env : sanitizeHostEnv(jailed.env, opts.cwd),
        detached: true,
      })
    } catch (error) {
      try {
        await cleanupArtifactsAndRelease()
      } catch (cleanupError) {
        retryCleanupUntilSuccessful(cleanupArtifactsAndRelease)
        throw new AggregateError([error, cleanupError], 'scoped host spawn and temporary-artifact cleanup failed')
      }
      throw error
    }

    let spawnError: Error | null = null
    child.on('error', error => { spawnError = error })
    const start = await dependencies.observeStart(child, marker.path, opts.signal).catch(
      (error: unknown): ScopeStartObservation => ({ started: false, error: error instanceof Error ? error : new Error(String(error)) }),
    )
    if (!start.started) {
      let processGroupFailure: unknown
      try { await dependencies.killTreeFn(child) } catch (error) { processGroupFailure = error }
      let scopeFailure: unknown
      try { await dependencies.killScopeFn(unitName) } catch (error) { scopeFailure = error }
      dependencies.invalidateProbe(limits)
      if (scopeFailure !== undefined) {
        const finishUncertainScope = async (): Promise<void> => {
          await dependencies.killScopeFn(unitName)
          await cleanupArtifactsAndRelease()
        }
        retryCleanupUntilSuccessful(finishUncertainScope)
        throw new AggregateError([start.error, processGroupFailure, scopeFailure].filter(Boolean), 'systemd scope start was uncertain and termination could not be proven')
      }
      const failures: unknown[] = [start.error, processGroupFailure].filter(Boolean)
      try { await cleanupArtifactsAndRelease() }
      catch (error) { failures.push(error); retryCleanupUntilSuccessful(cleanupArtifactsAndRelease) }
      throw new AggregateError(failures, 'systemd scope did not confirm workload start; the request was not retried')
    }

    let finalization: Promise<void> | null = null
    let onAbort: (() => void) | undefined
    const finalizeOwnership = (): Promise<void> => {
      if (finalization) return finalization
      const attempt = (async () => {
        let processGroupFailure: unknown
        try { await dependencies.killTreeFn(child) } catch (error) { processGroupFailure = error }
        try { await dependencies.killScopeFn(unitName) }
        catch (scopeError) {
          if (processGroupFailure !== undefined) throw new AggregateError([processGroupFailure, scopeError], `failed to terminate ${unitName}`)
          throw scopeError
        }
        await cleanupOwnedArtifacts()
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
        releaseSemaphore()
      })()
      finalization = attempt
      void attempt.catch(() => { if (finalization === attempt) finalization = null; retryCleanupUntilSuccessful(finalizeOwnership) })
      return attempt
    }
    const release = (): void => {
      void finalizeOwnership().catch(error => console.error(`[cli-bridge] scoped host ${unitName} cleanup failed:`, error))
    }
    const result: SpawnResult = { child, terminate: finalizeOwnership, release, spawnError: () => spawnError }
    onAbort = (): void => { void finalizeOwnership() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    child.once('exit', release)
    child.once('error', release)
    if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(release)
    return result
  }
}

export const scopedHostSpawner: Spawner = createScopedHostSpawner()

export function scopedHostExecutorSnapshot(): { in_flight: number; max: number; queued: number; acquires: number; timeouts: number } {
  return scopedSemaphore.snapshot()
}
