/**
 * One place that runs `docker` and never throws.
 *
 * The pool, the startup preflight and the exec-failure diagnosis all need to
 * ask Docker questions where a non-zero exit is an ANSWER, not an exception
 * (`docker image inspect` on a missing image, `docker exec test -d` on a
 * missing workdir). `execFile` rejects on non-zero, which forces every caller
 * to unwrap an error to read a status code and loses stderr in the process —
 * that unwrapping is how a docker-layer failure ends up wearing a CLI-layer
 * message. Returning a plain `{ code, stdout, stderr }` record keeps the
 * distinction between "the command ran and said no" and "docker is not
 * reachable" visible to the caller.
 */

import { execFile } from 'node:child_process'

export interface DockerCliResult {
  /** Process exit status. 127 when the `docker` binary itself is absent. */
  code: number
  stdout: string
  stderr: string
  /** Set when the invocation failed without producing an exit status (spawn error, timeout). */
  spawnError?: string
}

export type DockerCli = (args: string[], opts?: { timeoutMs?: number }) => Promise<DockerCliResult>

const DEFAULT_TIMEOUT_MS = 20_000

export const dockerCli: DockerCli = (args, opts = {}) =>
  new Promise<DockerCliResult>((resolve) => {
    execFile(
      'docker',
      args,
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number') {
          resolve({ code, stdout, stderr })
          return
        }
        // ENOENT (no docker binary), ETIMEDOUT, or a signal kill: no exit
        // status exists, so report it as one rather than inventing a code.
        resolve({ code: -1, stdout, stderr, spawnError: error.message })
      },
    )
  })

/**
 * Shell out inside a container. `sh -c` (not `-lc`) so the probe sees exactly
 * the environment `docker exec` gives the CLI — a login shell would source
 * profile scripts the real invocation never runs, and a probe that tests a
 * different environment than production is worse than no probe.
 */
export function containerShell(containerId: string, script: string, asRoot = false): string[] {
  const args = ['exec']
  if (asRoot) args.push('-u', '0:0')
  args.push(containerId, 'sh', '-c', script)
  return args
}
