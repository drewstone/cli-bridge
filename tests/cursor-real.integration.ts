/** Real HTTP -> Cursor CLI -> vendor models. Runs only inside the admitted Beelink gate. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig, startServer } from '../src/server.js'
import { detectLocalSeats } from '../src/local-seats.js'

const binary = resolve(process.env.CURSOR_BIN || join(homedir(), '.local/bin/cursor-agent'))
const credentialFile = process.env.CURSOR_API_KEY_FILE || join(homedir(), '.config/fleet/secrets/CURSOR_SERVICE_TOKEN')
const evidence = await mkdtemp(join(process.env.CURSOR_PROOF_DIR || '/tmp', 'cursor-http-'))
await chmod(evidence, 0o700)
const home = join(evidence, 'home'), cwd = join(evidence, 'workspace')
await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 })
Object.assign(process.env, { HOME: home, CURSOR_API_KEY_FILE: credentialFile, CURSOR_BIN: binary,
  BRIDGE_TRACE: 'off', BRIDGE_BACKENDS: 'cursor', BRIDGE_JAIL_MODE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '0' })
const bearer = randomBytes(32).toString('hex')
const config = loadConfig({ ...process.env, BRIDGE_PORT: '0', BRIDGE_BEARER: bearer, BRIDGE_DATA_DIR: join(evidence, 'bridge') })
let bridge = await startServer({ config, cwd, handleSignals: false, quiet: true })
const receipt: Record<string, unknown> = { evidence, rows: [], status: 'failed' }
async function api(path: string, body?: unknown) {
  const response = await fetch(bridge.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) })
  const data = await response.json() as any
  assert.equal(response.status, 200, JSON.stringify(data))
  return data
}
async function native(id: string) {
  return (await api(`/v1/sessions?backend=cursor&session_id=${id}`)).data[0]
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  do { const value = await read(); if (accept(value)) return value; await delay(100) } while (Date.now() < end)
  throw new Error('Live Cursor condition timed out')
}
async function processes(): Promise<number[]> {
  const found: number[] = []
  for (const pid of (await readdir('/proc')).filter((pid) => /^\d+$/.test(pid))) {
    try {
      if (await readlink(`/proc/${pid}/cwd`) === cwd && (await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('cursor-agent')) found.push(Number(pid))
    } catch { /* Process ended between enumeration and inspection. */ }
  }
  return found
}
try {
  const capabilities = await api('/v1/capabilities?model=cursor/grok-4.7-medium')
  assert.equal(capabilities.sessions.continue, true)
  assert.equal(capabilities.branching.fork, false)
  assert.equal(capabilities.profile.mcp, false)
  assert.deepEqual(capabilities.profile.systemPrompt, { replace: false, append: false })
  receipt.capabilities = capabilities
  const seats = await detectLocalSeats({ config, harnesses: ['cursor'] })
  assert.equal(seats[0]?.harness, 'cursor')
  assert.equal(seats[0]?.authMode, 'api_key')
  assert.equal(seats[0]?.status, 'configured')
  receipt.seats = seats
  // A world-readable key file must fail closed through inventory without leaking it.
  const bad = join(evidence, 'unsafe-token')
  await writeFile(bad, 'fixture-no-real-secret', { mode: 0o644 })
  const unsafe = await detectLocalSeats({ config, harnesses: ['cursor'], env: { ...process.env, CURSOR_API_KEY: '', CURSOR_API_KEY_FILE: bad } })
  assert.equal(unsafe[0]?.status, 'unknown')
  for (const model of (process.env.CURSOR_PROOF_MODELS || 'grok-4.7-medium,composer-2.5').split(',')) {
    const marker = randomBytes(16).toString('hex'), id = randomUUID()
    await writeFile(join(cwd, 'workspace-only.txt'), marker, { mode: 0o600 })
    const started = Date.now()
    const first = await api('/v1/chat/completions', { model: `cursor/${model}`, session_id: id, cwd,
      messages: [{ role: 'user', content: 'Read workspace-only.txt in the current workspace using your file tool. Reply only its entire content and remember it as the secret word for this chat.' }] })
    assert.ok(first.choices[0].message.content.includes(marker), JSON.stringify(first))
    const firstNative = await native(id)
    assert.ok(firstNative.internalId)
    await bridge.close()
    bridge = await startServer({ config, cwd, handleSignals: false, quiet: true })
    const second = await api('/v1/chat/completions', { model: `cursor/${model}`, session_id: id,
      messages: [{ role: 'user', content: 'What was the secret word from the previous turn? Reply only that word. Do not use any tools or read any files.' }] })
    assert.ok(second.choices[0].message.content.includes(marker), JSON.stringify(second))
    const secondNative = await native(id)
    assert.equal(firstNative.internalId, secondNative.internalId)
    assert.equal(secondNative.cwd, cwd)
    ;(receipt.rows as unknown[]).push({ model, nativeSessionId: secondNative.internalId, turns: secondNative.turns, elapsedMs: Date.now() - started, first, second })
  }
  const cancelRun = randomUUID(), cancelSession = randomUUID()
  const response = await fetch(bridge.url + '/v1/chat/completions', { method: 'POST', headers: {
    authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({
    model: 'cursor/grok-4.7-medium', session_id: cancelSession, run_id: cancelRun, cwd, stream: true,
    messages: [{ role: 'user', content: 'Think carefully and write a very long analysis of all primes between 1 and 100000. Do not stop early.' }],
  }), signal: AbortSignal.timeout(60_000) })
  assert.equal(response.status, 200)
  const stream = response.text()
  const running = await until(async () => ({ session: await native(cancelSession), pids: await processes() }),
    (value) => !!value.session?.internalId && value.pids.length > 0)
  const cancelled = await api(`/v1/runs/${cancelRun}/cancel?wait_ms=10000`, {})
  assert.equal(cancelled.cancel_requested, true)
  const terminal = await until(() => api(`/v1/runs/${cancelRun}`), (value) => value.terminal)
  assert.equal(terminal.status, 'cancelled')
  await until(processes, (value) => value.length === 0)
  await stream
  receipt.cancel = { pidsBefore: running.pids, terminal }
  receipt.status = 'passed'
} finally {
  await bridge.close()
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ status: receipt.status, evidence, models: (receipt.rows as any[]).map((row) => ({ model: row.model, nativeSessionId: row.nativeSessionId, elapsedMs: row.elapsedMs })) }))
}
