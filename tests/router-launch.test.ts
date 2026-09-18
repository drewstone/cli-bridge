import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'vitest'
import type { Backend, ChatRequest } from '../src/backends/types.js'
import { BackendRegistry } from '../src/backends/registry.js'
import {
  assertRouterCodexExecution,
  assertRouterCodexVersion,
  codexRouterArgs,
  openRouterLaunchRecord,
  prepareRouterLaunch,
  routerReceiptsRequired,
} from '../src/backends/router-launch.js'

const directories: string[] = []
const originalMode = process.env.BRIDGE_ROUTER_RECEIPTS_REQUIRED
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'router-launch-'))
  directories.push(value)
  return value
}
function env(): NodeJS.ProcessEnv {
  return {
    BRIDGE_ROUTER_RECEIPTS_REQUIRED: '1',
    TANGLE_ROUTER_URL: 'https://router.tangle.tools/v1',
    TANGLE_API_KEY: 'test-router-secret',
    BRIDGE_LAUNCH_RECORD_DIR: root(),
  }
}
function request(): ChatRequest {
  return {
    model: 'codex/tangle/openai/gpt-5.1-codex',
    messages: [{ role: 'user', content: 'code' }],
    environment_id: 'environment-1',
    session_id: 'external-session-1',
    execution_id: 'execution-1',
    metadata: { router_web_search: false },
  }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalMode === undefined) delete process.env.BRIDGE_ROUTER_RECEIPTS_REQUIRED
  else process.env.BRIDGE_ROUTER_RECEIPTS_REQUIRED = originalMode
})

describe('Router receipt preflight', () => {
  it('leaves ordinary subscription requests unchanged', () => {
    assert.equal(prepareRouterLaunch({ model: 'codex', messages: [] }, {}), null)
    assert.equal(routerReceiptsRequired({ BRIDGE_ROUTER_RECEIPTS_REQUIRED: '0' }), false)
  })
  it('fails closed on a misspelled required-mode value', () => {
    assert.throws(() => routerReceiptsRequired({ BRIDGE_ROUTER_RECEIPTS_REQUIRED: 'true' }), /0 or 1/u)
  })
  for (const coordinate of ['environment_id', 'session_id', 'execution_id'] as const) {
    it(`refuses absent, empty, oversized and injected ${coordinate}`, () => {
      const configuration = env()
      for (const value of [undefined, '', ' ', 'id\r\nx-evil: yes', '../escape', 'x'.repeat(257), 'α']) {
        const req = request()
        if (value === undefined) delete req[coordinate]
        else req[coordinate] = value
        assert.throws(() => prepareRouterLaunch(req, configuration), /missing or invalid/u)
      }
      assert.deepEqual(readdirSync(configuration.BRIDGE_LAUNCH_RECORD_DIR!), [])
    })
  }
  it('requires an explicit Router route and a boolean search treatment', () => {
    const configuration = env()
    for (const model of ['codex', 'codex/default', 'codex/openai/model', 'codex/tangle/', 'codex/tangle/a"\n']) {
      assert.throws(() => prepareRouterLaunch({ ...request(), model }, configuration), /explicit-model-route/u)
    }
    for (const metadata of [undefined, {}, { router_web_search: 'false' }]) {
      assert.throws(() => prepareRouterLaunch({ ...request(), metadata }, configuration), /explicit boolean/u)
    }
  })
  it('rejects URL credentials, non-Router hosts, plaintext, query and fragment routing', () => {
    const configuration = env()
    for (const url of [undefined, '', 'http://router.tangle.tools/v1', 'https://router.tangle.tools.evil/v1',
      'https://user:secret@router.tangle.tools/v1', 'https://router.tangle.tools/v1?api_key=x',
      'https://router.tangle.tools/v1#x', 'https://router.tangle.tools:8443/v1', 'https://router.tangle.tools/',
      ' https://router.tangle.tools/v1', 'https://127.0.0.1/v1', 'https://router-staging.tangle.tools/v1']) {
      assert.throws(() => prepareRouterLaunch(request(), { ...configuration, TANGLE_ROUTER_URL: url }), /Router/u)
    }
    assert.equal(prepareRouterLaunch(request(), { ...configuration, TANGLE_ROUTER_URL: 'https://router.tangle.tools/v1/' })!.baseUrl,
      'https://router.tangle.tools/v1')
  })
  it('rejects missing, injected and executor-oversized keys without echoing them', () => {
    const configuration = env()
    for (const key of [undefined, '', 'secret\nheader', 'key"quote', 'x'.repeat(16385)]) {
      assert.throws(() => prepareRouterLaunch(request(), { ...configuration, TANGLE_API_KEY: key }), /TANGLE_API_KEY is missing or invalid/u)
    }
    assert.throws(() => prepareRouterLaunch(request(), { ...configuration, BRIDGE_LAUNCH_RECORD_DIR: 'relative' }), /absolute private directory/u)
  })
  it('rejects the unverified protected-credential path', () => {
    assert.throws(() => prepareRouterLaunch({ ...request(), protectedModelCredential: {
      token: 'secret', digest: 'sha256:1', baseUrl: 'https://router.tangle.tools/v1', baseUrlDigest: 'sha256:2',
    } }, env()), /protected-model credentials/u)
  })
  it('accepts only the version whose native inheritance contract was inspected', () => {
    assertRouterCodexVersion('codex-cli 0.155.0')
    for (const version of [undefined, '', 'codex-cli 0.154.0', 'codex-cli 0.155.1', '0.155.0']) {
      assert.throws(() => assertRouterCodexVersion(version), /verified native provider-inheritance/u)
    }
  })
  it('refuses unknown executors, wrapped launches, cached probes and conflicting profile flags', () => {
    const launch = prepareRouterLaunch(request(), env())!
    const input = { bin: '/usr/local/bin/codex', environment: 'host', jail: null, flags: [], env: {}, launch }
    assertRouterCodexExecution(input)
    for (const change of [
      { bin: 'codex' }, { environment: undefined }, { environment: 'docker' }, { jail: {} },
      { env: { BRIDGE_HEALTH_READY_CACHE_TTL_MS: '5000' } }, { resumedExternalId: 'another-session' },
      { flags: ['--oss'] }, { flags: ['-c', 'model_provider="openai"'] },
      { flags: ['-c', 'web_search="live"'] }, { flags: ['-c', 'model="elsewhere"'] },
    ]) assert.throws(() => assertRouterCodexExecution({ ...input, ...change }), /Router receipt preflight/u)
    assertRouterCodexExecution({ ...input, flags: ['-c', 'model_reasoning_effort="high"'] })
  })
})

