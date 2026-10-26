import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { loadConfig, startServer } = await tsImport('../src/server.ts', import.meta.url)
const nativeCodex = resolve('node_modules/.bin/codex')

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

test('Claude admission uses the final project/local settings sources and refuses project API overrides', { timeout: 40_000 }, async () => {
  const previous = { ...process.env }
  const nativeClaude = join(previous.HOME, '.local/bin/claude')
  await access(nativeClaude)
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-claude-'))
  let server
  try {
    const home = join(root, 'home'), workspace = join(root, 'workspace'), user = join(home, '.claude'), project = join(workspace, '.claude')
    await Promise.all([mkdir(user, { recursive: true }), mkdir(project, { recursive: true })])
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[key]
    process.env.HOME = home
    await writeFile(join(user, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'public-user-api-canary', ANTHROPIC_BASE_URL: 'https://example.invalid/v1' } }))
    const attempted = join(root, 'inference-attempted'), wrapper = join(root, 'claude-readonly')
    await writeFile(wrapper, `#!/bin/sh\ncase " $* " in\n*' auth status '*|*' --version '*) exec '${nativeClaude.replaceAll("'", "'\\''")}' "$@" ;;\n*) printf attempted > '${attempted}'; exit 125 ;;\nesac\n`, { mode: 0o700 })
    server = await startServer({ config: { ...loadConfig({ BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', CLAUDE_BIN: wrapper,
      BRIDGE_BEARER: 'native-claude-public-test-bearer', BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' }), port: 0 }, quiet: true, handleSignals: false })
    const request = () => fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer native-claude-public-test-bearer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-code/opus', cwd: workspace, messages: [{ role: 'user', content: 'must never run' }] }) })
    const excluded = await request()
    assert.equal(excluded.status, 403)
    assert.equal((await excluded.json()).error.cause, 'not_authenticated')
    await writeFile(join(project, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'public-project-api-canary' } }))
    const selected = await request()
    assert.equal(selected.status, 403)
    const error = (await selected.json()).error
    assert.equal(error.cause, 'api_key_selected')
    assert.equal(error.provider_dispatch, 'not_started')
    await assert.rejects(readFile(attempted), { code: 'ENOENT' })
  } finally {
    await server?.close()
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await rm(root, { recursive: true, force: true })
  }
})
