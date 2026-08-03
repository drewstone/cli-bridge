import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cli-bridge-source-install-'))
const checkout = join(temporaryRoot, 'checkout')
const fakePi = join(temporaryRoot, 'pi')
let server
let serverExit
let stdout = ''
let stderr = ''

try {
  cpSync(sourceRoot, checkout, {
    recursive: true,
    filter: path => !['node_modules', 'dist', '.git', '.pnpm-store'].includes(path.split('/').at(-1)),
  })
  writeFileSync(fakePi, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('pi 0.83.0-source-install-check')
  process.exit(0)
}
process.exit(2)
`, { mode: 0o755 })
  chmodSync(fakePi, 0o755)

  await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts=false'], checkout)
  await run(process.execPath, [
    '-e',
    "const Database = require('better-sqlite3'); new Database(':memory:').close()",
  ], checkout)
  await run('pnpm', ['build'], checkout)
  const executable = join(checkout, 'dist', 'cli.js')
  if (!existsSync(executable)) throw new Error('clean source install did not produce dist/cli.js')

  const port = await reservePort()
  server = spawn(process.execPath, [executable], {
    cwd: checkout,
    env: {
      ...process.env,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: join(temporaryRoot, 'data'),
      BRIDGE_BACKENDS: 'pi',
      BRIDGE_DEFAULT_EXECUTOR: 'host',
      PI_EXECUTOR: 'host',
      PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: join(temporaryRoot, 'pi-agent'),
      BRIDGE_JAIL_MODE: 'off',
      BRIDGE_NET_JAIL_MODE: 'off',
      BRIDGE_TRACE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', chunk => { stdout += chunk.toString() })
  server.stderr.on('data', chunk => { stderr += chunk.toString() })
  serverExit = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })))

  const health = await waitForJson(`http://127.0.0.1:${port}/health`, 20_000)
  const pi = Array.isArray(health.backends)
    ? health.backends.find(backend => backend?.name === 'pi')
    : null
  if (health.status !== 'ok' || pi?.state !== 'ready') {
    throw new Error(`clean source service was not Pi-ready: ${JSON.stringify(health)}`)
  }

  server.kill('SIGTERM')
  const stopped = await Promise.race([
    serverExit,
    new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
  ])
  if (!stopped) throw new Error('clean source service did not stop after SIGTERM')
  console.log('source install check passed: clean copy built, started dist/cli.js, and reported ready')
} catch (error) {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  throw new Error(`${error instanceof Error ? error.message : String(error)}${output ? `\n${output}` : ''}`)
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL')
    await Promise.race([serverExit ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 2_000))])
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let commandStdout = ''
    let commandStderr = ''
    child.stdout.on('data', chunk => { commandStdout += chunk.toString() })
    child.stderr.on('data', chunk => { commandStderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(
        `${command} ${args.join(' ')} exited ${code}: ` +
          `${[commandStdout.trim(), commandStderr.trim()].filter(Boolean).join('\n')}`,
      ))
    })
  })
}

async function reservePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('could not reserve a source-check port')
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error(`${url} did not become ready`)
}
