import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { detectLocalSeats, geminiLoginState } = await tsImport('../src/local-seats.ts', import.meta.url)
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

for (const abort of [false, true]) test(`native inventory stops an actual SIGTERM-ignoring tree on ${abort ? 'abort' : 'timeout'}`, {
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
  const config = loadConfig({ BRIDGE_BACKENDS: '', BRIDGE_DATA_DIR: join(root, 'unused-state') })
  for (const name of ['claude', 'codex', 'opencode', 'kimi', 'gemini', 'pi']) config[name + 'Bin'] = join(root, 'missing-' + name)
  config.claudeBin = executable
  const controller = new AbortController()
  const started = Date.now()
  const pending = detectLocalSeats({ config, timeoutMs: abort ? 5000 : 750, signal: controller.signal })
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
  else assert.equal(result.value.find((seat) => seat.harness === 'claude-code').status, 'unknown')
  const owned = await pids(pidFile)
  await until(() => owned.every((pid) => !exists(pid)), 'a readonly probe PID survived inventory settlement')
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