describe('Codex native Router configuration', () => {
  it('sets the Router route, env-backed key and every receipt header on a fresh provider', () => {
    const configuration = env()
    const launch = prepareRouterLaunch(request(), configuration)!
    const args = codexRouterArgs(launch)
    const provider = args[1]!
    assert.match(provider, /^model_providers\.tangle_receipt_[a-f0-9]{32} = /u)
    assert.ok(provider.includes('base_url = "https://router.tangle.tools/v1"'))
    assert.ok(provider.includes('env_key = "TANGLE_ROUTER_CREDENTIAL"'))
    assert.ok(provider.includes('requires_openai_auth = false'))
    assert.ok(provider.includes('supports_websockets = false'))
    assert.ok(provider.includes('supports_standalone_web_search = false'))
    assert.ok(provider.includes('"x-tangle-environment-id" = "environment-1"'))
    assert.ok(provider.includes('"x-tangle-session-id" = "external-session-1"'))
    assert.ok(provider.includes('"x-tangle-execution-id" = "execution-1"'))
    assert.ok(args.includes('model = "openai/gpt-5.1-codex"'))
    assert.ok(args.includes(`model_provider = "${launch.nativeProvider}"`))
    assert.ok(!args.join('\n').includes(configuration.TANGLE_API_KEY!))
    assert.ok(!provider.includes('env_http_headers'))
    assert.ok(!provider.includes('experimental_bearer_token'))
    assert.ok(!provider.includes('query_params'))
    // codex 0.155.0 aborts the launch on the legacy config-profile pair, so the
    // route lives only in the top-level keys above.
    assert.ok(!args.some(arg => arg.startsWith('profile = ')))
    assert.ok(!args.some(arg => arg.startsWith('profiles.')))
  })
  it('makes search live or disabled explicitly, never cached by default', () => {
    for (const enabled of [true, false]) {
      const launch = prepareRouterLaunch({ ...request(), metadata: { router_web_search: enabled } }, env())!
      assert.ok(codexRouterArgs(launch).includes(`web_search = "${enabled ? 'live' : 'disabled'}"`))
    }
  })
  it('isolates concurrent launches and binds new execution IDs without mutating the environment', () => {
    const configuration = env()
    const original = { ...configuration }
    const first = prepareRouterLaunch(request(), configuration)!
    const second = prepareRouterLaunch({ ...request(), execution_id: 'execution-2' }, configuration)!
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.nativeProvider, second.nativeProvider)
    assert.equal(first.headers['x-tangle-execution-id'], 'execution-1')
    assert.equal(second.headers['x-tangle-execution-id'], 'execution-2')
    assert.deepEqual(configuration, original)
  })
})

