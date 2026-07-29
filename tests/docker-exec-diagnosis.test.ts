/**
 * Defect 4 — an ambiguous docker exit passed through as a diagnosis.
 *
 * Measured on this host against cli-bridge-cli-runtime:latest:
 *
 *   docker exec -w /workspace/does-not-exist <c> opencode --version  -> 127
 *   docker exec -w /workspace              <c> definitely-not-a-binary -> 127
 *   docker exec -w /workspace              <c> /etc/hostname         -> 126
 *   docker exec                            <removed-c> opencode      -> 1
 *                                          + "No such container: <id>"
 *
 * So `opencode exited 127` names a CLI exit status for a CLI that never
 * started, and reads as "opencode is missing" when opencode is installed and
 * working. Every test here asserts a message that could not have been produced
 * by passing the status through.
 */

import { PassThrough, Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import {
  diagnoseDockerExecFailure,
  isAmbiguousDockerExit,
} from '../src/executors/docker-exec-diagnosis.js'
import type { DockerCli, DockerCliResult } from '../src/executors/docker-cli.js'
import { describeCliExit, type SpawnResult } from '../src/executors/types.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { versionHealth } from '../src/backends/health.js'

const ok = (stdout = ''): DockerCliResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerCliResult => ({ code, stdout: '', stderr })

/**
 * Fake `docker` that answers by argv shape. Defaults describe a perfectly
 * healthy container so each test overrides only the ONE thing it is about.
 */
function fakeDocker(overrides: {
  running?: boolean
  containerExists?: boolean
  dirs?: string[]
  paths?: string[]
  binaryPath?: string | null
  executable?: boolean
} = {}): { cli: DockerCli; calls: string[][] } {
  const {
    running = true,
    containerExists = true,
    dirs = ['/workspace'],
    paths = ['/workspace'],
    binaryPath = '/usr/local/bin/opencode',
    executable = true,
  } = overrides
  const calls: string[][] = []
  const cli: DockerCli = async (args) => {
    calls.push(args)
    if (args[0] === 'inspect') {
      if (!containerExists) return fail(`Error: No such object: ${args[3]}`)
      return ok(running ? 'true\n' : 'false\n')
    }
    if (args[0] === 'exec') {
      const rest = args.slice(1)
      if (rest[1] === 'test' && rest[2] === '-d') return dirs.includes(rest[3]!) ? ok() : fail('')
      if (rest[1] === 'test' && rest[2] === '-e') return paths.includes(rest[3]!) ? ok() : fail('')
      if (rest[1] === 'test' && rest[2] === '-x') return executable ? ok() : fail('')
      const script = rest[rest.length - 1] ?? ''
      if (script.includes('command -v')) return binaryPath ? ok(`${binaryPath}\n`) : fail('', 1)
      if (script.includes('id -u')) return ok('0\n/usr/local/bin:/usr/bin\n')
    }
    return ok()
  }
  return { cli, calls }
}

describe('isAmbiguousDockerExit — only docker-layer statuses are re-examined', () => {
  it('treats 125/126/127 and container-level stderr as ambiguous, and a CLI status as its own', () => {
    expect(isAmbiguousDockerExit(127, '')).toBe(true)
    expect(isAmbiguousDockerExit(126, '')).toBe(true)
    expect(isAmbiguousDockerExit(125, '')).toBe(true)
    // Exit 1 is a plausible CLI status, so the TEXT has to carry the signal.
    expect(isAmbiguousDockerExit(1, 'Error response from daemon: No such container: 20e4aee6')).toBe(true)
    expect(isAmbiguousDockerExit(1, 'opencode: authentication required')).toBe(false)
    expect(isAmbiguousDockerExit(2, 'usage: opencode [options]')).toBe(false)
    expect(isAmbiguousDockerExit(null, '')).toBe(false)
  })
})

describe('diagnoseDockerExecFailure — names which of the 127 causes actually holds', () => {
  it('reports a missing workdir as a missing workdir, with the env var that mounts it', async () => {
    const { cli } = fakeDocker({ dirs: ['/workspace'], paths: ['/workspace'] })
    const d = await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890',
      bin: 'opencode',
      workdir: '/workspace/does-not-exist',
      exitCode: 127,
      stderr: 'OCI runtime exec failed: chdir to cwd ("/workspace/does-not-exist") ... no such file or directory',
      envPrefix: 'OPENCODE',
    }, cli)

    expect(d?.cause).toBe('workdir-missing')
    expect(d?.message).toContain('/workspace/does-not-exist does not exist inside container abcdef123456')
    // The whole point: state that the CLI never ran, and that 127 is docker's.
    expect(d?.message).toContain('the CLI never started')
    expect(d?.message).toContain('exit 127 came from docker exec, not from opencode')
    expect(d?.message).toContain('OPENCODE_DOCKER_WORKSPACE_ROOT')
  })

  it('reports a missing binary as a missing binary — the OTHER cause of the same 127', async () => {
    const { cli } = fakeDocker({ binaryPath: null })
    const d = await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890',
      bin: 'opencode',
      workdir: '/workspace',
      exitCode: 127,
      stderr: 'OCI runtime exec failed: exec: "opencode": executable file not found in $PATH',
      envPrefix: 'OPENCODE',
    }, cli)

    expect(d?.cause).toBe('binary-missing')
    expect(d?.message).toContain('opencode is not on PATH inside container abcdef123456')
    expect(d?.message).toContain('pnpm run docker:build:runtime')
  })

  it('reports a vanished container as vanished, not as a CLI failure', async () => {
    const { cli } = fakeDocker({ containerExists: false })
    const d = await diagnoseDockerExecFailure({
      containerId: '20e4aee6c0ffee00',
      bin: 'opencode',
      exitCode: 1,
      stderr: 'Error response from daemon: No such container: 20e4aee6c0ffee00',
      envPrefix: 'OPENCODE',
    }, cli)

    expect(d?.cause).toBe('container-missing')
    expect(d?.message).toContain('pool container 20e4aee6c0ff no longer exists')
    expect(d?.message).toContain('recreates a vanished slot')
  })

  it('reports a stopped container distinctly from a removed one', async () => {
    const { cli } = fakeDocker({ running: false })
    const d = await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890', bin: 'opencode', exitCode: 126, stderr: 'is not running',
    }, cli)
    expect(d?.cause).toBe('container-not-running')
  })

  it('reports a non-executable binary distinctly (the 126 pair)', async () => {
    const { cli } = fakeDocker({ executable: false })
    const d = await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890', bin: 'opencode', workdir: '/workspace', exitCode: 126, stderr: 'permission denied',
    }, cli)
    expect(d?.cause).toBe('binary-not-executable')
  })

  it('returns null when every docker-layer precondition holds, so a real CLI status is not overwritten', async () => {
    const { cli } = fakeDocker()
    const d = await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890', bin: 'opencode', workdir: '/workspace', exitCode: 127, stderr: 'opencode: internal',
    }, cli)
    expect(d).toBeNull()
  })

  it('probes the container BEFORE the workdir, so a dead container is not blamed on a path', async () => {
    const { cli, calls } = fakeDocker({ containerExists: false })
    await diagnoseDockerExecFailure({
      containerId: 'abcdef1234567890', bin: 'opencode', workdir: '/workspace/x', exitCode: 127, stderr: '',
    }, cli)
    expect(calls[0]?.[0]).toBe('inspect')
    expect(calls.some((c) => c.includes('-d'))).toBe(false)
  })
})

