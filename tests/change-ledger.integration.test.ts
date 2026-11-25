/**
 * The change ledger Bridge writes for the turns it runs, through the real Bridge listener and the real retained turn
 * path. The harness is tests/fixtures/codex-app-server.cjs, whose `commit <file> <branch>` turn makes a commit in the
 * session's working repository and pushes it to a local bare remote that stands in for GitHub. `gh` is a scripted
 * stand-in that lists two pull requests of the pushed branch, one created and one merged now. No model is called.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const BEARER = 'change-ledger'
const MODEL = 'codex/tangle/canary-echo'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'codex-app-server.cjs')

type Row = Record<string, any>

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A working repository whose origin is named like a GitHub repository and pushes to a local bare repository. */
async function makeRepo(root: string, name: string): Promise<string> {
  const bare = join(root, `${name}.git`)
  const work = join(root, 'work', name)
  git(root, 'init', '-q', '--bare', bare)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'config', 'user.email', 'fixture@example.invalid')
  git(work, 'config', 'user.name', 'Fixture')
  git(work, 'config', 'commit.gpgsign', 'false')
  // The machine's global hooks refuse fixture identities; this repository is a throwaway.
  git(work, 'config', 'core.hooksPath', '/dev/null')
  git(work, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  git(work, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/acme/widgets.git')
  await writeFile(join(work, 'README.md'), 'start\n')
  git(work, 'add', 'README.md')
  git(work, 'commit', '-q', '-m', 'start')
  return work
}

/** A `gh` that lists two pull requests of the branch `feature`: #7 created now and #5, created long ago, merged now. */
async function writeGh(path: string, log: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const head = args[args.indexOf('--head') + 1]
const now = new Date().toISOString()
console.log(JSON.stringify(head === 'feature'
  ? [{ number: 7, createdAt: now, mergedAt: null }, { number: 5, createdAt: '2020-01-01T00:00:00Z', mergedAt: now }]
  : []))
`, { mode: 0o700 })
}

async function ledgerRows(ledger: string): Promise<Row[]> {
  const file = join(ledger, 'changes.jsonl')
  if (!existsSync(file)) return []
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row)
}

/** The ledger's rows for one turn, once the turn's `turn` row has landed. */
async function rowsOfTurn(ledger: string, turnId: string): Promise<Row[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await ledgerRows(ledger)
    if (rows.some((row) => row.turnId === turnId && row.action === 'turn')) return rows.filter((row) => row.turnId === turnId)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

describe('change ledger rows of retained turns', { timeout: 60_000 }, () => {
  let root: string, bridge: BridgeServer, ledger: string, ghLog: string
  let counter = 0
  const opened: string[] = []

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'change-ledger-')))
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'work'))
    await mkdir(join(root, 'codex-home'))
    ledger = join(root, 'ledger')
    ghLog = join(root, 'gh.log')
    const bin = join(root, 'bin', 'codex')
    await writeFile(bin, `#!${process.execPath}\n${await readFile(FIXTURE, 'utf8')}`, { mode: 0o700 })
    await writeGh(join(root, 'bin', 'gh'), ghLog)
    vi.stubEnv('CODEX_TANGLE_ROUTER_URL', 'https://router.invalid/v1')
    vi.stubEnv('TANGLE_API_KEY', 'router-key-for-the-fixture')
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'))
    vi.stubEnv('CLI_BRIDGE_GH_BIN', join(root, 'bin', 'gh'))
    bridge = await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin, CHANGE_LEDGER_DIR: ledger }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
  }, 60_000)
  afterEach(async () => {
    for (const id of opened.splice(0)) await call(`/v1/sessions/${id}/close`, {})
  })
  afterAll(async () => {
    await bridge?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const call = async (path: string, body?: unknown) => await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const repo = (name: string) => makeRepo(root, name)

  const open = async (cwd: string) => {
    const id = `ledger-${++counter}`
    opened.push(id)
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    return id
  }

  /** Start one turn and wait for its run to end. Returns the turn id and the run's status. */
  const startTurn = async (id: string, message: string) => {
    const turnId = `${id}-turn-${++counter}`
    const response = await call(`/v1/sessions/${id}/turns`, { message, turn_id: turnId, run_id: `${turnId}-run`, execution_id: `${turnId}-execution` })
    const body = await response.json() as Row
    expect(response.status, JSON.stringify(body)).toBeLessThan(300)
    return { turnId, runId: String(body.run.id) }
  }
  const finish = async (runId: string) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const snapshot = await (await call(`/v1/runs/${encodeURIComponent(runId)}`)).json() as { terminal?: boolean; status?: string }
      if (snapshot.terminal) return snapshot.status
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`run ${runId} did not end`)
  }
  const turn = async (id: string, message: string) => {
    const started = await startTurn(id, message)
    expect(await finish(started.runId)).toBe('done')
    return started.turnId
  }

  const rowsOf = (turnId: string) => rowsOfTurn(ledger, turnId)
  const sessionRows = async (sessionId: string): Promise<Row[]> => (await ledgerRows(ledger)).filter((row) => row.sessionId === sessionId)

  it('writes observed, the turn, the commit, the push and the pull request actions of a turn, keyed to the session, harness and turn', async () => {
    const cwd = await repo('first')
    const id = await open(cwd)
    const before = git(cwd, 'rev-parse', 'HEAD')
    const turnId = await turn(id, 'commit one.txt feature')
    const after = git(cwd, 'rev-parse', 'HEAD')
    expect(after).not.toBe(before)
    const rows = await rowsOf(turnId)
    expect(rows.map((row) => row.action)).toEqual(['observed', 'turn', 'commit', 'push', 'pr-create', 'pr-merge'])
    for (const row of rows) {
      expect(row).toMatchObject({ v: 1, harness: 'codex', sessionId: id, turnId, agentId: null, toolUseId: null, source: 'cli-bridge', remote: 'acme/widgets' })
      expect(typeof row.nativeSessionId).toBe('string')
      expect(row.nativeSessionId).not.toBe('')
      expect(Date.parse(row.turnStartedAt)).toBeLessThanOrEqual(Date.parse(row.at))
    }
    expect(rows[1]).toMatchObject({ headBefore: before, head: after, incomplete: null })
    expect(rows[2]).toMatchObject({ sha: after })
    expect(rows[3]).toMatchObject({ branch: 'feature', sha: after })
    expect(rows[4]).toMatchObject({ pr: 7 })
    expect(rows[5]).toMatchObject({ pr: 5 })
    expect(await readFile(ghLog, 'utf8')).toContain('--repo acme/widgets --head feature')
  })

  it('writes observed once, and a turn that changed nothing writes only its turn row with HEAD unchanged', async () => {
    const cwd = await repo('second')
    const id = await open(cwd)
    await turn(id, 'remember kiwi')
    const quiet = await turn(id, 'recall')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const rows = await rowsOf(quiet)
    expect(rows.map((row) => row.action)).toEqual(['turn'])
    expect(rows[0]).toMatchObject({ headBefore: head, head, incomplete: null })
    expect((await sessionRows(id)).filter((row) => row.action === 'observed')).toHaveLength(1)
  })

  it('writes no row for a turn whose working directory is not a repository, and the session no longer proves "no change"', async () => {
    const plain = join(root, 'work', 'plain')
    await mkdir(plain)
    const id = await open(plain)
    await turn(id, 'remember kiwi')
    await turn(id, 'recall')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await sessionRows(id)).toEqual([])
  })

  it('does not attribute commits to a turn that shared its checkout with another running turn, and says so', async () => {
    const cwd = await repo('shared')
    const slow = await open(cwd)
    const fast = await open(cwd)
    const running = await startTurn(slow, 'wait 2')
    const committed = await startTurn(fast, 'commit two.txt')
    expect(await finish(committed.runId)).toBe('done')
    expect(await finish(running.runId)).toBe('done')
    const fastRows = await rowsOf(committed.turnId)
    expect(fastRows.map((row) => row.action)).toEqual(['observed', 'turn'])
    expect(fastRows[1]).toMatchObject({ incomplete: 'shared-checkout' })
    const slowRows = await rowsOf(running.turnId)
    expect(slowRows.map((row) => row.action)).toEqual(['observed', 'turn'])
    expect(slowRows[1]).toMatchObject({ incomplete: 'shared-checkout' })
  })
})

