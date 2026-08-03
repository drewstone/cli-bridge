import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cli-bridge-installed-check-'))
const packDirectory = join(temporaryRoot, 'pack')
const installPrefix = join(temporaryRoot, 'prefix')
const dataDirectory = join(temporaryRoot, 'data')
const fakePiPath = join(temporaryRoot, 'fake-pi.mjs')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let child
let childExit
let stdout = ''
let stderr = ''

try {
  mkdirSync(packDirectory, { recursive: true })
  writeFileSync(fakePiPath, `#!/usr/bin/env node
import readline from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('pi 0.83.0-fake')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') {
  console.error('fake Pi only supports --mode rpc')
  process.exit(2)
}

const sessionId = 'installed-fake-pi-session'
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  const command = JSON.parse(line)
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'session', id: sessionId })
    send({ type: 'agent_start' })
    send({ type: 'turn_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'installed-pi-terminal' } })
    send({ type: 'turn_end', message: { usage: { input: 1, output: 1 } } })
    send({ type: 'agent_end' })
    send({ type: 'agent_settled' })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId, messageCount: 2 } })
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`, { encoding: 'utf8', mode: 0o755 })
  chmodSync(fakePiPath, 0o755)
  await runCommand(
    'npm',
    ['pack', '--json', '--pack-destination', packDirectory],
    { cwd: root },
  )
  const filename = `${packageJson.name.replace(/^@/u, '').replace('/', '-')}-${packageJson.version}.tgz`
  const tarball = join(packDirectory, filename)
  if (!readFileSync(tarball)) throw new Error(`npm pack did not create ${filename}`)
  await runCommand(
    'npm',
    ['install', '--prefix', installPrefix, '--no-audit', '--no-fund', '--ignore-scripts=false', tarball],
    {
      cwd: temporaryRoot,
      env: { ...process.env, npm_config_ignore_scripts: 'false' },
    },
  )

  const port = await reservePort()
  const executable = join(installPrefix, 'node_modules', '.bin', 'cli-bridge')
  child = spawn(executable, [], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT: String(port),
      BRIDGE_DATA_DIR: dataDirectory,
      BRIDGE_BACKENDS: 'pi',
      BRIDGE_DEFAULT_EXECUTOR: 'host',
      PI_EXECUTOR: 'host',
      PI_BIN: fakePiPath,
      PI_CODING_AGENT_DIR: join(temporaryRoot, 'pi-agent'),
      BRIDGE_JAIL_MODE: 'off',
      BRIDGE_NET_JAIL_MODE: 'off',
      BRIDGE_HEALTH_PROBE_TIMEOUT_MS: '500',
      BRIDGE_TRACE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))

  const capabilities = await waitForJson(
    `http://127.0.0.1:${port}/v1/capabilities?model=pi%2Ftest`,
    15_000,
  )
  if (capabilities.streaming?.replay !== true || capabilities.sessions?.continue !== true) {
    throw new Error('installed CLI capability route did not expose the retained Pi contract')
  }
  const health = await waitForJson(`http://127.0.0.1:${port}/health`, 15_000, true)
  const backends = Array.isArray(health.backends) ? health.backends : []
  const backendNames = backends.map(backend => backend?.name).filter(name => typeof name === 'string')
  const piHealth = backends.find(backend => backend?.name === 'pi')
  if (health.status !== 'ok' || backendNames.length !== 1 || piHealth?.state !== 'ready' || backendNames.includes('sandbox')) {
    throw new Error(`installed CLI health was not Pi-ready without sandbox: ${JSON.stringify(health)}`)
  }

  const session = await postJson(`http://127.0.0.1:${port}/v1/sessions`, {
    id: 'installed-saved-session',
    model: 'pi/test',
    cwd: temporaryRoot,
  })
  if (session.status !== 201 || session.body?.id !== 'installed-saved-session') {
    throw new Error(`installed CLI did not create the saved session: ${JSON.stringify(session)}`)
  }
  const runRequest = {
    message: 'installed check',
    run_id: 'installed-run-exact',
    execution_id: 'installed-execution-exact',
  }
  const turn = await postJson(`http://127.0.0.1:${port}/v1/sessions/installed-saved-session/turns`, runRequest)
  if (turn.status !== 202 || turn.body?.run?.id !== runRequest.run_id || turn.body?.run?.executionId !== runRequest.execution_id) {
    throw new Error(`installed CLI did not preserve the exact run identity: ${JSON.stringify(turn)}`)
  }
  const terminalRun = await waitForJson(`http://127.0.0.1:${port}/v1/runs/${runRequest.run_id}?wait_ms=5000`, 15_000)
  if (terminalRun.id !== runRequest.run_id || terminalRun.executionId !== runRequest.execution_id || terminalRun.sessionId !== 'installed-saved-session' || terminalRun.status !== 'done' || terminalRun.terminal !== true) {
    throw new Error(`installed CLI turn did not reach the exact terminal run: ${JSON.stringify(terminalRun)}`)
  }
  const transcript = await waitForJson(`http://127.0.0.1:${port}/v1/sessions/installed-saved-session/transcript`, 5_000)
  const text = (transcript.messages ?? []).flatMap(message => message.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
  if (text !== 'installed-pi-terminal') {
    throw new Error(`installed CLI terminal text was not exact: ${JSON.stringify(text)}`)
  }

  child.kill('SIGTERM')
  const exit = await Promise.race([
    childExit,
    new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
  ])
  if (!exit || child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    throw new Error('installed bare CLI did not stop after SIGTERM')
  }
  await assertListenerClosed(port)
  console.log(`installed CLI check passed: ${backendNames.length} local defaults, Pi retained route, clean SIGTERM`)
} catch (error) {
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ''}`)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([childExit ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 2_000))])
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not reserve a local port')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
      }
    })
  })
}

async function waitForJson(url, timeoutMs, acceptErrorStatus = false) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error('installed bare CLI exited before it accepted requests')
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok || acceptErrorStatus) return await response.json()
      lastError = new Error(`${url} returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`)
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  return { status: response.status, body: await response.json() }
}

async function assertListenerClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      signal: AbortSignal.timeout(500),
    })
  } catch {
    return
  }
  throw new Error('installed bare CLI left its listener open after shutdown')
}
