#!/usr/bin/env node
/** Real Runtime -> local cli-bridge -> OpenCode -> free inference. Never a mock or a fallback. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const nativeModel = process.env.CLI_BRIDGE_LIVE_MODEL ?? 'opencode/glm-5.3-flash-free'
const receipt = { schema: 'cli-bridge.live-proof.v1', status: 'failed', model: nativeModel, stages: [] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let root, evidence, child, childClosed, childOutcome, bearer = '', bridgeLog = '', origin, env
let ownsEvidence = false
let executor

async function save(name, value) {
  await writeFile(join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
async function binary() {
  const candidates = process.env.OPENCODE_BIN ? [process.env.OPENCODE_BIN] : [
    join(homedir(), '.opencode/bin/opencode'),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'opencode')),
  ]
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return resolve(path) } catch {}
  }
  throw new Error('OpenCode is not installed. Install it or set OPENCODE_BIN to the actual executable; no inference ran.')
}
async function request(path) {
  const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000), redirect: 'error' })
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
  return response.json()
}
async function startBridge() {
  childOutcome = undefined
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(repository, 'src/server.ts')], {
    cwd: join(root, 'task'), env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  childClosed = new Promise(resolveClose => {
    child.once('error', error => { childOutcome = { error: error.message }; resolveClose(childOutcome) })
    child.once('close', (code, signal) => { childOutcome = { code, signal }; resolveClose(childOutcome) })
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    bridgeLog = (bridgeLog + bytes.toString()).slice(-256 * 1024)
  })
  const deadline = Date.now() + 45_000
  let last = 'not ready'
  while (Date.now() < deadline) {
    if (childOutcome) throw new Error(`Bridge exited before readiness: ${JSON.stringify(childOutcome)}; ${bridgeLog.slice(-4000)}`)
    try { await request('/health'); return } catch (error) { last = error.message }
    await delay(200)
  }
  throw new Error(`Bridge did not become ready: ${last}; ${bridgeLog.slice(-4000)}`)
}
async function stopBridge() {
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const closed = await Promise.race([childClosed.then(() => true), delay(8_000, undefined, { ref: false }).then(() => false)])
    if (!closed) {
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await childClosed
    }
  }
  child = undefined
}
async function session(id) {
  const listing = await request('/v1/sessions?limit=500')
  const row = listing.data.find(value => value.externalId === id && value.backend === 'opencode')
  assert.ok(row?.internalId, 'A native OpenCode session mapping must be retained')
  return row
}

async function main() {
  assert.equal(process.env.CLI_BRIDGE_REAL_OPENCODE_TESTS, '1', 'Opt in with CLI_BRIDGE_REAL_OPENCODE_TESTS=1; this invokes a real external model.')
  assert.match(nativeModel, /^opencode\/[a-z0-9.-]+-free$/, 'Select an explicitly free OpenCode model. No paid model or silent fallback is allowed.')
  assert.equal(process.platform, 'linux', 'This proof requires the existing Linux filesystem jail; it never downgrades confinement.')
  root = await mkdtemp(join(tmpdir(), 'cli-bridge-live-'))
  evidence = process.env.CLI_BRIDGE_LIVE_OUT ? resolve(process.env.CLI_BRIDGE_LIVE_OUT) : join(root, 'evidence')
  await mkdir(evidence, { mode: 0o700 }) // Existing evidence is never overwritten.
  ownsEvidence = true
  for (const name of ['home', 'task', 'data', 'config', 'cache', 'state', 'bridge']) await mkdir(join(root, name), { mode: 0o700 })
  const opencode = await binary()
  bearer = randomBytes(32).toString('hex')
  // Fresh environment, no host auth, no managed Tangle endpoints, and a narrow task workspace.
  env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'),
    LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', CI: '1',
    XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: bearer, BRIDGE_DATA_DIR: join(root, 'bridge'),
    BRIDGE_BACKENDS: 'opencode', OPENCODE_EXECUTOR: 'host', OPENCODE_BIN: opencode,
    OPENCODE_TIMEOUT_MS: '180000', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_INSTALL_DIR: dirname(dirname(opencode)),
    BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_ROOT: '.',
    BRIDGE_JAIL_RW_PATHS: ['data', 'config', 'cache', 'state'].map(name => join(root, name)).join(','),
    BRIDGE_RAW_CAPTURE_DIR: join(evidence, 'raw'),
  }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  receipt.opencodeVersion = (await exec(opencode, ['--version'], { env, timeout: 20_000 })).stdout.trim()
  receipt.bridgeCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository, timeout: 5_000 })).stdout.trim()
  receipt.nodeVersion = process.version
  // This is availability, not successful inference. The later filesystem checks prove execution.
  const models = (await exec(opencode, ['models', 'opencode'], { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  assert.ok(models.split(/\r?\n/).map(value => value.trim()).includes(nativeModel), `Requested model is absent from OpenCode: ${nativeModel}`)
  receipt.stages.push({ name: 'model-discovery', status: 'passed' })
  const socket = createServer()
  await new Promise((resolveListen, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolveListen) })
  env.BRIDGE_PORT = String(socket.address().port)
  origin = `http://127.0.0.1:${env.BRIDGE_PORT}`
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()))
  const { createExecutor } = await import('@tangle-network/agent-runtime/kernel')
  const sessionId = `live-${randomUUID()}`
  const profile = { name: 'local-inference-proof', harness: 'opencode', model: { provider: 'opencode', default: nativeModel.slice('opencode/'.length) } }
  const marker = randomBytes(16).toString('hex')
  const input = randomBytes(64).toString('hex') + '\n'
  await writeFile(join(root, 'task/input.txt'), input, { mode: 0o600 })
  await startBridge()

  executor = createExecutor({ backend: 'bridge', bridgeUrl: origin, bridgeBearer: bearer,
    cwd: join(root, 'task'), sessionId, timeoutMs: 180_000,
  })({ profile, harness: null }, { signal: AbortSignal.timeout(420_000), seams: {} })
  async function turn(name, prompt) {
    const signal = AbortSignal.timeout(180_000)
    const events = []
    const stage = { name, status: 'failed', eventCount: 0 }
    receipt.stages.push(stage)
    const started = Date.now()
    let artifact
    try {
      const stream = executor.execute(prompt, signal)
      assert.ok(stream?.[Symbol.asyncIterator], 'Runtime must return a real streamed execution')
      for await (const event of stream) {
        assert.ok(events.length < 10_000, 'Live proof exceeded its event bound')
        events.push(event)
      }
      artifact = executor.resultArtifact()
      assert.notEqual(artifact.verdict?.valid, false, 'Runtime reported an invalid result')
      stage.status = 'executed'
    } finally {
      stage.durationMs = Date.now() - started
      stage.eventCount = events.length
      await save(`${name}.json`, { events, artifact: artifact ?? null })
    }
  }
  await turn('filesystem-task', `Work only in your current directory. Read input.txt with a tool and compute the SHA-256 of its exact bytes using a command. Create answer.txt containing only the 64-character hexadecimal digest and a newline. Do not change input.txt. Remember this conversation marker for our next turn: ${marker}. Do not write the marker to any file. Reply briefly when finished.`)
  assert.equal(await readFile(join(root, 'task/input.txt'), 'utf8'), input, 'The task input must remain unchanged')
  assert.equal((await readFile(join(root, 'task/answer.txt'), 'utf8')).trim(), hash(input), 'The model must really compute the independently checked digest')
  const first = await session(sessionId)
  await save('session-before-restart.json', first)
  receipt.stages.at(-1).status = 'passed'

  // Restart the actual server; do not replay the first prompt to manufacture continuity.
  await stopBridge()
  await startBridge()
  const restored = await session(sessionId)
  assert.equal(restored.internalId, first.internalId, 'Native session identity must survive bridge restart')
  await turn('session-resume', 'Continue our previous conversation. Write its conversation marker, and nothing else except a newline, to resume.txt in the current directory. Do not read any other files or use search to find the marker; use your conversation context. Reply briefly when done.')
  assert.equal((await readFile(join(root, 'task/resume.txt'), 'utf8')).trim(), marker, 'Resume must retain context without replaying the first prompt')
  const resumed = await session(sessionId)
  assert.equal(resumed.internalId, first.internalId, 'Resume must use the same native OpenCode session')
  receipt.stages.at(-1).status = 'passed'
  await save('session-after-restart.json', resumed)
  await stopBridge()
  const traces = await readFile(join(root, 'bridge/traces/spans.jsonl'), 'utf8')
  const spans = traces.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(spans.length >= 2, 'Both invocations must leave real trace records')
  await save('spans.jsonl', traces)
  receipt.nativeSessionId = first.internalId
  receipt.traceRecords = spans.length
  receipt.answerSha256 = hash(await readFile(join(root, 'task/answer.txt')))
  receipt.resumeSha256 = hash(await readFile(join(root, 'task/resume.txt')))
  receipt.scope = 'Local Runtime executor, bridge HTTP/process path, filesystem tools, native session restart/resume, and local trace retention. Not Agent App UI, cloud R2 custody, disaster recovery, or training eligibility.'
  receipt.status = 'passed'
}

try { await main() } catch (error) {
  receipt.error = String(error?.stack ?? error).replaceAll(bearer || '\0', '[redacted]')
  process.exitCode = 1
} finally {
  for (const cleanup of [() => executor?.teardown(), stopBridge]) {
    try { await cleanup() } catch (error) {
      receipt.status = 'failed'
      ;(receipt.cleanupErrors ??= []).push(error.message)
      process.exitCode = 1
    }
  }
  if (ownsEvidence) {
    // Only this run's fresh native log directory, never the operator's HOME.
    const logs = join(root, 'data/opencode/log')
    let retainedBytes = 0
    for (const entry of await readdir(logs, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      if (!entry.isFile()) continue
      const path = join(logs, entry.name)
      const size = (await stat(path)).size
      if (size > 2 * 1024 * 1024 || retainedBytes + size > 4 * 1024 * 1024) continue
      const bytes = await readFile(path, 'utf8')
      retainedBytes += size
      await save(`opencode-${hash(entry.name)}.log`, bytes.replaceAll(bearer || '\0', '[redacted]'))
    }
    await save('bridge.log', bridgeLog.replaceAll(bearer || '\0', '[redacted]'))
    await save('receipt.json', receipt)
  }
  console.log(JSON.stringify({ ...receipt, evidenceDirectory: evidence ?? null }, null, 2))
}
