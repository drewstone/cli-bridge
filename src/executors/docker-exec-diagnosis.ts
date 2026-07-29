/**
 * Turn an ambiguous `docker exec` failure into a named cause.
 *
 * `docker exec` returns 127 for BOTH "the workdir does not exist" and "the
 * binary is not on PATH", and 126 for both "not executable" and "permission
 * denied". Measured on this host against the runtime image:
 *
 *   docker exec -w /workspace/does-not-exist <c> opencode --version  -> 127
 *   docker exec -w /workspace              <c> not-a-binary          -> 127
 *   docker exec -w /workspace              <c> /etc/hostname         -> 126
 *   docker exec                            <removed-c> opencode      -> 1
 *                                          + "No such container: <id>"
 *
 * Passing that status through as `<cli> exited 127` states a CLI exit status
 * for a CLI that never started. It reads as "the CLI is broken or missing"
 * and sends the reader to the wrong half of the system — four rounds of
 * misdiagnosis on 2026-07-29, while `opencode --version` worked one `docker
 * exec` away.
 *
 * So: before any 125/126/127 (or a container-level stderr signature) reaches a
 * caller, probe the container for which of the possible causes actually holds,
 * and report THAT plus its remedy. The probes are single `docker exec`s against
 * an already-running container and only run on the failure path.
 */

import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'

export type DockerExecCause =
  | 'container-missing'
  | 'container-not-running'
  | 'workdir-missing'
  | 'workdir-not-directory'
  | 'binary-missing'
  | 'binary-not-executable'

export interface DockerExecDiagnosis {
  cause: DockerExecCause
  /** What was observed, in plain terms. */
  detail: string
  /** The concrete action that fixes it, or null when the bridge fixes it itself. */
  remedy: string | null
  /** Single-line rendering: cause + detail + remedy. Safe to embed in a BackendError. */
  message: string
}

export interface DockerExecFailureContext {
  containerId: string
  /** The binary argv[0] the executor passed to `docker exec`. */
  bin: string
  /** The `--workdir` the executor passed, if any. */
  workdir?: string | undefined
  /** Exit status observed from the local `docker exec` client. */
  exitCode: number | null
  /** Whatever the client wrote to stderr. */
  stderr: string
  /**
   * Env-var prefix for this backend ('OPENCODE', 'CLAUDE', …) so a remedy can
   * name the exact setting to change instead of describing it.
   */
  envPrefix?: string | undefined
}

/**
 * Container-level stderr signatures. `docker exec` against a removed container
 * exits 1 — a status a CLI could plausibly return — so the text is the only
 * discriminator and must be part of the trigger, not just the status.
 */
const CONTAINER_LEVEL_STDERR = /No such container|is not running|OCI runtime exec failed|error during connect|Cannot connect to the Docker daemon/i

/**
 * Whether this failure could be a docker-layer failure wearing a CLI-layer
 * status. 125 = docker client error, 126 = found but not executable,
 * 127 = not found (workdir OR binary). Anything else is the CLI's own status
 * and must be passed through untouched.
 */
export function isAmbiguousDockerExit(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 125 || exitCode === 126 || exitCode === 127) return true
  return CONTAINER_LEVEL_STDERR.test(stderr)
}

/**
 * Probe the container and name the cause. Returns null when every probe passes,
 * which means the status really did come from the CLI — callers then keep their
 * original message rather than substituting a guess.
 */
