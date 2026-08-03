import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock } from '../src/runtime/single-instance.js'

const hangingPi = String.raw`#!/usr/bin/env python3
import json
import os
import sys

for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "prompt":
        with open(os.path.join(os.getcwd(), "real-child.pid"), "w", encoding="utf-8") as pid_file:
            pid_file.write(str(os.getpid()))
        print(json.dumps({"id": message.get("id"), "type": "response", "success": True}), flush=True)
        print(json.dumps({"type": "session", "id": "shutdown-session"}), flush=True)
    elif message.get("type") == "abort":
        print(json.dumps({"id": message.get("id"), "type": "response", "success": True}), flush=True)
        break
`

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('free-port probe returned no TCP address')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for server shutdown fixture')
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not exit within ${timeoutMs}ms`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('server shutdown', () => {
  let serverChild: ChildProcess | null = null
  let openSocket: Socket | null = null
  let dir: string | null = null

  afterEach(async () => {
    if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) {
      serverChild.kill('SIGKILL')
      await waitForExit(serverChild, 2_000).catch(() => {})
    }
    serverChild = null
    openSocket?.destroy()
    openSocket = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('waits for a real retained Pi child to terminate and remove its files on SIGTERM', async ({ skip }) => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-server-shutdown-`)
    const piPath = join(dir, 'hanging-pi.py')
    writeFileSync(piPath, hangingPi, { encoding: 'utf8', mode: 0o755 })
    chmodSync(piPath, 0o755)
    let port: number
    try {
      port = await freePort()
    } catch (error) {
      // The managed test sandbox has no network namespace, so a real TCP
      // server cannot be started there. Keep the integration proof active in
      // normal environments and report the environmental skip explicitly.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }
    const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
    const serverEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      USER: process.env.USER ?? 'test',
      LANG: process.env.LANG ?? 'C',
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: dir,
      BRIDGE_BACKENDS: 'pi',
      BRIDGE_DEFAULT_EXECUTOR: 'host',
      PI_EXECUTOR: 'host',
      PI_BIN: piPath,
      PI_TIMEOUT_MS: '5000',
      BRIDGE_TRACE: 'off',
      BRIDGE_JAIL_MODE: 'off',
      BRIDGE_NET_JAIL_MODE: 'off',
    }
    serverChild = spawn(process.execPath, [tsx, 'src/server.ts'], {
      cwd: process.cwd(),
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    serverChild.stdout?.on('data', chunk => { output += chunk.toString() })
    serverChild.stderr?.on('data', chunk => { output += chunk.toString() })
    const base = `http://127.0.0.1:${port}`
    try {
      await waitFor(() => output.includes('listening on http://'), 10_000)
    } catch (error) {
      throw new Error(`retained-child fixture did not start: ${output}`, { cause: error })
    }

    const requestHeaders = { 'content-type': 'application/json', connection: 'close' }
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ id: 'shutdown-session', model: 'pi/test', cwd: dir }),
    })
    expect(created.status).toBe(201)
    const turn = await fetch(`${base}/v1/sessions/shutdown-session/turns`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        message: 'hold the child open',
        run_id: 'shutdown-retained-run',
        execution_id: 'shutdown-retained-execution',
      }),
    })
    expect(turn.status).toBe(202)

    const pidPath = join(dir, 'real-child.pid')
    await waitFor(() => {
      try { return readFileSync(pidPath, 'utf8').trim().length > 0 } catch { return false }
    }, 10_000)
    const childPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    expect(Number.isSafeInteger(childPid)).toBe(true)
    expect(processExists(childPid)).toBe(true)

    const shutdownStarted = Date.now()
    serverChild.kill('SIGTERM')
    const exit = await waitForExit(serverChild, 6_000)
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()
    expect(Date.now() - shutdownStarted).toBeLessThan(5_500)
    await waitFor(() => !processExists(childPid), 2_000)
    expect(output).toContain('SIGTERM — shutting down')
    expect(readdirSync(dir).filter(name => name.startsWith('.cli-bridge-pi-rpc-'))).toEqual([])
  })

  it('rejects a request completed on an existing connection after shutdown starts', async ({ skip }) => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-server-admission-`)
    const dataDir = join(dir, 'data')
    const spawnMarker = join(dir, 'late-child-started')
    const piPath = join(dir, 'must-not-start-pi.sh')
    writeFileSync(piPath, `#!/bin/sh\ntouch ${JSON.stringify(spawnMarker)}\nexit 91\n`, { mode: 0o755 })
    const bootstrapPath = join(dir, 'server-with-shutdown-window.mts')
    const serverModule = join(process.cwd(), 'src/server.ts')
    writeFileSync(bootstrapPath, `
      import { startServer } from ${JSON.stringify(serverModule)}
      void startServer({
        shutdownTimeoutMs: 2_000,
        shutdownHooks: [() => new Promise(resolve => setTimeout(resolve, 600))],
      }).catch(error => {
        console.error(error)
        process.exit(1)
      })
    `)

    let port: number
    try {
      port = await freePort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }

    const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
    serverChild = spawn(process.execPath, [tsx, bootstrapPath], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
        USER: process.env.USER ?? 'test',
        LANG: process.env.LANG ?? 'C',
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(port),
        BRIDGE_DATA_DIR: dataDir,
        BRIDGE_BACKENDS: 'pi',
        BRIDGE_DEFAULT_EXECUTOR: 'host',
        PI_EXECUTOR: 'host',
        PI_BIN: piPath,
        BRIDGE_TRACE: 'off',
        BRIDGE_JAIL_MODE: 'off',
        BRIDGE_NET_JAIL_MODE: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    serverChild.stdout?.on('data', chunk => { output += chunk.toString() })
    serverChild.stderr?.on('data', chunk => { output += chunk.toString() })
    await waitFor(() => output.includes('listening on http://'), 10_000)

    openSocket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    openSocket.on('data', chunk => { response += chunk.toString() })
    await new Promise<void>((resolve, reject) => {
      openSocket?.once('connect', resolve)
      openSocket?.once('error', reject)
    })
    const body = JSON.stringify({
      model: 'pi/test',
      messages: [{ role: 'user', content: 'must not start' }],
      stream: false,
      run_id: 'late-shutdown-run',
    })
    const prefix = body.slice(0, -1)
    openSocket.write([
      'POST /v1/chat/completions HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: keep-alive',
      '',
      prefix,
    ].join('\r\n'))

    serverChild.kill('SIGTERM')
    await waitFor(() => output.includes('SIGTERM — shutting down'), 1_000)
    openSocket.write(body.slice(-1))
    await waitFor(() => response.includes('run_admission_closed'), 1_500)
    expect(response).toContain('HTTP/1.1 503')
    expect(response).toContain('run_admission_closed')
    expect(existsSync(spawnMarker)).toBe(false)

    const exit = await waitForExit(serverChild, 3_000)
    expect(exit).toEqual({ code: 0, signal: null })
  })

  it('forces a bounded exit, closes active sockets, and releases data ownership when a hook hangs', async ({ skip }) => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-server-deadline-`)
    const dataDir = join(dir, 'data')
    const bootstrapPath = join(dir, 'server-with-hanging-hook.mts')
    const serverModule = join(process.cwd(), 'src/server.ts')
    writeFileSync(bootstrapPath, `
      import { startServer } from ${JSON.stringify(serverModule)}
      void startServer({
        shutdownTimeoutMs: 750,
        shutdownHooks: [() => new Promise(() => {})],
      }).catch(error => {
        console.error(error)
        process.exit(1)
      })
    `)

    let port: number
    try {
      port = await freePort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }

    const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
    serverChild = spawn(process.execPath, [tsx, bootstrapPath], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
        USER: process.env.USER ?? 'test',
        LANG: process.env.LANG ?? 'C',
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(port),
        BRIDGE_DATA_DIR: dataDir,
        BRIDGE_BACKENDS: 'pi',
        BRIDGE_DEFAULT_EXECUTOR: 'host',
        PI_EXECUTOR: 'host',
        BRIDGE_TRACE: 'off',
        BRIDGE_JAIL_MODE: 'off',
        BRIDGE_NET_JAIL_MODE: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    serverChild.stdout?.on('data', chunk => { output += chunk.toString() })
    serverChild.stderr?.on('data', chunk => { output += chunk.toString() })
    try {
      await waitFor(
        () => output.includes('listening on http://')
          || serverChild?.exitCode !== null
          || serverChild?.signalCode !== null,
        10_000,
      )
      if (!output.includes('listening on http://')) throw new Error('deadline fixture exited before listening')
    } catch (error) {
      throw new Error(`deadline fixture did not start: ${output}`, { cause: error })
    }

    openSocket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      openSocket?.once('connect', resolve)
      openSocket?.once('error', reject)
    })
    openSocket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`)

    const shutdownStarted = Date.now()
    serverChild.kill('SIGTERM')
    const exit = await waitForExit(serverChild, 2_500)
    expect(exit.code).toBe(1)
    expect(exit.signal).toBeNull()
    expect(Date.now() - shutdownStarted).toBeLessThan(2_000)
    expect(output).toMatch(
      /(?:SIGTERM shutdown deadline reached after 750ms|shutdown completed with 1 cleanup failure)/u,
    )
    if (output.includes('shutdown completed with 1 cleanup failure')) {
      expect(output).toMatch(/shutdown hook \d+ exceeded its \d+ms shutdown budget/u)
    }
    await waitFor(() => openSocket?.destroyed === true, 1_000)

    const replacement = acquireInstanceLock({ port: port + 1, dataDir })
    replacement.release()
  })

  for (const [kind, trigger] of [
    ['uncaughtException', `setTimeout(() => { throw new Error('fatal fixture') }, 150)`],
    ['unhandledRejection', `setTimeout(() => { void Promise.reject(new Error('fatal fixture')) }, 150)`],
  ] as const) it(`shuts down and releases data ownership after ${kind}`, async ({ skip }) => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-server-fatal-`)
    const dataDir = join(dir, 'data')
    const bootstrapPath = join(dir, 'server-with-fatal-error.mts')
    const serverModule = join(process.cwd(), 'src/server.ts')
    writeFileSync(bootstrapPath, `
      import { startServer } from ${JSON.stringify(serverModule)}
      await startServer({ shutdownTimeoutMs: 1_000 })
      ${trigger}
    `)

    let port: number
    try {
      port = await freePort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        skip()
        return
      }
      throw error
    }

    const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
    serverChild = spawn(process.execPath, [tsx, bootstrapPath], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
        USER: process.env.USER ?? 'test',
        LANG: process.env.LANG ?? 'C',
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(port),
        BRIDGE_DATA_DIR: dataDir,
        BRIDGE_BACKENDS: 'pi',
        BRIDGE_DEFAULT_EXECUTOR: 'host',
        PI_EXECUTOR: 'host',
        BRIDGE_TRACE: 'off',
        BRIDGE_JAIL_MODE: 'off',
        BRIDGE_NET_JAIL_MODE: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    serverChild.stdout?.on('data', chunk => { output += chunk.toString() })
    serverChild.stderr?.on('data', chunk => { output += chunk.toString() })

    const exit = await waitForExit(serverChild, 4_000)
    expect(exit).toEqual({ code: 1, signal: null })
    expect(output).toContain(`${kind} — initiating fatal shutdown`)
    expect(output).toContain(`${kind} — shutting down`)

    const replacement = acquireInstanceLock({ port: port + 1, dataDir })
    replacement.release()
  })
})
