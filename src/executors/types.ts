/**
 * Executor — the abstraction over "how do we spawn a CLI subprocess for
 * a chat() call?".
 *
 * Backends use a `Spawner` rather than calling node's `spawn` directly.
 * That lets us swap in a Docker-backed spawner without each backend
 * caring whether the CLI lives on the host or inside an isolated
 * container.
 *
 *   Spawner = (bin, args, opts) → ChildLike + release()
 *
 * Why async + a `release()` callback?
 *   - Docker variants ACQUIRE a pool slot before spawning. Acquisition
 *     can block waiting for a free slot; that's intrinsically async.
 *   - When the chat() call finishes, the slot must be returned to the
 *     pool. The backend doesn't know about pools, so it just calls
 *     `release()` in its `finally` block.
 *
 * Host (non-pooled) spawners are still trivially async — they wrap
 * node's sync spawn and return a no-op release.
 */

import type { ChildProcess } from 'node:child_process'
import type { JailSpec } from '../jail/index.js'

/** What the spawner produces. Compatible with node's ChildProcess. */
export type SpawnedChild = ChildProcess

/**
 * This executor cannot serve this request as configured — and no retry, backend
 * or model will change that; an operator has to change a setting.
 *
 * Typed rather than a plain Error so the route answers 501 with the message
 * instead of a generic 500: the distinction the caller needs is "the bridge is
 * not set up for this" versus "the bridge broke". The message always names the
 * setting to change.
 */
export class ExecutorConfigurationError extends Error {
  readonly code = 'executor_misconfigured' as const
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorConfigurationError'
  }
}

export interface SpawnOpts {
  /** Working directory inside the executor's filesystem. */
  cwd?: string
  /** Env to set on the child. */
  env?: NodeJS.ProcessEnv
  /** Stdio config — defaults to ['ignore', 'pipe', 'pipe']. */
  stdio?: ['ignore' | 'pipe' | 'inherit', 'pipe' | 'inherit', 'pipe' | 'inherit']
  /** Sticky session id (Docker variant uses this to route to a warm slot). */
  sessionId?: string
  /**
   * Resolved write-jail spec for this spawn. When set, the host and
   * scoped-host spawners wrap `(bin, args)` via `wrapInJail` before
   * spawning and run the wrap's cleanup in `release()`. Absent/null = no
   * jail; the spawn is byte-identical to the unjailed path. Resolved by
   * the chat route (see `resolveJailSpec`); ignored by the Docker spawner,
   * which already provides container-level isolation.
   */
  jail?: JailSpec | null
}

export interface SpawnResult {
  child: SpawnedChild
  /**
   * Terminate the executor-owned workload and wait until it cannot keep
   * running. Host executors kill the child process group; Docker executors
   * recycle the request's exclusive container slot because killing the local
   * `docker exec` client does not stop the process inside the container.
   *
   * Calls are idempotent. Backends MUST await this before `release()` and
   * before returning a terminal response.
   */
  terminate?(): Promise<void>
  /**
   * Release the executor's resources (e.g. pool slot). MUST be called
   * exactly once when the backend's chat() call completes — success,
   * failure, or abort. The implementation is idempotent so double-call
   * is safe but unnecessary.
   */
  release(): void
  /**
   * Returns the spawn-time 'error' event captured by the spawner's
   * synchronous listener, or null if none. Backends MUST check this
   * after the await — Node fires spawn 'error' (ENOENT, EACCES) on
   * process.nextTick, which races the awaiter's microtask. The
   * spawner registers the listener synchronously to prevent uncaught
   * errors from crashing cli-bridge; the backend reads the captured
   * error here to surface it as a BackendError.
   */
  spawnError?(): Error | null
  /**
   * Explain a non-zero exit that the EXECUTOR caused rather than the CLI.
   *
   * The Docker executor runs the CLI through `docker exec`, which returns 127
   * both for "the workdir does not exist inside the container" and for "the
   * binary is not on PATH", and 126 both for "not executable" and "permission
   * denied". Reporting that status as a CLI exit ("opencode exited 127") states
   * a CLI failure for a CLI that never started, and points every reader at the
   * wrong half of the system.
   *
   * Implementations probe the container and return a one-line cause + remedy,
   * or null when the status genuinely came from the CLI — callers then keep
   * their own wording. Host executors do not implement this; `describeCliExit`
   * handles its absence.
   */
  diagnoseExit?(exitCode: number | null, stderr: string): Promise<string | null>
}

/**
 * Build the message for a non-zero CLI exit, giving the executor a chance to
 * replace an ambiguous status with a named cause first.
 *
 * Every subprocess backend ends with the same shape — `<cli> exited <code>:
 * <stderr>` — and that shape is exactly what turns an executor-level failure
 * into a CLI-level accusation. Routing all of them through one helper means a
 * new executor's diagnosis reaches every backend at once, and the fallback is
 * byte-identical to what each backend printed before.
 */
