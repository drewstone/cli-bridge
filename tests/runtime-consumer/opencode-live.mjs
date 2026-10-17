#!/usr/bin/env node
/** Opt-in real Runtime -> CLI-Bridge -> OpenCode proof. No mock execution path.
 * Run from an installed cli-bridge checkout. See opencode-live.md beside this file.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const exec = promisify(execFile)
const { values } = parseArgs({ options: {
  run: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  model: { type: 'string' },
  out: { type: 'string' },
  'timeout-ms': { type: 'string', default: '120000' },
} })
if (values.help) {
  console.log('node tests/runtime-consumer/opencode-live.mjs [--run] --model <OpenCode provider/model> [--out NEW_DIRECTORY]\nWithout --run: preflight only; no model inference. BRIDGE_URL defaults to http://127.0.0.1:3344. Set BRIDGE_BEARER when required. The exact model is required; there is no fallback.')
  process.exit(0)
}
const timeoutMs = Number(values['timeout-ms'])
assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'timeout-ms must be 1000..600000')
const bridge = new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:3344')
assert(['http:', 'https:'].includes(bridge.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(bridge.hostname)
  && !bridge.username && !bridge.password && !bridge.search && !bridge.hash && bridge.pathname === '/',
  'Use a credential-free loopback BRIDGE_URL origin; this proof runs on the bridge host')
const bearer = process.env.BRIDGE_BEARER || ''
const selected = values.model || process.env.OPENCODE_MODEL || ''
assert(!selected || /^[A-Za-z0-9_.-]+\/[^\s]+$/.test(selected), 'model must be OpenCode provider/model, without the outer bridge prefix')
const evidenceRoot = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), 'cli-bridge-proof-'))
if (values.out) await mkdir(evidenceRoot, { recursive: false, mode: 0o700 })
const hash = value => createHash('sha256').update(value).digest('hex')
const redact = value => bearer ? value.replaceAll(bearer, '[REDACTED]') : value
const save = (name, value) => writeFile(join(evidenceRoot, name), redact(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 })
const report = {
  version: 1, startedAt: new Date().toISOString(), status: 'preflight',
  requestedModel: selected || null, bridgeOrigin: bridge.origin,
  sourceSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  checks: [], turns: [], inferenceCompleted: false,
  scope: 'Synthetic local Runtime/CLI-Bridge/OpenCode execution only. Not Casework, browser, managed sandbox, legal calibration, or containment proof.',
}
async function check(name, fn) {
  try { const detail = await fn(); report.checks.push({ name, ok: true, detail }); return detail }
  catch (error) { report.checks.push({ name, ok: false, error: redact(error.message) }); return null }
}
let activeExecutor, workspace
async function main() {
  await check('node', async () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    assert(major > 22 || (major === 22 && minor >= 13), 'Node 22.13+ required')
    return process.versions.node
  })
  await check('explicit-model', async () => { assert(selected, 'Select an exact provider/model from opencode models; no automatic paid or free fallback'); return selected })
  const bin = process.env.OPENCODE_BIN || 'opencode'
  const cliVersion = await check('opencode-installed', async () => {
    const { stdout } = await exec(bin, ['--version'], { timeout: 15000, maxBuffer: 65536 })
    return stdout.trim()
  })
  if (cliVersion && selected) await check('model-listed', async () => {
    const { stdout } = await exec(bin, ['models'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
    assert(stdout.split(/\r?\n/).map(x => x.trim()).includes(selected), 'Selected model is not in opencode models; no substitution allowed')
    return { selected, catalogueSha256: hash(stdout), pricing: 'not inferred from model name or catalogue presence' }
  })
  const runtimeEntry = await check('installed-runtime', async () => {
    const entry = fileURLToPath(import.meta.resolve('@tangle-network/agent-runtime/kernel'))
    let directory = dirname(entry)
    for (;;) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (pkg.name === '@tangle-network/agent-runtime') { report.runtimeVersion = pkg.version; break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const parent = dirname(directory); assert(parent !== directory, 'Cannot identify installed Runtime version'); directory = parent
    }
    return entry
  })
  await check('bridge-reachable', async () => {
    const response = await fetch(new URL('/health', bridge), {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    assert(response.ok, `Bridge health HTTP ${response.status}`)
    await response.arrayBuffer()
    return { httpStatus: response.status } // Readiness is not inference success.
  })
  if (report.checks.some(item => !item.ok)) {
    report.status = 'blocked'; process.exitCode = 2; return
  }
  if (!values.run) { report.status = 'ready-not-run'; return }

  // Existing published executor, not an OpenAI shim or replacement tool loop.
  const { createExecutor } = await import(pathToFileURL(runtimeEntry).href)
  workspace = await mkdtemp(join(tmpdir(), 'opencode-synthetic-matter-'))
  report.workspace = workspace
  const [provider, ...modelParts] = selected.split('/')
  const profile = {
    name: 'local-opencode-live-proof', harness: 'opencode',
    model: { provider, default: modelParts.join('/') },
    tools: { '*': false, read: true },
    prompt: { systemPrompt: 'You are checking fictional test evidence. Use only the read tool and only files in the supplied working directory. Never use shell, network tools, or other directories. Follow the requested JSON response exactly. A figure stated in a source is not a recovery forecast. Do not accept a case or invent outcomes.' },
  }
  report.profile = profile
  report.sessionId = `local-proof-${randomBytes(12).toString('hex')}`
  const matterCode = randomBytes(16).toString('hex')
  const revisionCode = randomBytes(16).toString('hex')
  const file = join(workspace, 'matter.txt')
  const initial = `FICTIONAL TEST RECORD\nMatter code: ${matterCode}\nAmount claimed: USD 120000\nPossible contractual cap: USD 25000\nOnly an unsigned agreement copy is available. Applicability is unverified. This is not a recovery forecast.\n`
  await writeFile(file, initial, { mode: 0o600 })
  await save('fixture-initial.json', { content: initial, sha256: hash(initial) })
  async function turn(name, prompt, validate) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Local proof deadline exceeded')), timeoutMs + 5000)
    const record = { name, prompt, startedAt: new Date().toISOString(), ok: false }
    report.turns.push(record)
    try {
      activeExecutor = createExecutor({ backend: 'bridge', bridgeUrl: bridge.origin,
        bridgeBearer: bearer, cwd: workspace, sessionId: report.sessionId, timeoutMs,
      })({ profile, harness: null }, { signal: controller.signal, seams: {} })
      const stream = activeExecutor.execute(prompt, controller.signal)
      assert(stream && typeof stream[Symbol.asyncIterator] === 'function', 'Runtime did not return streaming execution')
      let count = 0
      for await (const event of stream) { count++; if (count > 50000) throw new Error('Unbounded event stream') }
      const artifact = activeExecutor.resultArtifact()
      await save(`${name}.json`, { artifact, eventCount: count, assertions: 'evaluated in proof.json' })
      record.eventCount = count
      record.model = artifact.out?.model ?? null
      record.spend = artifact.spent
      record.toolCalls = artifact.out?.toolCalls ?? null
      assert(artifact.spent?.tokensKnown !== false && artifact.spent?.tokens?.input > 0
        && artifact.spent?.tokens?.output > 0, 'Missing measured input/output token usage')
      assert(record.model, 'Missing observed model identity')
      assert([selected, modelParts.join('/'), `opencode/${selected}`].includes(record.model), 'Observed model does not match requested model')
      assert(typeof artifact.out?.content === 'string' && artifact.out.content.trim(), 'Empty completed answer')
      const json = artifact.out.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const answer = JSON.parse(json)
      validate(answer, artifact)
      record.answer = answer; record.ok = true
    } finally {
      clearTimeout(timer)
      // Let Runtime cancel/settle its owned jobs; never kill an unrelated daemon.
      if (activeExecutor) {
        const disposed = activeExecutor; activeExecutor = null
        const cleanup = await disposed.teardown(5000)
        assert(cleanup.destroyed, 'Runtime could not confirm termination of its owned bridge run')
      }
      record.completedAt = new Date().toISOString()
    }
  }
  await turn('01-read', 'Read matter.txt from the working directory using your read tool. Return only JSON: {"matterCode":"exact code from the file","claimed":number,"cap":number,"applicability":"unverified"}.', (answer, artifact) => {
    assert.deepEqual(answer, { matterCode, claimed: 120000, cap: 25000, applicability: 'unverified' })
    assert(artifact.out.toolCalls > 0, 'No observed tool execution for the file read')
  })
  await turn('02-resume', 'Without using any tools or reading files, repeat only the matterCode from your previous answer as JSON: {"matterCode":"..."}.', (answer, artifact) => {
    assert.deepEqual(answer, { matterCode }); assert.equal(artifact.out.toolCalls, 0, 'Continuation used a tool instead of retained conversation')
  })
  const updated = initial + `\nNEW SIGNED AMENDMENT\nRevision code: ${revisionCode}\nThe cap for this fictional shipment is amended to USD 50000. Recovery remains unassessed.\n`
  await writeFile(file, updated, { mode: 0o600 })
  await save('fixture-updated.json', { content: updated, sha256: hash(updated) })
  await turn('03-new-evidence', 'matter.txt has changed. Read it again with the read tool. Return only JSON: {"matterCode":"...","revisionCode":"exact new code","previousCap":number,"amendedCap":number,"recovery":"not_assessed"}.', (answer, artifact) => {
    assert.deepEqual(answer, { matterCode, revisionCode, previousCap: 25000, amendedCap: 50000, recovery: 'not_assessed' })
    assert(artifact.out.toolCalls > 0, 'New evidence was not retrieved through an observed tool call')
  })
  report.status = 'passed'; report.inferenceCompleted = true
}
try { await main() }
catch (error) { report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1 }
finally {
  report.completedAt = new Date().toISOString()
  await save('proof.json', report)
  console.log(JSON.stringify({ status: report.status, inferenceCompleted: report.inferenceCompleted,
    checks: report.checks.map(({ name, ok, error }) => ({ name, ok, ...(error ? { error } : {}) })),
    turns: report.turns.map(({ name, ok }) => ({ name, ok })), proof: join(evidenceRoot, 'proof.json') }, null, 2))
}
