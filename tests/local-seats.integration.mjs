import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { detectLocalSeats, geminiLoginState } = await tsImport('../src/local-seats.ts', import.meta.url)
const { listLocalModels } = await tsImport('../src/local-models.ts', import.meta.url)
const { loadConfig } = await tsImport('../src/config.ts', import.meta.url)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execute = promisify(execFile)

async function pids(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(Number) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

function exists(pid) {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

async function until(check, message) {
  const deadline = Date.now() + 3000
  while (!await check()) { assert.ok(Date.now() < deadline, message); await pause(20) }
}

for (const reader of ['inventory', 'models']) for (const abort of [false, true]) test(`${reader} stops an actual SIGTERM-ignoring tree on ${abort ? 'abort' : 'timeout'}`, {
  skip: process.platform === 'win32' ? 'POSIX process-group boundary' : false, timeout: 12_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-seat-process-'))
  const pidFile = join(root, 'owned-pids')
  const executable = join(root, 'readonly-status')
  context.after(async () => {
    for (const pid of await pids(pidFile)) if (exists(pid)) {
      const owned = await execute('ps', ['-p', String(pid), '-o', 'command='], { timeout: 1000 })
        .then(({ stdout }) => stdout.includes(executable), () => false)
      if (owned) process.kill(pid, 'SIGKILL')
    }
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(executable, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
if (!process.argv.includes('--child')) spawn(process.execPath, [import.meta.filename, '--child'], { stdio: ['ignore', 'inherit', 'inherit'] });
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  const config = loadConfig({ BRIDGE_BACKENDS: reader === 'models' ? 'claude' : '', BRIDGE_DATA_DIR: join(root, 'unused-state') })
  for (const name of ['claude', 'codex', 'opencode', 'kimi', 'gemini', 'pi']) config[name + 'Bin'] = join(root, 'missing-' + name)
  config.claudeBin = executable
  const controller = new AbortController()
  const started = Date.now()
  const pending = reader === 'models' ? listLocalModels({ config, cwd: root, signal: controller.signal }) : detectLocalSeats({ config, cwd: root, env: { HOME: root, PATH: process.env.PATH }, flags: ['--setting-sources', ''], timeoutMs: abort ? 5000 : 750, signal: controller.signal })
  // Attach the rejection observer before aborting to keep native AbortError handled.
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }))
  await until(async () => (await pids(pidFile)).length === 2, 'the real readonly tree did not start')
  if (abort) controller.abort()
  let timer
  let result
  try {
    result = await Promise.race([outcome, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native inventory did not settle after its stop condition')), 4000)
    })])
  } finally { clearTimeout(timer) }
  assert.ok(Date.now() - started < 4500)
  if (abort) assert.equal(result.error?.name, 'AbortError')
  else if (reader === 'models') assert.deepEqual(result.value, [])
  else assert.equal(result.value.find((seat) => seat.harness === 'claude-code').status, 'unknown')
  const owned = await pids(pidFile)
  await until(() => owned.every((pid) => !exists(pid)), 'a readonly probe PID survived inventory settlement')
})

