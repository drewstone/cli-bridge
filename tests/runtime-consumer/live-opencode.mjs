#!/usr/bin/env node
/** Real Runtime -> local cli-bridge -> OpenCode -> free inference. Never a mock or a fallback. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
const scenario = process.env.CLI_BRIDGE_LIVE_SCENARIO ?? 'filesystem'
const evidenceScenario = scenario === 'evidence'
const timeoutMs = evidenceScenario ? 120_000 : 180_000
const receipt = { schema: 'cli-bridge.live-proof.v1', status: 'failed', model: nativeModel, scenario, stages: [] }
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
  assert.ok(['filesystem', 'evidence'].includes(scenario), 'Select filesystem or evidence; scenarios never run together.')
  assert.match(nativeModel, /^opencode\/[a-z0-9.-]+-free$/, 'Select an explicitly free OpenCode model. No paid model or silent fallback is allowed.')
  if (evidenceScenario) assert.equal(nativeModel, 'opencode/glm-5.3-flash-free', 'The three-turn proof only admits the explicitly authorized anonymous model.')
  assert.equal(process.platform, 'linux', 'This proof requires the existing Linux filesystem jail; it never downgrades confinement.')
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(major > 22 || (major === 22 && minor >= 19), 'The live Runtime proof requires Node 22.19 or newer')
  root = await mkdtemp(join(tmpdir(), 'cli-bridge-live-'))
  evidence = process.env.CLI_BRIDGE_LIVE_OUT ? resolve(process.env.CLI_BRIDGE_LIVE_OUT) : `${root}-evidence`
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
    OPENCODE_TIMEOUT_MS: String(timeoutMs), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_INSTALL_DIR: dirname(dirname(opencode)),
    BRIDGE_JAIL_MODE: 'fs-jail',
    BRIDGE_RAW_CAPTURE_DIR: join(evidence, 'raw'),
  }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (evidenceScenario) {
    // These fields and auxiliary agent overrides are supported by the pinned OpenCode source:
    // https://github.com/anomalyco/opencode/tree/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/v1/config
    // Whitelist one model so a title/summary/compaction cannot select a paid fallback.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: nativeModel, small_model: nativeModel, enabled_providers: ['opencode'],
      provider: { opencode: { whitelist: [nativeModel.slice('opencode/'.length)] } },
      agent: Object.fromEntries(['title', 'summary', 'compaction'].map(name => [name, { model: nativeModel }])),
    })
  }
  receipt.opencodeVersion = (await exec(opencode, ['--version'], { env, cwd: join(root, 'task'), timeout: 20_000 })).stdout.trim()
  receipt.bridgeCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository, timeout: 5_000 })).stdout.trim()
  receipt.nodeVersion = process.version
  if (evidenceScenario) {
    // The installer workflow owns the version pin; do not duplicate its changing value here.
    const workflow = await readFile(join(repository, '.github/workflows/live-inference.yml'), 'utf8')
    const pinnedVersion = /\/opencode\/releases\/download\/v([^/]+)\//.exec(workflow)?.[1]
    assert.ok(pinnedVersion, 'Cannot read the maintained OpenCode installer pin')
    assert.equal(receipt.opencodeVersion, pinnedVersion, 'Use the checksum-pinned OpenCode from the maintained installer')
    const config = JSON.parse((await exec(opencode, ['debug', 'config'], { env, cwd: join(root, 'task'), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout)
    assert.equal(config.model, nativeModel, 'OpenCode changed the selected main model')
    assert.equal(config.small_model, nativeModel, 'OpenCode changed the auxiliary model')
    assert.deepEqual(config.enabled_providers, ['opencode'], 'OpenCode enabled another provider')
    assert.deepEqual(Object.keys(config.provider?.opencode ?? {}).sort(), ['whitelist'], 'Anonymous inference refuses configured provider credentials or endpoint overrides')
    assert.deepEqual(config.provider?.opencode?.whitelist, [nativeModel.slice('opencode/'.length)], 'OpenCode admitted another model')
    for (const name of ['title', 'summary', 'compaction']) assert.equal(config.agent?.[name]?.model, nativeModel, `OpenCode changed the ${name} model`)
    receipt.modelPolicy = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    receipt.scriptSha256 = hash(await readFile(fileURLToPath(import.meta.url)))
  }
  // This is availability, not successful inference. The later filesystem checks prove execution.
  const models = (await exec(opencode, ['models', 'opencode'], { env, cwd: join(root, 'task'), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  const listedModels = models.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  assert.ok(listedModels.includes(nativeModel), `Requested model is absent from OpenCode: ${nativeModel}`)
  if (evidenceScenario) assert.deepEqual(listedModels, [nativeModel], 'OpenCode admitted a fallback model')
  receipt.stages.push({ name: 'model-discovery', status: 'passed' })
  const socket = createServer()
  await new Promise((resolveListen, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolveListen) })
  env.BRIDGE_PORT = String(socket.address().port)
  origin = `http://127.0.0.1:${env.BRIDGE_PORT}`
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()))
  const { createExecutor } = await import('@tangle-network/agent-runtime/kernel')
  const sessionId = `live-${randomUUID()}`
  const profile = {
    name: evidenceScenario ? 'local-evidence-proof' : 'local-inference-proof', harness: 'opencode',
    model: { provider: 'opencode', default: nativeModel.slice('opencode/'.length) },
    ...(evidenceScenario ? {
      tools: { '*': false, read: true },
      prompt: { systemPrompt: 'You are checking fictional test evidence. Use only the read tool and only files in the supplied working directory. Never use shell, network tools, or other directories. Follow the requested JSON response exactly. A figure stated in a source is not a recovery forecast. Do not accept a case or invent outcomes.' },
    } : {}),
  }
  await startBridge()

  const makeExecutor = () => createExecutor({ backend: 'bridge', bridgeUrl: origin, bridgeBearer: bearer,
    cwd: join(root, 'task'), sessionId, timeoutMs,
  })({ profile, harness: null }, { signal: AbortSignal.timeout(evidenceScenario ? 130_000 : 420_000), seams: {} })
  if (!evidenceScenario) executor = makeExecutor()
  async function turn(name, prompt, validate) {
    if (evidenceScenario) executor = makeExecutor()
    const signal = AbortSignal.timeout(timeoutMs)
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
      if (evidenceScenario) {
        stage.model = artifact.out?.model ?? null
        stage.spend = artifact.spent
        stage.toolCalls = artifact.out?.toolCalls ?? null
        assert(artifact.spent?.tokensKnown !== false && artifact.spent?.tokens?.input > 0
          && artifact.spent?.tokens?.output > 0, 'Missing measured input/output token usage')
        assert([nativeModel, nativeModel.slice('opencode/'.length), `opencode/${nativeModel}`].includes(stage.model), 'Observed model does not match requested model')
        assert(typeof artifact.out?.content === 'string' && artifact.out.content.trim(), 'Empty completed answer')
        const json = artifact.out.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        stage.answer = JSON.parse(json)
        validate(stage.answer, artifact)
      }
      stage.status = evidenceScenario ? 'passed' : 'executed'
    } finally {
      try {
        if (evidenceScenario && executor) {
          const cleanup = await executor.teardown(5_000)
          stage.teardown = cleanup
          assert(cleanup.destroyed, 'Runtime could not confirm termination of its owned bridge run')
          executor = undefined
        }
      } catch (error) {
        stage.status = 'failed'
        throw error
      } finally {
        stage.durationMs = Date.now() - started
        stage.eventCount = events.length
        await save(`${name}.json`, { events, artifact: artifact ?? null, stage })
      }
    }
  }
  if (evidenceScenario) {
    const matterCode = randomBytes(16).toString('hex')
    const revisionCode = randomBytes(16).toString('hex')
    const file = join(root, 'task/matter.txt')
    const initial = `FICTIONAL TEST RECORD\nMatter code: ${matterCode}\nAmount claimed: USD 120000\nPossible contractual cap: USD 25000\nOnly an unsigned agreement copy is available. Applicability is unverified. This is not a recovery forecast.\n`
    await writeFile(file, initial, { mode: 0o600 })
    await save('fixture-initial.json', { content: initial, sha256: hash(initial) })
    await turn('01-read', 'Read matter.txt from the working directory using your read tool. Return only JSON: {"matterCode":"exact code from the file","claimed":number,"cap":number,"applicability":"unverified"}.', (answer, artifact) => {
      assert.deepEqual(answer, { matterCode, claimed: 120000, cap: 25000, applicability: 'unverified' })
      assert(artifact.out.toolCalls > 0, 'No observed tool execution for the file read')
    })
    const first = await session(sessionId)
    await save('session-before-restart.json', first)
    await stopBridge()
    await startBridge()
    const restored = await session(sessionId)
    assert.equal(restored.internalId, first.internalId, 'Native session identity must survive bridge restart')
    await turn('02-resume', 'Without using any tools or reading files, repeat only the matterCode from your previous answer as JSON: {"matterCode":"..."}.', (answer, artifact) => {
      assert.deepEqual(answer, { matterCode })
      assert.equal(artifact.out.toolCalls, 0, 'Continuation used a tool instead of retained conversation')
    })
    const updated = initial + `\nNEW SIGNED AMENDMENT\nRevision code: ${revisionCode}\nThe cap for this fictional shipment is amended to USD 50000. Recovery remains unassessed.\n`
    await writeFile(file, updated, { mode: 0o600 })
    await save('fixture-updated.json', { content: updated, sha256: hash(updated) })
    await turn('03-new-evidence', 'matter.txt has changed. Read it again with the read tool. Return only JSON: {"matterCode":"...","revisionCode":"exact new code","previousCap":number,"amendedCap":number,"recovery":"not_assessed"}.', (answer, artifact) => {
      assert.deepEqual(answer, { matterCode, revisionCode, previousCap: 25000, amendedCap: 50000, recovery: 'not_assessed' })
      assert(artifact.out.toolCalls > 0, 'New evidence was not retrieved through an observed tool call')
    })
    const resumed = await session(sessionId)
    assert.equal(resumed.internalId, first.internalId, 'All three turns must use the same native OpenCode session')
    await save('session-after-restart.json', resumed)
    receipt.nativeSessionId = first.internalId
  } else {
    const marker = randomBytes(16).toString('hex')
    const input = randomBytes(64).toString('hex') + '\n'
    await writeFile(join(root, 'task/input.txt'), input, { mode: 0o600 })
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
    receipt.nativeSessionId = first.internalId
    receipt.answerSha256 = hash(await readFile(join(root, 'task/answer.txt')))
    receipt.resumeSha256 = hash(await readFile(join(root, 'task/resume.txt')))
  }
  await stopBridge()
  const traces = await readFile(join(root, 'bridge/traces/spans.jsonl'), 'utf8')
  const spans = traces.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(spans.length >= (evidenceScenario ? 3 : 2), 'Every invocation must leave real trace records')
  await save('spans.jsonl', traces)
  receipt.traceRecords = spans.length
  receipt.scope = 'Local Runtime executor, bridge HTTP/process path, filesystem tools, native session restart/resume, and local trace retention. Not Agent App UI, cloud R2 custody, disaster recovery, or training eligibility.'
  receipt.status = 'passed'
}

try { await main() } catch (error) {
  receipt.error = String(error?.stack ?? error).replaceAll(bearer || '\0', '[redacted]')
  process.exitCode = 1
} finally {
  for (const cleanup of [() => executor?.teardown(5_000), stopBridge]) {
    try { await cleanup() } catch (error) {
      receipt.status = 'failed'
      ;(receipt.cleanupErrors ??= []).push(error.message)
      process.exitCode = 1
    }
  }
  if (ownsEvidence) {
    // Read only this run's preflight and native jail HOME logs, never the operator's HOME.
    let retainedBytes = 0
    for (const directory of ['data/opencode/log', 'task/.agent-home/.local/share/opencode/log']) {
      const logs = join(root, directory)
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
        await save(`opencode-${hash(directory + '/' + entry.name)}.log`, bytes.replaceAll(bearer || '\0', '[redacted]'))
      }
    }
    await save('bridge.log', bridgeLog.replaceAll(bearer || '\0', '[redacted]'))
    await save('receipt.json', receipt)
  }
  // Remove only owned scratch, after confirmed process cleanup and evidence capture.
  if (root && !receipt.cleanupErrors?.length && (!evidence || (evidence !== root && !evidence.startsWith(root + '/')))) {
    try { await rm(root, { recursive: true, force: true }); receipt.scratchRemoved = true }
    catch (error) { receipt.status = 'failed'; receipt.cleanupErrors ??= []; receipt.cleanupErrors.push(error.message); process.exitCode = 1 }
    if (ownsEvidence) await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  }
  console.log(JSON.stringify({ ...receipt, evidenceDirectory: evidence ?? null }, null, 2))
}
