/**
 * Found by removing pool containers under a SATURATED pool on the fixed build,
 * which is the fault the pool exists to survive. Same class again: one failure
 * wearing another failure's message.
 *
 * Measured, live, 2 of 6 concurrent requests:
 *
 *   HTTP 500
 *   {"error":{"message":"docker executor could not terminate container c604960…:
 *     Command failed: docker restart --time 0 c604960…
 *     Error response from daemon: Cannot restart container c604960…:
 *     container is marked for removal and cannot be started","type":"server_error"}}
 *
 * Two defects in that one body:
 *
 *   1. The container had been REMOVED, which is the thing the pool recovers
 *      from. `terminateDockerExecution` recognised removal only by the strings
 *      "No such container" / "no such object" / "is not running"; Docker's
 *      wording while a removal is in flight is "marked for removal and cannot be
 *      started", so the removal was reported as a failure to terminate.
 *   2. A CLEANUP failure replaced the request's own outcome. The backend awaits
 *      termination in its `finally`, so a throw there discarded whatever the CLI
 *      had produced and answered with a message about `docker restart` — a
 *      sentence in which nothing the caller sent appears.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { terminateDockerExecution } from '../src/executors/docker.js'
import { terminateSpawned } from '../src/executors/process-tree.js'
import type { SpawnResult } from '../src/executors/types.js'
import type { DockerCli } from '../src/executors/docker-cli.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'

const stores: SessionStore[] = []
const tempDirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function child(code: number, stdoutText: string): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess
  const stderr = new PassThrough()
  ;(c as unknown as { stdout: Readable }).stdout = Readable.from(stdoutText ? [stdoutText] : [])
  ;(c as unknown as { stderr: PassThrough }).stderr = stderr
  ;(c as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(c as unknown as { pid: number }).pid = 4242
  ;(c as unknown as { kill: () => boolean }).kill = () => true
  ;(c as unknown as { exitCode: number | null }).exitCode = null
  setImmediate(() => {
    stderr.end()
    ;(c as unknown as { exitCode: number | null }).exitCode = code
    c.emit('close', code)
  })
  return c
}

/** Docker's real wording while a container removal is in flight. */
const MARKED_FOR_REMOVAL =
  'Command failed: docker restart --time 0 c60496099aaa\n' +
  'Error response from daemon: Cannot restart container c60496099aaa: ' +
  'container is marked for removal and cannot be started\n'

describe('a removed container is not reported as a failure to terminate', () => {
  it('treats "marked for removal" as already terminated', async () => {
    const gone: DockerCli = async (args) =>
      args[0] === 'inspect'
        ? { code: 1, stdout: '', stderr: 'Error: No such object: c60496099aaa' }
        : { code: 0, stdout: '', stderr: '' }

    await expect(terminateDockerExecution(
      child(137, ''),
      'c60496099aaa',
      async () => { throw new Error(MARKED_FOR_REMOVAL) },
      gone,
    )).resolves.toBeUndefined()
  })

  it('confirms with Docker instead of trusting the wording, when the wording is new', async () => {
    // A message this code has never seen before must not become the caller's
    // answer just because a substring did not match. Ask whether the container
    // is still there; absent means the work is over.
    const gone: DockerCli = async (args) =>
      args[0] === 'inspect'
        ? { code: 1, stdout: '', stderr: 'Error: No such object: c60496099aaa' }
        : { code: 0, stdout: '', stderr: '' }

    await expect(terminateDockerExecution(
      child(137, ''),
      'c60496099aaa',
      async () => { throw new Error('some future docker phrasing nobody has seen') },
      gone,
    )).resolves.toBeUndefined()
  })

  it('still reports a genuine termination failure on a container that IS running', async () => {
    const running: DockerCli = async (args) =>
      args[0] === 'inspect'
        ? { code: 0, stdout: 'true\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }

    await expect(terminateDockerExecution(
      child(137, ''),
      'c60496099aaa',
      async () => { throw new Error('docker daemon refused the restart') },
      running,
    )).rejects.toThrow(/refused the restart/)
  })
})

describe('a cleanup failure is not the answer to the request', () => {
  it('terminateSpawned reports a failed termination without rejecting into the response path', async () => {
    const spawned = {
      child: child(0, ''),
      release: () => {},
      terminate: async () => { throw new Error('docker executor could not terminate container c60496099aaa') },
    } as unknown as SpawnResult

    await expect(terminateSpawned(spawned)).resolves.toBeUndefined()
  })

  it('keeps the CLI outcome when termination fails after a successful run', async () => {
    // The live shape: the CLI finished, the container was swept, and the caller
    // received a 500 about `docker restart` instead of the completion.
    const app = new Hono()
    const spawner = (async () => ({
      child: child(0, `${JSON.stringify({ type: 'message.completed', text: 'answer' })}\n`),
      release: () => {},
      terminate: async () => {
        throw new Error('docker executor could not terminate container c60496099aaa: container is marked for removal')
      },
    })) as never
    const registry = new BackendRegistry().register(
      new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-termination-store-'))
    tempDirs.push(dir)
    const sessions = new SessionStore(dir)
    stores.push(sessions)
    mountChatCompletions(app, { registry, sessions, runs: new RunRegistry({}) })

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode/zai-coding-plan/glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const json = await res.json() as any

    expect(res.status).toBe(200)
    expect(json.choices[0].message.content).toBe('answer')
    expect(JSON.stringify(json)).not.toMatch(/could not terminate/)
  })
})