describe('Router launch evidence', () => {
  it('writes private metadata beside the transcript and never promotes unknown inventory or cost to success', () => {
    const launch = prepareRouterLaunch(request(), env())!
    const writer = openRouterLaunchRecord(launch, { version: 'codex-cli 0.155.0', profileDigest: null,
      configuredTools: { Bash: true, WebSearch: false }, mcpServers: [] })
    const directory = join(launch.directory, launch.id)
    const metadataPath = join(directory, 'launch.json')
    const transcriptPath = join(directory, 'transcript.jsonl')
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).status, 'prepared')
    writer.append(JSON.stringify({ type: 'message', text: launch.key }))
    writer.observeTool('bash')
    writer.observeTool('bash')
    writer.terminal('completed')
    writer.close('closed')
    writer.close('failed')
    const raw = readFileSync(metadataPath, 'utf8')
    const record = JSON.parse(raw)
    assert.equal(record.harnessVersion, 'codex-cli 0.155.0')
    assert.equal(record.inference.modelRoute, launch.model)
    assert.deepEqual(record.inference.headers, launch.headers)
    assert.deepEqual(record.toolInventory.configured, { Bash: true, WebSearch: false })
    assert.deepEqual(record.toolInventory.observed, ['bash'])
    assert.equal(record.toolInventory.nativeAvailable, null)
    assert.equal(record.toolInventory.status, 'unknown')
    assert.equal(record.inference.routerReceipts, 'unknown')
    assert.equal(record.publication, 'unknown')
    assert.equal(record.status, 'closed')
    assert.equal(record.terminalEvent, 'completed')
    assert.equal(record.transcript, 'transcript.jsonl')
    assert.ok(!raw.includes(launch.key))
    assert.ok(!readFileSync(transcriptPath, 'utf8').includes(launch.key))
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(metadataPath).mode & 0o777, 0o600)
    assert.equal(statSync(transcriptPath).mode & 0o777, 0o600)
    assert.throws(() => writer.append('late'), /closed/u)
  })
  it('does not overwrite evidence and fails on an unwritable destination', () => {
    const launch = prepareRouterLaunch(request(), env())!
    const input = { version: 'codex-cli 0.155.0', profileDigest: null, configuredTools: null, mcpServers: [] }
    const writer = openRouterLaunchRecord(launch, input)
    writer.close('failed')
    assert.throws(() => openRouterLaunchRecord(launch, input), /EEXIST/u)
    assert.throws(() => openRouterLaunchRecord({ ...launch, directory: join(launch.directory, 'missing') }, input), /ENOENT/u)
  })
  it('records cancellation and reports final evidence-write failures', () => {
    const launch = prepareRouterLaunch(request(), env())!
    const writer = openRouterLaunchRecord(launch, { version: 'codex-cli 0.155.0', profileDigest: null, configuredTools: null, mcpServers: [] })
    writer.close('aborted')
    assert.equal(JSON.parse(readFileSync(join(launch.directory, launch.id, 'launch.json'), 'utf8')).status, 'aborted')
    const next = prepareRouterLaunch(request(), env())!
    const broken = openRouterLaunchRecord(next, { version: 'codex-cli 0.155.0', profileDigest: null, configuredTools: null, mcpServers: [] })
    rmSync(join(next.directory, next.id), { recursive: true })
    assert.throws(() => broken.close('closed'), /ENOENT/u)
  })
})

describe('Receipt-required registry admission', () => {
  it('refuses unverified harnesses without falling through to a matching passthrough', () => {
    process.env.BRIDGE_ROUTER_RECEIPTS_REQUIRED = '1'
    const backend = (name: string): Backend => ({ name, matches: () => true,
      health: async () => ({ name, state: 'ready' }), async *chat() { throw new Error('must not launch') } })
    for (const name of ['claude', 'claudish', 'opencode', 'kimi', 'gemini', 'pi', 'prime', 'factory', 'amp', 'forge', 'nanoclaw', 'acp', 'hermes', 'openclaw', 'sandbox', 'passthrough']) {
      const registry = new BackendRegistry().register(backend(name)).register(backend('passthrough'))
      assert.equal(registry.resolve(`${name}/model`), null)
      assert.equal(registry.byName(name), null)
      assert.deepEqual(registry.all(), [])
    }
    const codex = backend('codex')
    const registry = new BackendRegistry().register(codex)
    assert.equal(registry.resolve('codex/tangle/model'), codex)
    assert.equal(registry.byName('codex'), codex)
    assert.deepEqual(registry.all(), [codex])
  })
  it('preserves ordinary registry selection outside the required lane', () => {
    delete process.env.BRIDGE_ROUTER_RECEIPTS_REQUIRED
    const backend: Backend = { name: 'claude', matches: () => true,
      health: async () => ({ name: 'claude', state: 'ready' }), async *chat() { throw new Error('must not launch') } }
    const registry = new BackendRegistry().register(backend)
    assert.equal(registry.resolve('claude/model'), backend)
    assert.equal(registry.byName('claude'), backend)
    assert.deepEqual(registry.all(), [backend])
  })
})