/** One-shot chat turns of a session, the path every Braid lane takes: `/v1/chat/completions` with a `session_id`. */
describe('change ledger rows of one-shot chat turns', { timeout: 60_000 }, () => {
  let root: string, bridge: BridgeServer, ledger: string
  let counter = 0
  const NATIVE = '00000000-0000-4000-8000-00000000715e'
  // Claude Code's stream-json, answering `commit <file> <branch>` by committing and pushing in its working directory.
  const stub = String.raw`
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('2.1.326 (Claude Code)'); process.exit(0) }
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const ask = /commit (\S+) ?(\S*)/.exec(process.argv.join(' '))
if (ask) {
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), stdio: 'ignore' })
  fs.writeFileSync(ask[1], ask[1] + '\n')
  git('add', ask[1])
  git('commit', '-m', 'fixture ' + ask[1])
  if (ask[2]) git('push', 'origin', 'HEAD:refs/heads/' + ask[2])
}
emit({ type: 'system', subtype: 'init', session_id: '${NATIVE}', model: 'claude-sonnet' })
emit({ type: 'assistant', uuid: 'a-1', message: { id: 'm-1', model: 'claude-sonnet', content: [{ type: 'text', text: 'done' }] } })
emit({ type: 'result', subtype: 'success', session_id: '${NATIVE}', result: 'done', is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 })
`

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'change-ledger-chat-')))
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'work'))
    ledger = join(root, 'ledger')
    const bin = join(root, 'bin', 'claude.cjs')
    await writeFile(bin, `#!${process.execPath}\n${stub}`, { mode: 0o700 })
    await writeGh(join(root, 'bin', 'gh'), join(root, 'gh.log'))
    vi.stubEnv('CLI_BRIDGE_GH_BIN', join(root, 'bin', 'gh'))
    bridge = await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', CLAUDE_BIN: bin, CHANGE_LEDGER_DIR: ledger }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
  }, 60_000)
  afterAll(async () => {
    await bridge?.close()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const chat = async (sessionId: string, cwd: string, content: string) => {
    const runId = `run-${++counter}`
    const response = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json', 'idempotency-key': runId },
      body: JSON.stringify({ model: 'claude-code/anthropic/sonnet', cwd, stream: false, session_id: sessionId, messages: [{ role: 'user', content }] }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return runId
  }

  /** The session's rows, once `turns` turn rows have landed. */
  const rowsOfSession = async (sessionId: string, turns: number): Promise<Row[]> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = (await ledgerRows(ledger)).filter((row) => row.sessionId === sessionId)
      if (found.filter((row) => row.action === 'turn').length >= turns) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return []
  }

  it('records a session\'s turns under the Claude Code harness name, with the native session id the turn named', async () => {
    const cwd = await makeRepo(root, 'chat')
    const before = git(cwd, 'rev-parse', 'HEAD')
    await chat('lane-1', cwd, 'commit lane.txt feature')
    const after = git(cwd, 'rev-parse', 'HEAD')
    expect(after).not.toBe(before)
    const rows = await rowsOfSession('lane-1', 1)
    expect(rows.map((row) => row.action)).toEqual(['observed', 'turn', 'commit', 'push', 'pr-create', 'pr-merge'])
    for (const row of rows) {
      expect(row).toMatchObject({ v: 1, harness: 'claude-code', sessionId: 'lane-1', nativeSessionId: NATIVE, source: 'cli-bridge', remote: 'acme/widgets' })
      expect(typeof row.turnId).toBe('string')
    }
    expect(rows[1]).toMatchObject({ headBefore: before, head: after, incomplete: null })
    expect(rows[2]).toMatchObject({ sha: after })

    await chat('lane-1', cwd, 'look around')
    const later = await rowsOfSession('lane-1', 2)
    expect(later.filter((row) => row.action === 'observed')).toHaveLength(1)
    expect(later.slice(rows.length).map((row) => row.action)).toEqual(['turn'])
    expect(later.at(-1)).toMatchObject({ headBefore: after, head: after, incomplete: null })
  })
})
