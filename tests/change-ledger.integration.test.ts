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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const BEARER = 'change-ledger'
const MODEL = 'codex/tangle/canary-echo'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'codex-app-server.cjs')

type Row = Record<string, any>

describe('change ledger rows of retained turns', () => {
  let root: string, bridge: BridgeServer, ledger: string, ghLog: string
  let counter = 0

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'change-ledger-')))
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'work'))
    await mkdir(join(root, 'codex-home'))
    ledger = join(root, 'ledger')
    ghLog = join(root, 'gh.log')
    const bin = join(root, 'bin', 'codex')
    await writeFile(bin, `#!${process.execPath}\n${await readFile(FIXTURE, 'utf8')}`, { mode: 0o700 })
    await writeFile(join(root, 'bin', 'gh'), `#!${process.execPath}
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n')
const head = args[args.indexOf('--head') + 1]
const now = new Date().toISOString()
console.log(JSON.stringify(head === 'feature'
  ? [{ number: 7, createdAt: now, mergedAt: null }, { number: 5, createdAt: '2020-01-01T00:00:00Z', mergedAt: now }]
  : []))
`, { mode: 0o700 })
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

  /** A working repository whose origin is named like a GitHub repository and pushes to a local bare repository. */
  const repo = async (name: string) => {
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

  const open = async (cwd: string) => {
    const id = `ledger-${++counter}`
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

  /** The ledger's rows for one turn, once the turn's `turn` row has landed. */
  const rowsOf = async (turnId: string): Promise<Row[]> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const file = join(ledger, 'changes.jsonl')
      if (existsSync(file)) {
        const rows = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row)
        if (rows.some((row) => row.turnId === turnId && row.action === 'turn')) return rows.filter((row) => row.turnId === turnId)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return []
  }
  const sessionRows = async (sessionId: string): Promise<Row[]> => {
    const file = join(ledger, 'changes.jsonl')
    if (!existsSync(file)) return []
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row)
      .filter((row) => row.sessionId === sessionId)
  }

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