describe('describeCliExit — the message every backend produces', () => {
  it('uses the executor diagnosis when there is one', async () => {
    const message = await describeCliExit(
      { diagnoseExit: async () => 'workdir /workspace/x does not exist inside container abc123' },
      'opencode',
      127,
      'OCI runtime exec failed',
    )
    expect(message).toBe('opencode could not run: workdir /workspace/x does not exist inside container abc123')
    expect(message).not.toContain('exited 127')
  })

  it('falls back to the raw exit line for a host executor, unchanged', async () => {
    expect(await describeCliExit({}, 'opencode', 2, 'bad flag')).toBe('opencode exited 2: bad flag')
  })

  it('never lets a failing diagnosis probe replace the real failure', async () => {
    const message = await describeCliExit(
      { diagnoseExit: async () => { throw new Error('docker unreachable') } },
      'opencode', 127, 'OCI runtime exec failed',
    )
    expect(message).toBe('opencode exited 127: OCI runtime exec failed')
  })
})

/** Minimal ChildProcess stand-in that closes with a given status. */
function childExiting(code: number, stderrText: string): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess & { stdout: Readable; stderr: PassThrough }
  const stderr = new PassThrough()
  emitter.stdout = Readable.from([]) as never
  ;(emitter as unknown as { stderr: PassThrough }).stderr = stderr
  ;(emitter as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(emitter as unknown as { pid: number }).pid = 4242
  ;(emitter as unknown as { kill: () => boolean }).kill = () => true
  setImmediate(() => {
    stderr.write(stderrText)
    stderr.end()
    emitter.emit('close', code)
  })
  return emitter
}

describe('the message a caller actually receives', () => {
  const missingWorkdirSpawn = async (): Promise<SpawnResult> => ({
    child: childExiting(127, 'OCI runtime exec failed: chdir to cwd ("/workspace/gone") failed'),
    release: () => {},
    diagnoseExit: async (exitCode, stderr) =>
      (await diagnoseDockerExecFailure({
        containerId: 'abcdef1234567890',
        bin: 'opencode',
        workdir: '/workspace/gone',
        exitCode,
        stderr,
        envPrefix: 'OPENCODE',
      }, fakeDocker({ dirs: ['/workspace'], paths: ['/workspace'] }).cli))?.message ?? null,
  })

  it('OpencodeBackend surfaces the workdir cause, not "opencode exited 127"', async () => {
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: missingWorkdirSpawn })
    await expect(async () => {
      for await (const _ of backend.chat(
        { model: 'opencode/zai-coding-plan/glm-5.2', messages: [{ role: 'user', content: 'hi' }] },
        null,
        new AbortController().signal,
      )) { /* drain */ }
    }).rejects.toThrow(/opencode could not run: --workdir \/workspace\/gone does not exist inside container/)
  })

  it('/health reports the cause too — this is where a swept container read as `exit 1: No such container`', async () => {
    const health = await versionHealth('opencode', 'opencode', async () => ({
      child: childExiting(1, 'Error response from daemon: No such container: 20e4aee6c0ffee00'),
      release: () => {},
      diagnoseExit: async (exitCode, stderr) =>
        (await diagnoseDockerExecFailure({
          containerId: '20e4aee6c0ffee00', bin: 'opencode', exitCode, stderr, envPrefix: 'OPENCODE',
        }, fakeDocker({ containerExists: false }).cli))?.message ?? null,
    }))
    expect(health.state).toBe('error')
    expect(health.detail).toContain('pool container 20e4aee6c0ff no longer exists')
    expect(health.detail).toContain('recreates a vanished slot')
  })
})