export async function diagnoseDockerExecFailure(
  ctx: DockerExecFailureContext,
  cli: DockerCli = dockerCli,
): Promise<DockerExecDiagnosis | null> {
  const shortId = ctx.containerId.slice(0, 12)

  // 1. Is the container still there and running? Ordered first because every
  //    later probe is meaningless (and misleading) against a dead container.
  const state = await cli(['inspect', '-f', '{{.State.Running}}', ctx.containerId])
  if (state.code !== 0) {
    return finish({
      cause: 'container-missing',
      detail:
        `pool container ${shortId} no longer exists, so the CLI never started ` +
        `(docker: ${firstLine(state.stderr) || 'no such object'})`,
      remedy:
        'the pool now recreates a vanished slot on the next acquire; if this repeats, ' +
        'something outside the bridge is removing containers (check `docker ps -a` and any prune job)',
    }, ctx)
  }
  if (state.stdout.trim() !== 'true') {
    return finish({
      cause: 'container-not-running',
      detail: `pool container ${shortId} exists but is not running, so the CLI never started`,
      remedy: 'the pool now recreates a stopped slot on the next acquire; check `docker logs ' + shortId + '` for why it exited',
    }, ctx)
  }

  // 2. Does the workdir exist inside the container? This is the cause that
  //    masquerades as "command not found".
  if (ctx.workdir) {
    const isDir = await cli(['exec', ctx.containerId, 'test', '-d', ctx.workdir])
    if (isDir.code !== 0) {
      const exists = await cli(['exec', ctx.containerId, 'test', '-e', ctx.workdir])
      const workspaceEnv = ctx.envPrefix ? `${ctx.envPrefix}_DOCKER_WORKSPACE_ROOT` : '<BACKEND>_DOCKER_WORKSPACE_ROOT'
      return finish(exists.code === 0
        ? {
            cause: 'workdir-not-directory',
            detail: `--workdir ${ctx.workdir} exists inside container ${shortId} but is not a directory, so the CLI never started`,
            remedy: `point the request cwd at a directory under ${workspaceEnv}`,
          }
        : {
            cause: 'workdir-missing',
            detail:
              `--workdir ${ctx.workdir} does not exist inside container ${shortId}, so the CLI never started ` +
              `(docker reports this as exit 127, the same status as "command not found")`,
            remedy:
              `mount that path into the container: set ${workspaceEnv} to an absolute host directory ` +
              `containing ${ctx.workdir} — the pool bind-mounts it at the identical path`,
          }, ctx)
    }
  }

  // 3. Does the binary resolve for the user `docker exec` actually runs as?
  //    Resolved with the container's own PATH, not the host's.
  const which = await cli(containerShell(ctx.containerId, `command -v ${shellQuote(ctx.bin)} || exit 1`))
  const resolved = which.stdout.trim()
  if (which.code !== 0 || !resolved) {
    const id = await cli(containerShell(ctx.containerId, 'id -u; printf %s "$PATH"'))
    return finish({
      cause: 'binary-missing',
      detail:
        `${ctx.bin} is not on PATH inside container ${shortId} for the user docker exec runs as ` +
        `(${compact(id.stdout) || 'identity unknown'})`,
      remedy:
        'rebuild the runtime image so it contains that CLI: `pnpm run docker:build:runtime`' +
        (ctx.envPrefix ? `, or point ${ctx.envPrefix}_DOCKER_IMAGE at an image that has it` : ''),
    }, ctx)
  }
  const executable = await cli(['exec', ctx.containerId, 'test', '-x', resolved])
  if (executable.code !== 0) {
    return finish({
      cause: 'binary-not-executable',
      detail: `${resolved} inside container ${shortId} is not executable by the user docker exec runs as`,
      remedy: 'rebuild the runtime image (`pnpm run docker:build:runtime`) so the CLI is installed with an executable mode',
    }, ctx)
  }

  // Every docker-layer precondition holds, so the status came from the CLI.
  return null
}

function finish(
  parts: { cause: DockerExecCause; detail: string; remedy: string | null },
  ctx: DockerExecFailureContext,
): DockerExecDiagnosis {
  const statusNote = ctx.exitCode === null ? '' : ` — exit ${ctx.exitCode} came from docker exec, not from ${ctx.bin}`
  return {
    ...parts,
    message: `${parts.detail}${statusNote}.${parts.remedy ? ` Fix: ${parts.remedy}.` : ''}`,
  }
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

function compact(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
}

/** Single-quote for `sh -c`. The bin comes from config, but a probe must not be an injection point. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
