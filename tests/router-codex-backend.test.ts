import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { CodexBackend } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { sanitizeHostEnv } from '../src/executors/host.js'
import type { SpawnOpts, Spawner } from '../src/executors/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

const KEYS = ['BRIDGE_ROUTER_RECEIPTS_REQUIRED', 'TANGLE_ROUTER_URL', 'TANGLE_API_KEY',
  'BRIDGE_LAUNCH_RECORD_DIR', 'BRIDGE_HEALTH_READY_CACHE_TTL_MS', 'TANGLE_ROUTER_CREDENTIAL'] as const
let root: string
let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
  root = mkdtempSync(join(tmpdir(), 'router-codex-backend-'))
  Object.assign(process.env, {
    BRIDGE_ROUTER_RECEIPTS_REQUIRED: '1', TANGLE_ROUTER_URL: 'https://router.tangle.tools/v1',
    TANGLE_API_KEY: 'test-router-secret', BRIDGE_LAUNCH_RECORD_DIR: root,
    BRIDGE_HEALTH_READY_CACHE_TTL_MS: '0', TANGLE_ROUTER_CREDENTIAL: 'stale-daemon-key',
  })
})
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

function request(execution = 'execution-1', search = false): ChatRequest {
  return { model: 'codex/tangle/openai/gpt-5.1-codex', messages: [{ role: 'user', content: 'do the thing' }],
    cwd: root, mode: 'byob', environment_id: 'environment-1', session_id: 'session-1', execution_id: execution,
    metadata: { router_web_search: search } }
}
async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const result: ChatDelta[] = []
  for await (const delta of stream) result.push(delta)
  return result
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}
function fixture(options: { version?: string; spawnError?: boolean; errorEvent?: boolean; omitTerminal?: boolean; corruptEvidence?: boolean; terminateFails?: boolean } = {}) {
  const modelCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv; opts: SpawnOpts }> = []
  let probes = 0
  let releases = 0
  let terminations = 0
  const spawner: Spawner = async (_bin, args, opts) => {
    let activeDirectory: string | undefined
    const versionProbe = args.length === 1 && args[0] === '--version'
    if (versionProbe) probes++
    else {
      modelCalls.push({ args: [...args], env: sanitizeHostEnv(opts.env, opts.cwd) ?? {}, opts })
      if (options.spawnError) throw new Error('fixture model spawn failure')
      const provider = JSON.parse(args.find(arg => arg.startsWith('model_provider = '))!.slice('model_provider = '.length))
      activeDirectory = readdirSync(root).filter(name => /^[a-f0-9-]{36}$/u.test(name)).find(name =>
        JSON.parse(readFileSync(join(root, name, 'launch.json'), 'utf8')).inference.nativeProvider === provider)!
      assert.equal(JSON.parse(readFileSync(join(root, activeDirectory, 'launch.json'), 'utf8')).status, 'prepared')
    }
    const child = new FakeChild()
    const finish = (): void => {
      child.exitCode = 0
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0)
    }
    const timer = setTimeout(() => {
      if (versionProbe) child.stdout.write(`${options.version ?? 'codex-cli 0.155.0'}\n`)
      else {
        child.stdout.write('{"type":"thread.started","thread_id":"native-private-thread"}\n')
        child.stdout.write('{"type":"item.completed","item":{"type":"command_execution","id":"tool-1","command":"echo hi"}}\n')
        if (options.errorEvent) child.stdout.write('{"type":"error","message":"refused"}\n')
        if (!options.omitTerminal) child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n')
        if (options.corruptEvidence) {
          writeFileSync(join(root, activeDirectory!, 'launch.json.tmp'), 'blocked')
        }
      }
      finish()
    }, 5)
    return { child: child as never, spawnError: () => null, release: () => { releases++ },
      terminate: async () => {
        terminations++
        if (options.terminateFails) throw new Error('fixture scope stop failed')
        clearTimeout(timer)
        finish()
      } }
  }
  spawner.executionEnvironment = 'host'
  spawner.resolveCwd = () => root
  const backend = new CodexBackend({ bin: '/usr/local/bin/codex', timeoutMs: 0, spawner })
  return { backend, spawner, modelCalls, probes: () => probes, releases: () => releases, terminations: () => terminations }
}
function records(): Array<Record<string, any>> {
  return readdirSync(root).filter(name => /^[a-f0-9-]{36}$/u.test(name))
    .map(name => JSON.parse(readFileSync(join(root, name, 'launch.json'), 'utf8')))
}

