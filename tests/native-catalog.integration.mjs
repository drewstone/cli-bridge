import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { loadConfig, startServer, detectLocalSeats } = await tsImport('../src/server.ts', import.meta.url)
const { createNativeCatalog } = await tsImport('../src/native-catalog.ts', import.meta.url)
const nativeCodex = resolve('node_modules/.bin/codex')
const execute = promisify(execFile)

async function until(check, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function fixtureProcesses(wrapper) {
  const pending = [process.pid], seen = new Set(), owned = []
  const deadline = Date.now() + 4000
  while (pending.length) {
    assert.ok(Date.now() < deadline && seen.size < 128, 'owned fixture lookup exceeded its bounded descendant tree')
    const parent = pending.pop()
    if (seen.has(parent)) continue
    seen.add(parent)
    const children = await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    for (const value of children.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(value)
      pending.push(pid)
      try {
        // Read argv only inside this test's descendant tree, never global process argv.
        const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
        if (args.includes(wrapper)) {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
          owned.push({ pid, started: stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] })
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return owned
}

async function sameProcess({ pid, started }) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] === started
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Delegate metadata to the installed real Codex. Any inference launch is an OS-visible failure,
// never a fabricated model response or an opportunity to spend a user's account.
test('real native catalog and HTTP/SSE admission refuse API, signed-out and changed native routes', { timeout: 60_000 }, async () => {
  await access(nativeCodex)
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-catalog-'))
  const previous = { ...process.env }
  let server
  try {
    const home = join(root, 'home'), codexHome = join(home, '.codex'), workspace = join(root, 'workspace')
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(workspace)])
    for (const key of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) delete process.env[key]
    Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome })
    const configFile = join(codexHome, 'config.toml')
    await writeFile(configFile, 'model_provider="openai"\nmodel="native-config-canary"\ncli_auth_credentials_store="file"\n')
    const attempted = join(root, 'inference-attempted')
    const wrapper = join(root, 'codex-readonly')
    await writeFile(wrapper, `#!/bin/sh\ncase "$1" in\napp-server|--version|login) exec '${nativeCodex.replaceAll("'", "'\\''")}' "$@" ;;\n*) printf attempted > '${attempted}'; exit 125 ;;\nesac\n`, { mode: 0o700 })
    const config = { ...loadConfig({ BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex,pi', CODEX_BIN: wrapper,
      BRIDGE_BEARER: 'native-catalog-public-test-bearer', BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' }), port: 0 }
    server = await startServer({ config, quiet: true, handleSignals: false })
    const headers = { authorization: 'Bearer native-catalog-public-test-bearer', 'content-type': 'application/json' }
    const catalog = await fetch(`${server.url}/v1/models`, { headers }).then((response) => response.json())
    const configured = catalog.data.find((entry) => entry.id === 'codex/native-config-canary')
    assert.equal(configured.provider, 'openai')
    assert.equal(configured.default, true)
    assert.equal(configured.authentication.status, 'signed_out')
    const request = async (body, extra = {}) => fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ model: 'codex/openai/native-config-canary', cwd: workspace, messages: [{ role: 'user', content: 'must never run' }], ...body }) })
    const refusal = async (response, cause) => {
      assert.equal(response.status, 403)
      const { error } = await response.json()
      assert.equal(error.type, 'subscription_required')
      assert.equal(error.cause, cause)
      assert.equal(error.provider_dispatch, 'not_started')
      assert.equal(error.status, 403)
      assert.ok(error.fix.length > 0 && error.fix.length <= 256)
      return error
    }
    assert.equal((await refusal(await request({ agent_profile: { name: 'complete-authored-profile', harness: 'codex', model: { provider: 'openai', default: 'native-config-canary' } } }), 'not_authenticated')).fix, 'codex login')
    process.env.CODEX_API_KEY = 'public-native-auth-admission-canary'
    await refusal(await request({}), 'api_key_selected')
    const streamed = await request({ stream: true, run_id: 'native-api-sse' })
    assert.equal(streamed.status, 200)
    const wire = await streamed.text()
    const frames = wire.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)))
    assert.ok(frames.some((frame) => frame.error?.type === 'subscription_required' && frame.error.status === 403 && frame.error.provider_dispatch === 'not_started'))
    delete process.env.CODEX_API_KEY
    await writeFile(configFile, 'model_provider="private-route"\nmodel="native-config-canary"\n[model_providers.private-route]\nname="Private route"\nbase_url="https://example.invalid/v1"\nwire_api="responses"\n')
    const changed = await fetch(`${server.url}/v1/models`, { headers }).then((response) => response.json())
    assert.equal(changed.data.find((entry) => entry.id === 'codex/native-config-canary').provider, 'private-route')
    await refusal(await request({ model: 'codex/default' }), 'subscription_unverified')
    await refusal(await request({ model: 'pi/openai-codex/native-config-canary' }, { 'x-cli-bridge-model-credential': 'public-override-canary', 'x-cli-bridge-model-base-url': 'https://example.invalid/v1' }), 'provider_unresolved')
    await server.close()
    server = await startServer({ config, quiet: true, handleSignals: false })
    const replay = await request({ stream: true, run_id: 'native-api-sse' })
    assert.equal(replay.status, 200)
    const replayFrames = (await replay.text()).split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)))
    assert.ok(replayFrames.some((frame) => frame.error?.type === 'subscription_required' && frame.error.cause === 'api_key_selected' && frame.error.status === 403))
    await assert.rejects(readFile(attempted), { code: 'ENOENT' })
  } finally {
    await server?.close()
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude listeners isolate their supplied workspaces and effective settings sources', { timeout: 80_000 }, async () => {
  const previous = { ...process.env }
  const nativeClaude = join(previous.HOME, '.local/bin/claude')
  await access(nativeClaude)
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-claude-'))
  let server, sibling
  try {
    const home = join(root, 'home'), workspace = join(root, 'workspace'), user = join(home, '.claude'), project = join(workspace, '.claude')
    const siblingWorkspace = join(root, 'sibling-workspace'), siblingProject = join(siblingWorkspace, '.claude')
    await Promise.all([mkdir(user, { recursive: true }), mkdir(project, { recursive: true }), mkdir(siblingProject, { recursive: true })])
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[key]
    process.env.HOME = home
    assert.notEqual(workspace, process.cwd(), 'the embedded discovery workspace must differ from the Bridge process cwd')
    await writeFile(join(user, 'settings.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'public-user-api-canary', ANTHROPIC_BASE_URL: 'https://example.invalid/v1' } }))
    await writeFile(join(project, 'settings.json'), JSON.stringify({ model: 'opus' }))
    await writeFile(join(project, 'settings.local.json'), JSON.stringify({ model: 'haiku' }))
    await writeFile(join(siblingProject, 'settings.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'public-sibling-api-canary' } }))
    await writeFile(join(siblingProject, 'settings.local.json'), JSON.stringify({ model: 'opus' }))
    const attempted = join(root, 'inference-attempted'), wrapper = join(root, 'claude-readonly')
    await writeFile(wrapper, `#!/bin/sh\ncase " $* " in\n*' auth status '*|*' --version '*) exec '${nativeClaude.replaceAll("'", "'\\''")}' "$@" ;;\n*) printf attempted > '${attempted}'; exit 125 ;;\nesac\n`, { mode: 0o700 })
    server = await startServer({ config: { ...loadConfig({ BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', CLAUDE_BIN: wrapper,
      BRIDGE_BEARER: 'native-claude-public-test-bearer', BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' }), port: 0 }, cwd: workspace, quiet: true, handleSignals: false })
    sibling = await startServer({ config: { ...loadConfig({ BRIDGE_DATA_DIR: join(root, 'sibling-state'), BRIDGE_BACKENDS: 'claude', CLAUDE_BIN: wrapper,
      BRIDGE_BEARER: 'native-claude-public-test-bearer', BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' }), port: 0 }, cwd: siblingWorkspace, quiet: true, handleSignals: false })
    assert.notEqual(server.url, sibling.url, 'both independently owned listeners must be live')
    const headers = { authorization: 'Bearer native-claude-public-test-bearer', 'content-type': 'application/json' }
    const secrets = ['public-user-api-canary', 'public-project-api-canary', 'public-local-bearer-canary', 'public-sibling-api-canary']
    const catalog = async (authMode, status, source, instance = server, model = 'haiku') => {
      const response = await fetch(`${instance.url}/v1/models`, { headers })
      assert.equal(response.status, 200)
      const wire = await response.text()
      for (const secret of secrets) assert.ok(!wire.includes(secret))
      const { data } = JSON.parse(wire)
      assert.deepEqual(data.filter((entry) => entry.default).map((entry) => entry.id), [`claude-code/${model}`], 'each listener resolves its own local model over project and excluded user defaults')
      const selected = data.find((entry) => entry.id === `claude-code/${model}`)
      assert.equal(selected.provider, 'anthropic', 'the excluded user endpoint must not poison discovery')
      assert.deepEqual({ authMode: selected.authentication.authMode, status: selected.authentication.status, source: selected.authentication.source }, { authMode, status, source })
      return selected
    }
    const request = (instance = server, cwd = workspace, model = 'haiku') => fetch(`${instance.url}/v1/chat/completions`, { method: 'POST', headers,
      body: JSON.stringify({ model: `claude-code/${model}`, cwd, messages: [{ role: 'user', content: 'must never run' }] }) })
    const refusal = async (response, cause) => {
      assert.equal(response.status, 403)
      const wire = await response.text()
      for (const secret of secrets) assert.ok(!wire.includes(secret))
      const { error } = JSON.parse(wire)
      assert.deepEqual({ type: error.type, cause: error.cause, provider: error.provider, harness: error.harness, dispatch: error.provider_dispatch, status: error.status },
        { type: 'subscription_required', cause, provider: 'anthropic', harness: 'claude-code', dispatch: 'not_started', status: 403 })
      assert.ok(error.fix.length > 0 && error.fix.length <= 256)
    }
    const [, siblingBefore] = await Promise.all([catalog('unknown', 'signed_out', 'native_status'), catalog('api_key', 'configured', 'native_store', sibling, 'opus')])
    await Promise.all([request().then((response) => refusal(response, 'not_authenticated')),
      request(sibling, siblingWorkspace, 'opus').then((response) => refusal(response, 'api_key_selected'))])
    await writeFile(join(project, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'public-project-api-canary' } }))
    const [siblingAfterProject] = await Promise.all([catalog('api_key', 'configured', 'native_store', sibling, 'opus'), catalog('api_key', 'configured', 'native_store')])
    assert.deepEqual(siblingAfterProject, siblingBefore, 'mutating the first workspace must leave the sibling catalog unchanged')
    await Promise.all([request(sibling, siblingWorkspace, 'opus').then((response) => refusal(response, 'api_key_selected')),
      request().then((response) => refusal(response, 'api_key_selected'))])
    await writeFile(join(project, 'settings.local.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'public-local-bearer-canary' } }))
    const [, siblingAfterLocal] = await Promise.all([catalog('unknown', 'configured', 'native_store', server, 'sonnet'), catalog('api_key', 'configured', 'native_store', sibling, 'opus')])
    assert.deepEqual(siblingAfterLocal, siblingBefore, 'local model and credential changes must not bleed across listeners')
    await Promise.all([request(server, workspace, 'sonnet').then((response) => refusal(response, 'subscription_unverified')),
      request(sibling, siblingWorkspace, 'opus').then((response) => refusal(response, 'api_key_selected'))])
    await writeFile(join(project, 'settings.local.json'), JSON.stringify({ model: 'haiku' }))
    await writeFile(join(project, 'settings.json'), '{}')
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'public-native-oauth-canary'
    const inventoryConfig = loadConfig({ BRIDGE_BACKENDS: '', CLAUDE_BIN: wrapper, BRIDGE_DATA_DIR: join(root, 'unused') })
    const inventory = (flags = ['--setting-sources', 'project,local']) => detectLocalSeats({ config: inventoryConfig, harnesses: ['claude-code'], cwd: workspace, flags })
    assert.equal((await inventory())[0].authMode, 'subscription', 'native setup-token path remains distinguishable')
    process.env.ANTHROPIC_AUTH_TOKEN = 'public-native-bearer-canary'
    const bearer = await request()
    assert.equal(bearer.status, 403)
    const bearerError = (await bearer.json()).error
    assert.equal(bearerError.cause, 'subscription_unverified')
    assert.equal(bearerError.fix, 'unset ANTHROPIC_AUTH_TOKEN')
    assert.equal((await inventory())[0].authMode, 'unknown')
    delete process.env.ANTHROPIC_AUTH_TOKEN
    await writeFile(join(project, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'public-selected-settings-bearer' } }))
    const projectBearer = await request()
    assert.equal(projectBearer.status, 403)
    assert.equal((await projectBearer.json()).error.fix, 'claude auth status --json')
    assert.equal((await inventory())[0].authMode, 'unknown')
    await writeFile(join(project, 'settings.json'), '{}')
    const helperMarker = join(root, 'helper-executed')
    const helper = await inventory(['--setting-sources', 'project,local', '--settings', JSON.stringify({ apiKeyHelper: `printf invoked > '${helperMarker}'` })])
    assert.equal(helper[0].authMode, 'unknown', 'a dynamic credential helper is not subscription evidence')
    await assert.rejects(readFile(helperMarker), { code: 'ENOENT' })
    const native = createNativeCatalog({ ...inventoryConfig, subscriptionsOnly: true })
    const inlineRequest = { model: 'claude-code/opus', cwd: workspace, messages: [] }
    await native.admit(inlineRequest, 'claude-code', new AbortController().signal)
    await assert.rejects(inlineRequest.subscriptionAdmission.check({ model: inlineRequest.model, cwd: workspace, env: { ...process.env }, executor: 'host',
      flags: ['--setting-sources', 'project,local', '--settings', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'public-inline-bearer-canary' } })] }), (failure) => {
      assert.equal(failure.code, 'subscription_required')
      assert.equal(failure.providerDispatch, 'not_started')
      assert.equal(failure.subscription.cause, 'subscription_unverified')
      assert.equal(failure.subscription.fix, 'claude auth status --json')
      return true
    })
    for (const malformed of [{ ANTHROPIC_AUTH_TOKEN: 'private-native-canary\0suffix' }, { ['private-native-canary\0key']: 'value' }]) {
      await writeFile(join(project, 'settings.json'), JSON.stringify({ env: malformed }))
      const output = await execute(process.execPath, [resolve('bin/cli-bridge.mjs'), '--seats', '--json'], { cwd: workspace,
        env: { ...process.env, BRIDGE_BACKENDS: '', CLAUDE_BIN: wrapper, CODEX_BIN: '/native-missing-codex', OPENCODE_BIN: '/native-missing-opencode',
          KIMI_BIN: '/native-missing-kimi', GEMINI_BIN: '/native-missing-gemini', PI_BIN: '/native-missing-pi' }, timeout: 20_000 })
      assert.ok(!`${output.stdout}${output.stderr}`.includes('private-native-canary'), 'public inventory must never include malformed credential bytes')
      assert.equal(JSON.parse(output.stdout).find((seat) => seat.harness === 'claude-code').status, 'unknown')
    }
    await assert.rejects(readFile(attempted), { code: 'ENOENT' })
  } finally {
    try {
      const closed = await Promise.allSettled([server?.close(), sibling?.close()])
      const failure = closed.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
      Object.assign(process.env, previous)
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('mandatory GTR Codex native deadline default and caller overrides stop before inference', {
  skip: process.env.CLI_BRIDGE_GTR_CODEX_DEFAULT_GATE === undefined ? 'requires explicit CLI_BRIDGE_GTR_CODEX_DEFAULT_GATE=1 on the named GTR native gate with an existing authorized account' : false,
  timeout: 180_000,
}, async () => {
  assert.equal(process.env.CLI_BRIDGE_GTR_CODEX_DEFAULT_GATE, '1', 'the mandatory native gate must explicitly opt in with 1')
  assert.equal(process.platform, 'linux', 'the mandatory native gate requires actual Linux fs-jail read confinement')
  await access(nativeCodex)
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-codex-deadline-'))
  const previous = { ...process.env }
  let server, owned = []
  try {
    // Keep the operator's actual native HOME/CODEX_HOME by reference. Never read/copy auth or invent a login.
    for (const key of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLI_TIMEOUT_MS', 'CODEX_TIMEOUT_MS',
      'BRIDGE_JAIL_RW_PATHS', 'BRIDGE_JAIL_RO_PATHS', 'BRIDGE_JAIL_ROOT', 'BRIDGE_JAIL_MODE', 'BRIDGE_JAIL_FALLBACK', 'WORKER_FS_JAIL']) delete process.env[key]
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const wrapper = join(workspace, 'codex-readonly'), attempted = join(workspace, 'exec-refused'), refresh = join(workspace, 'refresh-refused'), hold = join(workspace, 'hold'), fifo = join(workspace, 'blocked-exec')
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(wrapper, `#!/bin/sh\ncase "$1" in\napp-server|--version) exec ${quote(nativeCodex)} "$@" ;;\nlogin) if [ "$2" = status ]; then exec ${quote(nativeCodex)} "$@"; fi; exit 126 ;;\nexec) printf refused > ${quote(attempted)}; printf 'fixture refuses all inference\\n' >&2; if [ -e ${quote(hold)} ]; then mkfifo ${quote(fifo)}; read -r ignored < ${quote(fifo)}; fi; exit 125 ;;\n*) printf refused > ${quote(refresh)}; printf 'fixture refuses auth refresh and unknown launches\\n' >&2; exit 126 ;;\nesac\n`, { mode: 0o700 })
    const options = { BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex', CODEX_BIN: wrapper,
      BRIDGE_BEARER: 'native-deadline-public-test-bearer', BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' }
    const config = { ...loadConfig(options), port: 0 }
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    const headers = { authorization: 'Bearer native-deadline-public-test-bearer', 'content-type': 'application/json' }
    const models = await fetch(`${server.url}/v1/models`, { headers }).then((response) => response.json())
    const native = models.data.find((row) => row.backend === 'codex' && row.default)
    assert.ok(native, 'precondition: the real native account must report a configured default')
    assert.equal(native.provider, 'openai', 'precondition: the real native route must select OpenAI')
    assert.equal(native.authentication.status, 'authenticated', 'precondition: an existing actual native account must be authenticated')
    assert.equal(native.authentication.authMode, 'subscription', 'precondition: the account must be an actual native subscription')
    const request = async (id, execution = {}) => {
      const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model: 'codex/default', cwd: workspace, run_id: id, messages: [{ role: 'user', content: 'must never run' }],
          execution: { kind: 'host', jail: { mode: 'fs-jail' }, ...execution } }) })
      return { status: response.status, body: await response.json() }
    }
    const absent = async (file) => {
      try { await access(file); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    }
    const assertNoRefresh = async () => assert.ok(await absent(refresh), 'precondition: the actual native account must cover the deadline plus native margin; OAuth refresh was refused, never performed')
    const refusedExec = async (outcome) => {
      await assertNoRefresh()
      assert.equal(await readFile(attempted, 'utf8').catch(() => ''), 'refused', 'the actual subscription deadline guard must admit before the OS wrapper refuses inference')
      assert.equal(outcome.status, 502)
      assert.ok(outcome.body.error && !outcome.body.choices, 'a refused native launch must never fabricate model output')
      await rm(attempted)
    }
    await assertNoRefresh()
    assert.ok(await absent(attempted), 'server setup and real metadata must not attempt inference')
    await refusedExec(await request('native-default-deadline'))
    const defaultTimeout = config.codexTimeoutMs
    assert.ok(Number.isSafeInteger(defaultTimeout) && defaultTimeout > 0)
    const excessive = await request('native-explicit-over-cap', { timeoutMs: defaultTimeout + 1 })
    assert.equal(excessive.body.error.type, 'not_configured', 'precondition: a real file-backed subscription must reach the native deadline guard')
    assert.match(excessive.body.error.message, /require a bounded deadline/)
    assert.ok(await absent(attempted), 'an explicit over-cap deadline must fail before exec')
    await assertNoRefresh()
    for (const fallback of [{ CLI_TIMEOUT_MS: '0' }, { CLI_TIMEOUT_MS: String(defaultTimeout), CODEX_TIMEOUT_MS: '0' },
      { CLI_TIMEOUT_MS: '60000' }, { CLI_TIMEOUT_MS: '0', CODEX_TIMEOUT_MS: '60000' }]) {
      await server.close()
      server = await startServer({ config: { ...loadConfig({ ...options, ...fallback }), port: 0 }, cwd: workspace, quiet: true, handleSignals: false })
      assert.ok(await absent(attempted), 'restarting the service must not attempt inference')
      const id = `native-fallback-${Object.keys(fallback).join('-')}-${Object.values(fallback).join('-')}`
      const result = await request(id)
      if (fallback.CODEX_TIMEOUT_MS === '0' || fallback.CLI_TIMEOUT_MS === '0' && !fallback.CODEX_TIMEOUT_MS) {
        assert.equal(result.body.error.type, 'not_configured')
        assert.match(result.body.error.message, /require a bounded deadline/)
        assert.ok(await absent(attempted), 'explicit operator zero must remain zero and refuse the subscription turn')
      } else await refusedExec(result)
      await assertNoRefresh()
    }
    await server.close()
    server = await startServer({ config: { ...loadConfig({ ...options, CODEX_TIMEOUT_MS: '0' }), port: 0 }, cwd: workspace, quiet: true, handleSignals: false })
    assert.ok(await absent(attempted), 'short-deadline setup must not attempt inference')
    await writeFile(hold, 'block only the fixture, never native inference')
    const pending = request('native-caller-short-deadline', { timeoutMs: 30_000 }).catch((error) => ({ transportError: error }))
    await until(async () => !await absent(attempted), 'explicit caller deadline did not reach the owned inference-refusal fixture', 25_000)
    owned = await fixtureProcesses(wrapper)
    assert.ok(owned.length > 0, 'observe the unique fixture under this test process using host PIDs, never namespace-local $$')
    const timed = await pending
    assert.equal(timed.transportError, undefined, 'the public request must finish with its typed timeout, not a transport deadline')
    assert.equal(timed.status, 504)
    assert.equal(timed.body.error.type, 'timeout')
    assert.match(timed.body.error.message, /execution timed out after 30000ms/)
    const terminal = await fetch(`${server.url}/v1/runs/native-caller-short-deadline?wait_ms=1000`, { headers }).then((response) => response.json())
    assert.equal(terminal.terminal, true)
    assert.equal(terminal.state, 'terminal')
    await until(async () => (await Promise.all(owned.map(sameProcess))).every((alive) => !alive), 'a scoped host fixture process survived the public terminal receipt')
    await assertNoRefresh()
  } finally {
    try { await server?.close() } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
      Object.assign(process.env, previous)
      await rm(root, { recursive: true, force: true })
    }
  }
})
