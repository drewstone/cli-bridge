import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireInstanceLock,
  DataDirectoryInUseError,
  type InstanceLock,
} from '../src/runtime/single-instance.js'

describe('durable data-directory ownership', () => {
  let root: string | null = null
  let child: ChildProcess | null = null
  const locks: InstanceLock[] = []

  afterEach(async () => {
    for (const lock of locks.splice(0)) lock.release()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child)
    }
    child = null
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('rejects a second real process and releases ownership automatically after SIGKILL', async () => {
    root = mkdtempSync(join(tmpdir(), 'cli-bridge-instance-process-'))
    const dataDir = join(root, 'data')
    const scriptPath = join(root, 'hold-lock.ts')
    const modulePath = join(process.cwd(), 'src/runtime/single-instance.ts')
    writeFileSync(scriptPath, `
      import { acquireInstanceLock } from ${JSON.stringify(modulePath)}
      acquireInstanceLock({ port: Number(process.argv[3]), dataDir: process.argv[2] })
      process.stdout.write('owned\\n')
      setInterval(() => {}, 60_000)
    `)
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
    child = spawn(process.execPath, [tsx, scriptPath, dataDir, '4301'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForOutput(child, 'owned')

    expect(() => acquireInstanceLock({ port: 4302, dataDir })).toThrow(DataDirectoryInUseError)
    let holderPid = 0
    try {
      acquireInstanceLock({ port: 4302, dataDir })
    } catch (error) {
      expect(error).toMatchObject({ requestedPort: 4302 })
      holderPid = (error as DataDirectoryInUseError).holderPid ?? 0
      expect(holderPid).toBeGreaterThan(0)
      expect(holderPid).not.toBe(process.pid)
    }

    process.kill(holderPid, 'SIGKILL')
    await waitForExit(child)
    const replacement = acquireInstanceLock({ port: 4302, dataDir })
    locks.push(replacement)
    expect(replacement.dataDir).toBe(dataDir)
  }, 15_000)

  it('normalizes an existing permissive directory and all ownership files', () => {
    root = mkdtempSync(join(tmpdir(), 'cli-bridge-instance-modes-'))
    const dataDir = join(root, 'data')
    const initial = acquireInstanceLock({ port: 4401, dataDir })
    initial.release()
    chmodSync(dataDir, 0o755)

    const replacement = acquireInstanceLock({ port: 4402, dataDir })
    locks.push(replacement)
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(statSync(replacement.path).mode & 0o777).toBe(0o600)
    expect(statSync(`${replacement.path}.json`).mode & 0o777).toBe(0o600)
  })
})

const CHILD_OUTPUT_WATCHDOG_MS = 10_000
const CHILD_EXIT_WATCHDOG_MS = 5_000

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  let output = ''
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString()
      if (output.includes(expected)) finish()
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(
        `lock holder exited before ${JSON.stringify(expected)} ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      ))
    }
    const timer = setTimeout(() => {
      finish(new Error(
        `lock holder ${child.pid ?? 'unknown'} did not emit ${JSON.stringify(expected)}; ` +
          `state=${child.exitCode ?? child.signalCode ?? 'running'} output=${JSON.stringify(output.slice(-300))}`,
      ))
    }, CHILD_OUTPUT_WATCHDOG_MS)
    if (!child.stdout) {
      finish(new Error('lock holder has no stdout handshake channel'))
      return
    }
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode)
  })
}

function childHasExited(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true
  if (child.pid === undefined) return false
  try {
    process.kill(child.pid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    return false
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error) => finish(error)
    const onExit = () => finish()
    const timer = setTimeout(() => {
      if (childHasExited(child)) finish()
      else finish(new Error(
        `lock holder ${child.pid ?? 'unknown'} did not exit; ` +
          `state=${child.exitCode ?? child.signalCode ?? 'running'}`,
      ))
    }, CHILD_EXIT_WATCHDOG_MS)
    child.once('error', onError)
    child.once('exit', onExit)
    if (childHasExited(child)) onExit()
  })
}
