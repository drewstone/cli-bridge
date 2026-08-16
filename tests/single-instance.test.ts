import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireDataDirectoryLock,
  acquireInstanceLock,
  DataDirectoryAlreadyBoundError,
  InstanceLockUnavailableError,
  type DataDirectoryLock,
  type InstanceLock,
  PortAlreadyBoundError,
} from '../src/runtime/single-instance.js'

const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

async function stopChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const exited = once(child, 'exit')
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  if (child.exitCode !== null || child.signalCode !== null) return
  await exited
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    await stopChild(child)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-bridge-single-instance-'))
  roots.push(root)
  return root
}

function acquireBridgeLocks(port: number, dataDir: string, portLockDir: string): {
  data: DataDirectoryLock
  port: InstanceLock
  release(): void
} {
  const data = acquireDataDirectoryLock(dataDir)
  try {
    const portLock = acquireInstanceLock(port, portLockDir)
    return {
      data,
      port: portLock,
      release(): void {
        portLock.release()
        data.release()
      },
    }
  } catch (error) {
    data.release()
    throw error
  }
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('test child did not receive a pid')
  await once(child, 'exit')
  return pid
}

async function startLiveHolder(
  port: number,
  dataDir: string,
  portLockDir: string,
): Promise<ChildProcessWithoutNullStreams> {
  const script = `
    import { acquireDataDirectoryLock, acquireInstanceLock } from './src/runtime/single-instance.ts'
    const [portText, dataDir, portLockDir] = process.argv.slice(1)
    const data = acquireDataDirectoryLock(dataDir)
    const port = acquireInstanceLock(Number(portText), portLockDir)
    process.stdout.write('ready\\n')
    const release = () => {
      port.release()
      data.release()
      process.exit(0)
    }
    process.once('SIGTERM', release)
    process.stdin.resume()
  `
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', script, String(port), dataDir, portLockDir],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)
  let output = ''
  let errors = ''
  await new Promise<void>((resolve, reject) => {
    const onOutput = (chunk: Buffer): void => {
      output += chunk.toString()
      if (!output.includes('ready\n')) return
      child.stdout.off('data', onOutput)
      child.off('exit', onExit)
      child.off('error', onError)
      resolve()
    }
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.stdout.off('data', onOutput)
      child.off('error', onError)
      reject(new Error(`lock holder exited before ready: code=${code} signal=${signal} output=${output} error=${errors}`))
    }
    const onError = (error: Error): void => {
      child.stdout.off('data', onOutput)
      child.off('exit', onExit)
      reject(error)
    }
    child.stdout.on('data', onOutput)
    child.once('exit', onExit)
    child.once('error', onError)
  })
  return child
}

describe('single-instance ownership', () => {
  it('blocks two ports from sharing one canonical data directory', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    const portLockDir = join(root, 'ports')
    mkdirSync(portLockDir)
    const first = acquireBridgeLocks(43_401, dataDir, portLockDir)
    try {
      expect(() => acquireBridgeLocks(43_402, dataDir, portLockDir)).toThrow(DataDirectoryAlreadyBoundError)
      expect(() => acquireBridgeLocks(43_402, dataDir, portLockDir)).toThrow(/data directory .* already owned/u)
    } finally {
      first.release()
    }
    expect(existsSync(first.data.path)).toBe(false)
    expect(existsSync(first.port.path)).toBe(false)
  })

  it('keeps the port guard for different data directories', () => {
    const root = tempRoot()
    const portLockDir = join(root, 'ports')
    mkdirSync(portLockDir)
    const first = acquireBridgeLocks(43_403, join(root, 'data-a'), portLockDir)
    try {
      expect(() => acquireBridgeLocks(43_403, join(root, 'data-b'), portLockDir)).toThrow(PortAlreadyBoundError)
    } finally {
      first.release()
    }
  })

  it('uses one canonical path when callers spell the data directory differently', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    const alias = join(root, 'data-alias')
    mkdirSync(dataDir)
    symlinkSync(dataDir, alias, 'dir')
    const first = acquireDataDirectoryLock(alias)
    try {
      expect(first.dataDir).toBe(realpathSync(dataDir))
      expect(() => acquireDataDirectoryLock(dataDir)).toThrow(DataDirectoryAlreadyBoundError)
    } finally {
      first.release()
    }
  })

  it('reclaims a lock only when its valid recorded process is gone', async () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const stalePid = await exitedPid()
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, `${stalePid}\n`, { mode: 0o600 })

    const lock = acquireDataDirectoryLock(dataDir)
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('keeps a live legacy numeric pidfile from being reclaimed', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 })

    expect(() => acquireDataDirectoryLock(dataDir)).toThrow(DataDirectoryAlreadyBoundError)
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('keeps a live JSON pidfile without start identity from being reclaimed', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }) + '\n', { mode: 0o600 })

    expect(() => acquireDataDirectoryLock(dataDir)).toThrow(DataDirectoryAlreadyBoundError)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('uses a process start identity on macOS startup paths', () => {
    const root = tempRoot()
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      const lock = acquireInstanceLock(43_405, root)
      expect(JSON.parse(readFileSync(lock.path, 'utf8'))).toMatchObject({
        pid: process.pid,
        startIdentity: expect.stringContaining('ps:'),
      })
      lock.release()
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })

  it('reclaims a live pid record whose start identity belongs to another process instance', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startIdentity: 'wrong-boot:wrong-start' }) + '\n', { mode: 0o600 })

    const lock = acquireDataDirectoryLock(dataDir)
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('fails closed and preserves an unreadable lock', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, 'not-a-pid\n', { mode: 0o600 })

    expect(() => acquireDataDirectoryLock(dataDir)).toThrow(InstanceLockUnavailableError)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('does not let a second reclaimer race through an active reclamation lease', async () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const stalePid = await exitedPid()
    const lockPath = join(dataDir, '.cli-bridge-data-directory.pid')
    writeFileSync(lockPath, `${stalePid}\n`, { mode: 0o600 })
    writeFileSync(`${lockPath}.reclaim`, `${process.pid}\n`, { mode: 0o600 })

    expect(() => acquireDataDirectoryLock(dataDir)).toThrow(InstanceLockUnavailableError)
    expect(existsSync(lockPath)).toBe(true)

    rmSync(`${lockPath}.reclaim`, { force: true })
    const lock = acquireDataDirectoryLock(dataDir)
    lock.release()
  })

  it('rejects a second live bridge process even when it chooses another port', async () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    const portLockDir = join(root, 'ports')
    mkdirSync(portLockDir)
    const holder = await startLiveHolder(43_404, dataDir, portLockDir)

    expect(() => acquireBridgeLocks(43_405, dataDir, portLockDir)).toThrow(DataDirectoryAlreadyBoundError)

    await stopChild(holder)
    const afterCleanShutdown = acquireBridgeLocks(43_405, dataDir, portLockDir)
    afterCleanShutdown.release()
  })
})
