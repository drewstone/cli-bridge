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
  })

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

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  let output = ''
  child.stdout?.on('data', chunk => { output += chunk.toString() })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (output.includes(expected)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`lock holder exited before ${JSON.stringify(expected)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${JSON.stringify(expected)}`)
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('lock holder did not exit')), 2_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