export async function describeCliExit(
  spawned: Pick<SpawnResult, 'diagnoseExit'>,
  label: string,
  exitCode: number | null,
  stderr: string,
): Promise<string> {
  let diagnosis: string | null = null
  try {
    diagnosis = (await spawned.diagnoseExit?.(exitCode, stderr)) ?? null
  } catch {
    // A diagnosis probe that fails must never replace the real failure with its
    // own; fall through to the raw exit message.
  }
  if (diagnosis) return `${label} could not run: ${diagnosis}`
  return `${label} exited ${exitCode}: ${stderr.slice(0, 300)}`
}

/**
 * One observation about an executor, with the action that fixes it.
 *
 * Shared by the startup preflight and the readiness probe so a condition
 * discovered in either place reads the same and carries its own remedy. A
 * finding whose message does not contain what to do about it just moves the
 * guessing somewhere else.
 */
export interface ExecutorFinding {
  /** Stable identifier for the check, e.g. 'auth-mount-credentials'. */
  check: string
  /** What was observed. */
  detail: string
  /** The concrete action that fixes it. */
  remedy: string
}

/** What an executor reports after TAKING the request path. */
export interface ExecutorReadiness {
  /**
   * The directory a request that names no cwd resolves to, under this
   * executor's own policy. A probe must spawn here, because this is where a
   * request spawns.
   */
  cwd: string | undefined
  /** Non-empty means a request would fail. Every entry carries its remedy. */
  findings: ExecutorFinding[]
}

export interface Spawner {
  (bin: string, args: string[], opts: SpawnOpts): Promise<SpawnResult>
  /**
   * Resolve and validate a requested cwd before any backend writes profile or
   * MCP files into it. Docker spawners use this to enforce their bind root.
   *
   * `undefined` in means the CALLER named no directory, and the answer is this
   * executor's own default — not the bridge's working directory. That
   * distinction is the whole point: a backend that pre-filled `process.cwd()`
   * made a request with no cwd indistinguishable from one asking for the
   * bridge's own directory, and the docker executor then refused the request
   * for a path the caller never sent, offering a remedy ("send it without a
   * cwd") the caller had already followed.
   */
  resolveCwd?(cwd: string | undefined): string | undefined
  /**
   * Prove this executor can serve a REQUEST, by taking the request path.
   *
   * The defect this exists to close: readiness used to be a LIST of checks, and
   * what was on the list was one slot, one mount kind, one caller shape. Three
   * items were off it, and the list could not be completed by adding a fourth,
   * because the probe took a path no request could take — `<bin> --version`
   * with no cwd, so the executor's own `resolveCwd` was never called, the
   * workspace assertion every request crosses was skipped, and a
   * credential-independent command answered `ready` for a pool holding no
   * credentials.
   *
   * An implementation must therefore use the SAME cwd policy, the SAME
   * assertions and a REAL slot from the same pool a request would get. Anything
   * a request would hit, this hits first — which is what makes new request-path
   * checks reach /health without anyone remembering to add them.
   *
   * Absent (the host executor) means the executor has no configuration a
   * request can trip over beyond spawning the binary, which `versionHealth`
   * already covers.
   */
  probeRequestPath?(): Promise<ExecutorReadiness>
}

/**
 * Apply an executor's cwd policy before any workspace materialization.
 *
 * An executor that declares `resolveCwd` OWNS the answer, including the
 * no-cwd default and including `undefined` (docker: run in the image's own
 * WORKDIR). Only an executor with no policy — the host spawner — falls back to
 * the directory this process runs in.
 */
export function resolveSpawnerCwd(spawner: Spawner, cwd: string | undefined): string | undefined {
  if (spawner.resolveCwd) return spawner.resolveCwd(cwd)
  return cwd ?? process.cwd()
}

/**
 * Take the request path on behalf of a health probe.
 *
 * Two things happen here, in the order a request does them: the executor's cwd
 * policy runs (its refusal is a readiness finding, not an exception), and the
 * executor's own request-path probe runs against a real slot. The returned
 * `cwd` is what the probe must then spawn in — the same directory a cwd-less
 * request gets — so `/health` cannot pass through a door requests never use.
 */
export async function probeExecutorReadiness(spawner: Spawner): Promise<ExecutorReadiness> {
  if (spawner.probeRequestPath) return await spawner.probeRequestPath()
  try {
    return { cwd: resolveSpawnerCwd(spawner, undefined), findings: [] }
  } catch (error) {
    return { cwd: undefined, findings: [cwdPolicyFinding(error)] }
  }
}

/**
 * An executor that refuses to resolve a cwd-less request is not ready, and the
 * refusal already names the setting to change — so it is reported verbatim
 * rather than restated.
 */
export function cwdPolicyFinding(error: unknown): ExecutorFinding {
  const message = error instanceof Error ? error.message : String(error)
  return {
    check: 'executor-cwd-policy',
    detail: message,
    remedy: 'change the setting named above; a request with no cwd resolves through this same policy',
  }
}

/** One line per finding, so a caller reads the observation and its remedy together. */
export function formatExecutorFindings(findings: ExecutorFinding[]): string {
  return findings.map((f) => `[${f.check}] ${f.detail} — fix: ${f.remedy}`).join('; ')
}