test('an enrolled Cursor token is a subscription seat only while its plan reading shows room', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-seat-cursor-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'cursor-agent')
  // Cursor's own status for the token it is handed; it names no plan, so the plan reading decides.
  await writeFile(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2026.11.22-fixture'); process.exit(0) }
console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: !!process.env.CURSOR_API_KEY }))
`, { mode: 0o755 })
  const token = 'cursor-service-token-fixture'
  const tokenFile = join(root, 'CURSOR_SERVICE_TOKEN')
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  const readingFile = join(root, 'usage-cursor.json')
  const reading = (used, extra = {}) => writeFile(readingFile, JSON.stringify({ ok: true, plan: 'Ultra', windows: [{ label: '7d auto', used }], ...extra }))
  const seat = async (env = {}) => (await detectLocalSeats({
    config: loadConfig({ BRIDGE_BACKENDS: 'cursor', CURSOR_BIN: bin }), harnesses: ['cursor'],
    env: { PATH: process.env.PATH, HOME: root, CURSOR_API_KEY_FILE: tokenFile, ...env },
  }))[0]
  const planned = { CURSOR_PLAN_READING_FILE: readingFile }

  const unread = await seat()
  assert.equal(unread.status, 'configured', 'with no reading the token stays an API key')
  assert.equal(unread.authMode, 'api_key')
  await reading(0.44)
  const room = await seat(planned)
  assert.equal(room.status, 'authenticated')
  assert.equal(room.authMode, 'subscription')
  assert.equal(room.credential, 'plan_key')
  assert.ok(!JSON.stringify(room).includes(token))
  await reading(0.95)
  assert.equal((await seat(planned)).authMode, 'api_key', 'a window past 90% may not cover the turn')
  await reading(0.44, { ok: false })
  assert.equal((await seat(planned)).authMode, 'api_key', 'a failed reading vouches for nothing')
  await reading(0.44)
  const stale = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(readingFile, stale, stale)
  assert.equal((await seat(planned)).authMode, 'api_key', 'a stale reading vouches for nothing')
})

test('Gemini native files respect explicit auth mode and keep credentials out of facts', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-seat-gemini-'))
  context.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, '.gemini')
  await mkdir(directory, { mode: 0o700 })
  const settings = (selectedType) => writeFile(join(directory, 'settings.json'), JSON.stringify({
    security: { authentication: { selectedType } },
  }), { mode: 0o600 })
  const key = 'private-native-state-fixture'
  await settings('oauth-personal')
  assert.deepEqual(await geminiLoginState(home, { GEMINI_API_KEY: key }), { status: 'signed_out', authMode: 'unknown' })
  await settings('gemini-api-key')
  assert.deepEqual(await geminiLoginState(home, {}), { status: 'unknown', authMode: 'api_key' })
  assert.deepEqual(await geminiLoginState(home, { GEMINI_API_KEY: ' ' }), { status: 'unknown', authMode: 'api_key' })
  assert.deepEqual(await geminiLoginState(home, { GEMINI_API_KEY: key }), { status: 'configured', authMode: 'api_key' })
  await writeFile(join(directory, 'oauth_creds.json'), JSON.stringify({ refresh_token: key }), { mode: 0o600 })
  await settings('oauth-personal')
  const oauth = await geminiLoginState(home, { GEMINI_API_KEY: key })
  assert.deepEqual(oauth, { status: 'configured', authMode: 'subscription' })
  assert.ok(!JSON.stringify(oauth).includes(key))
  await settings('vertex-ai')
  assert.deepEqual(await geminiLoginState(home, { GEMINI_API_KEY: key }), { status: 'unknown', authMode: 'unknown' })
})

// The real native CLIs, named the way the Bridge itself reads them. A Beelink gate has neither on PATH; its gate command
// fetches the pinned packages (README, the seats section) and passes OPENCODE_BIN and KIMI_BIN.
const realCli = async (variable, fallback) => {
  const bin = process.env[variable] || fallback
  return execute(bin, ['--version'], { timeout: 30_000 }).then(() => bin, () => null)
}
const [realOpencode, realKimi] = await Promise.all([realCli('OPENCODE_BIN', 'opencode'), realCli('KIMI_BIN', 'kimi')])

test('plan-keyed and Kimi subscription seats reach graph admission through the real CLIs', {
  skip: realOpencode && realKimi ? false : 'needs the real OpenCode and Kimi Code CLIs (OPENCODE_BIN, KIMI_BIN)', timeout: 180_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-plan-seats-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'), workspace = join(root, 'workspace'), kimiHome = join(home, '.kimi-code')
  const opencodeStore = join(home, '.local/share/opencode')
  await Promise.all([mkdir(opencodeStore, { recursive: true }), mkdir(join(kimiHome, 'credentials'), { recursive: true, mode: 0o700 }), mkdir(workspace)])
  // Fixture keys only: an inventory read sends no turn, and no key leaves this directory.
  await writeFile(join(opencodeStore, 'auth.json'), JSON.stringify({
    'zai-coding-plan': { type: 'api', key: 'fixture-plan-key' },
    deepseek: { type: 'api', key: 'fixture-api-key' },
    'minimax-coding-plan': { type: 'api', key: 'fixture-unlisted-key' },
  }), { mode: 0o600 })
  await writeFile(join(kimiHome, 'config.toml'), [
    'default_model = "kimi-code/kimi-for-coding"',
    '[providers."managed:kimi-code"]', 'type = "kimi"', 'base_url = "https://api.kimi.com/coding/v1"', 'api_key = ""',
    'oauth = { storage = "file", key = "oauth/kimi-code" }',
    '[providers.fixture-api]', 'type = "kimi"', 'base_url = "https://api.moonshot.ai/v1"', 'api_key = "fixture-kimi-api-key"',
    '[models."kimi-code/kimi-for-coding"]', 'provider = "managed:kimi-code"', 'model = "kimi-for-coding"', 'max_context_size = 262144',
    '[models."kimi-code/fixture-api-model"]', 'provider = "fixture-api"', 'model = "kimi-k2"', 'max_context_size = 262144', '',
  ].join('\n'), { mode: 0o600 })
  // Inside Kimi's refresh window (300 s): a server that refreshed its catalog on start would rewrite this login.
  const login = join(kimiHome, 'credentials', 'kimi-code.json')
  const loginState = JSON.stringify({ access_token: 'fixture-kimi-access', refresh_token: 'fixture-kimi-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 60, scope: '', token_type: 'Bearer', expires_in: 3600 })
  await writeFile(login, loginState, { mode: 0o600 })
  const missing = Object.fromEntries(['CLAUDE', 'CODEX', 'GEMINI', 'CURSOR', 'PI'].map((name) => [`${name}_BIN`, join(root, `missing-${name.toLowerCase()}`)]))
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'), BRIDGE_DATA_DIR: join(root, 'bridge'),
    // OpenCode answers from its bundled catalog, so the result does not depend on models.dev.
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_BIN: realOpencode, KIMI_BIN: realKimi, ...missing }
  const facts = ({ provider, status, authMode, credential, source }) => ({ provider, status, authMode, credential, source })
  const inventory = async () => {
    const { stdout } = await execute(process.execPath, [resolve('bin/cli-bridge.mjs'), '--seats', '--json'], { cwd: workspace, env, timeout: 60_000 })
    assert.ok(!stdout.includes('fixture-'), 'seat inventory carries no credential')
    return JSON.parse(stdout)
  }

  const seats = await inventory()
  assert.deepEqual(seats.filter((seat) => seat.harness === 'opencode').map(facts), [
    { provider: 'deepseek', status: 'configured', authMode: 'api_key', credential: undefined, source: 'native_store' },
    // A plan-like name outside the plan-keyed table stays a per-token API key: nothing is inferred from a name.
    { provider: 'minimax-coding-plan', status: 'configured', authMode: 'api_key', credential: undefined, source: 'native_store' },
    { provider: 'zai-coding-plan', status: 'authenticated', authMode: 'subscription', credential: 'plan_key', source: 'native_catalog' },
  ])
  assert.deepEqual(seats.filter((seat) => seat.harness === 'kimi-code').map(facts),
    [{ provider: 'moonshot', status: 'authenticated', authMode: 'subscription', credential: undefined, source: 'native_status' }])

  // The graph runner's own admission input: listLocalModels under the default subscription-only policy.
  const entry = pathToFileURL(resolve('index.mjs')).href
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
    const { listLocalModels, loadConfig } = await import(${JSON.stringify(entry)})
    const config = loadConfig({ ...process.env, BRIDGE_BACKENDS: 'opencode,kimi', BRIDGE_SUBSCRIPTIONS_ONLY: '1' })
    console.log(JSON.stringify(await listLocalModels({ cwd: process.cwd(), config })))`], { cwd: workspace, env, timeout: 120_000 })
  assert.ok(!stdout.includes('fixture-'), 'model catalog carries no credential')
  const models = new Map(JSON.parse(stdout).map((row) => [row.id, row]))
  const admitted = (id) => {
    const row = models.get(id)
    assert.ok(row, `the catalog lists ${id}`)
    return row.authentication.status === 'authenticated' && row.authentication.authMode === 'subscription' ? row.provider : false
  }
  assert.equal(admitted('opencode/zai-coding-plan/glm-5.3'), 'zai-coding-plan')
  assert.equal(models.get('opencode/zai-coding-plan/glm-5.3').authentication.credential, 'plan_key')
  assert.equal(admitted('kimi-code/kimi-for-coding'), 'moonshot')
  assert.equal(admitted('opencode/deepseek/deepseek-v4-pro'), false)
  // An alias that Kimi's own config does not route through its managed subscription is not admitted.
  assert.equal(admitted('kimi-code/kimi-k2.6'), false)
  assert.equal(await readFile(login, 'utf8'), loginState, 'reading the Kimi seat refreshes no token')

  // Kimi's own status, not a stored file, decides the login: without a token it is signed out.
  await rm(login)
  assert.deepEqual((await inventory()).filter((seat) => seat.harness === 'kimi-code').map(facts),
    [{ provider: null, status: 'signed_out', authMode: 'unknown', credential: undefined, source: 'native_status' }])
})