describe('CodexBackend receipt-required launch path', () => {
  it('launches with Router headers and the filtered child key, and writes the effective record before inference', async () => {
    const f = fixture()
    const deltas = await collect(f.backend.chat(request(), null, new AbortController().signal))
    assert.equal(f.probes(), 1)
    assert.equal(f.modelCalls.length, 1)
    assert.equal(f.releases(), 2)
    assert.equal(f.terminations(), 1)
    const call = f.modelCalls[0]!
    assert.equal(call.env.TANGLE_ROUTER_CREDENTIAL, 'test-router-secret')
    assert.equal(process.env.TANGLE_ROUTER_CREDENTIAL, 'stale-daemon-key')
    const provider = call.args.find(arg => arg.startsWith('model_providers.tangle_receipt_'))!
    for (const value of ['https://router.tangle.tools/v1', 'x-tangle-environment-id', 'environment-1',
      'x-tangle-session-id', 'session-1', 'x-tangle-execution-id', 'execution-1']) assert.ok(provider.includes(value))
    assert.equal(call.args.at(-1), 'do the thing')
    assert.ok(call.args.includes('model = "openai/gpt-5.1-codex"'))
    // Verified against codex-cli 0.155.0: it refuses the legacy config-profile pair,
    // and an unrecognized override must fail rather than spend unattributed tokens.
    assert.ok(call.args.includes('--strict-config'))
    assert.ok(!call.args.some(arg => arg.startsWith('profile')))
    // One owner for the route: no second `model_provider` from the split wire id.
    assert.equal(call.args.filter(arg => arg.startsWith('model_provider =')).length, 1)
    assert.ok(!call.args.includes('model_provider="tangle"'))
    assert.ok(!call.args.includes('model="openai/gpt-5.1-codex"'))
    assert.ok(!call.args.join('\n').includes('test-router-secret'))
    assert.ok(deltas.some(delta => delta.internal_session_id === 'native-private-thread'))
    const record = records()[0]!
    assert.equal(record.harnessVersion, 'codex-cli 0.155.0')
    assert.equal(record.inference.headers['x-tangle-session-id'], 'session-1')
    assert.equal(record.webSearch.enabled, false)
    assert.deepEqual(record.toolInventory.observed, ['bash'])
    assert.equal(record.publication, 'unknown')
    assert.equal(record.processTermination, 'stopped')
    assert.ok(readFileSync(join(root, record.launchId, record.transcript), 'utf8').includes('native-private-thread'))
  })
  it('keeps flag-shaped prompts after the option terminator', async () => {
    const f = fixture()
    const req = request()
    req.messages = [{ role: 'user', content: '--oss' }]
    await collect(f.backend.chat(req, null, new AbortController().signal))
    assert.deepEqual(f.modelCalls[0]!.args.slice(-2), ['--', '--oss'])
  })
  it('binds a fresh execution tuple on resume and on a new launch retry', async () => {
    const f = fixture()
    await collect(f.backend.chat(request(), null, new AbortController().signal))
    const session: SessionRecord = { externalId: 'session-1', backend: 'codex', internalId: 'native-private-thread',
      cwd: root, turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} }
    await collect(f.backend.chat(request('execution-2', true), session, new AbortController().signal))
    await collect(f.backend.chat(request('execution-2', true), session, new AbortController().signal))
    assert.equal(f.probes(), 3)
    assert.equal(f.modelCalls.length, 3)
    for (const call of f.modelCalls.slice(1)) {
      assert.ok(call.args.includes('resume'))
      assert.ok(call.args.includes('native-private-thread'))
      assert.ok(call.args.includes('web_search = "live"'))
      assert.ok(call.args.find(arg => arg.startsWith('model_providers.'))!.includes('"x-tangle-execution-id" = "execution-2"'))
      assert.ok(!call.args.find(arg => arg.startsWith('model_providers.'))!.includes('native-private-thread'))
    }
    assert.equal(new Set(records().map(record => record.inference.nativeProvider)).size, 3)
    assert.equal(new Set(records().map(record => record.launchId)).size, 3)
  })
  it('refuses incomplete attribution before even a version probe', async () => {
    const f = fixture()
    const req = request()
    delete req.execution_id
    await assert.rejects(collect(f.backend.chat(req, null, new AbortController().signal)), /x-tangle-execution-id/u)
    assert.equal(f.probes(), 0)
    assert.equal(f.modelCalls.length, 0)
    assert.deepEqual(readdirSync(root), [])
  })
  it('refuses unknown versions before model spawn and releases the probe', async () => {
    const f = fixture({ version: 'codex-cli 0.154.0' })
    await assert.rejects(collect(f.backend.chat(request(), null, new AbortController().signal)), /verified native provider-inheritance/u)
    assert.equal(f.probes(), 1)
    assert.equal(f.modelCalls.length, 0)
    assert.equal(f.releases(), 1)
    assert.deepEqual(readdirSync(root), [])
  })
  it('refuses executor uncertainty and mismatched resumed identity before probing', async () => {
    const f = fixture()
    f.spawner.executionEnvironment = 'docker'
    await assert.rejects(collect(f.backend.chat(request(), null, new AbortController().signal)), /unwrapped host executor/u)
    f.spawner.executionEnvironment = 'host'
    const session: SessionRecord = { externalId: 'different', backend: 'codex', internalId: 'native-private-thread',
      cwd: root, turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} }
    await assert.rejects(collect(f.backend.chat(request(), session, new AbortController().signal)), /does not match/u)
    assert.equal(f.probes(), 0)
    assert.equal(f.modelCalls.length, 0)
  })
  it('refuses record creation failure before model spawn', async () => {
    const f = fixture()
    const path = join(root, 'not-a-directory')
    writeFileSync(path, 'file')
    process.env.BRIDGE_LAUNCH_RECORD_DIR = path
    await assert.rejects(collect(f.backend.chat(request(), null, new AbortController().signal)))
    assert.equal(f.modelCalls.length, 0)
  })
  it('refuses a successful EOF without a native terminal event', async () => {
    const f = fixture({ omitTerminal: true })
    const received: ChatDelta[] = []
    await assert.rejects((async () => {
      for await (const delta of f.backend.chat(request(), null, new AbortController().signal)) received.push(delta)
    })(), /without a native terminal event/u)
    assert.ok(!received.some(delta => delta.finish_reason))
    assert.equal(records()[0]!.status, 'failed')
    assert.equal(records()[0]!.terminalEvent, null)
    assert.equal(f.releases(), 2)
    assert.equal(f.terminations(), 1)
  })
  it('records model spawn failures instead of leaving successful metadata', async () => {
    const f = fixture({ spawnError: true })
    await assert.rejects(collect(f.backend.chat(request(), null, new AbortController().signal)), /fixture model spawn failure/u)
    assert.equal(records()[0]!.status, 'failed')
    assert.equal(records()[0]!.publication, 'unknown')
  })
  it('does not certify a successful receipt when executor stop fails', async () => {
    const f = fixture({ terminateFails: true })
    const received: ChatDelta[] = []
    await assert.rejects((async () => {
      for await (const delta of f.backend.chat(request(), null, new AbortController().signal)) received.push(delta)
    })(), /termination is unconfirmed/u)
    assert.equal(records()[0]!.processTermination, 'failed')
    assert.equal(records()[0]!.status, 'failed')
    assert.ok(!received.some(delta => delta.finish_reason === 'stop'))
  })
  it('records native failures and propagates evidence-write failures after releasing the process', async () => {
    const f = fixture({ errorEvent: true })
    const deltas = await collect(f.backend.chat(request(), null, new AbortController().signal))
    assert.ok(deltas.some(delta => delta.finish_reason === 'error'))
    assert.equal(records()[0]!.status, 'failed')
    assert.equal(records()[0]!.terminalEvent, 'error')
    const broken = fixture({ corruptEvidence: true })
    const received: ChatDelta[] = []
    await assert.rejects((async () => {
      for await (const delta of broken.backend.chat(request('execution-2'), null, new AbortController().signal)) received.push(delta)
    })(), /EEXIST/u)
    assert.ok(!received.some(delta => delta.finish_reason))
    assert.equal(broken.releases(), 2)
    assert.equal(broken.terminations(), 1)
  })
})
