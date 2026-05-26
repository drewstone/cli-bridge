/**
 * Per-task diagnostics — Pillar 0 of the resilience plan (docs/resilience-plan.md).
 *
 * Every CLI subprocess the bridge spawns emits ONE structured record when it
 * ends: exit code + signal, WHY it was killed (timeout / client-abort /
 * request-end / shutdown), duration, and the cwd (which carries the caller's
 * workspace id, so a VerticalBench cell can be correlated). This turns the
 * client-side black box — every failure surfacing only as "finished with error"
 * — into an attributable cause histogram. Instrumented at the executor
 * chokepoint (host spawner) so it covers ALL backends uniformly, not per-backend.
 *
 * Hard rule: diagnostics MUST NEVER affect task execution. Every path here is
 * best-effort and swallows its own errors — a full disk or a bad path can slow
 * forensics but can never fail a run.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type TaskTermination = 'exit' | 'killed' | 'spawn-error'

export interface TaskDiagnostic {
  /** ISO timestamp when the record was written (task end). */
  ts: string
  /** Harness binary (e.g. 'claude', 'opencode'). */
  bin: string
  /** Working dir — carries the caller's workspace id for cell correlation. */
  cwd: string | null
  pid: number | null
  durationMs: number
  /** Process exit code (null when terminated by signal). */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM' = our killTree), else null. */
  signal: string | null
  /** WHY killTree fired, when known: 'timeout' | 'client-abort' |
   *  'request-end' | 'shutdown'. Null = natural exit or unattributed. */
  killReason: string | null
  termination: TaskTermination
}

// undefined = unresolved; string = path; null = disabled.
let cachedPath: string | null | undefined

function resolveDiagnosticsPath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const explicit = process.env.BRIDGE_DIAGNOSTICS_FILE?.trim()
  if (explicit && explicit.toLowerCase() === 'off') {
    cachedPath = null
    return cachedPath
  }
  const dataDir = process.env.BRIDGE_DATA_DIR?.trim() || './data'
  cachedPath = explicit || resolve(dataDir, 'diagnostics.ndjson')
  return cachedPath
}

/** Reset the cached path — tests only. */
export function _resetDiagnosticsPathForTests(): void {
  cachedPath = undefined
}

/** Append one task diagnostic as an NDJSON line. Best-effort; never throws. */
export function recordTaskDiagnostic(rec: TaskDiagnostic): void {
  const path = resolveDiagnosticsPath()
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(rec) + '\n')
  } catch {
    // Forensics are best-effort — never let a diagnostics write break a task.
  }
}
