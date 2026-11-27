/** Real OpenCode SQLite and Linux filesystem jail; no provider or model is called. */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { opencodeDatabaseEnv } from '../src/backends/opencode-database.js'
import type { ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import { terminateSpawned } from '../src/executors/process-tree.js'
import { LinuxBwrapJail } from '../src/jail/index.js'
import type { SessionRecord } from '../src/sessions/store.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const enabled = existsSync(BIN) && new LinuxBwrapJail().isAvailable() && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'

describe.skipIf(!enabled)('parallel jailed OpenCode databases', () => {
  let root: string, cwd: string
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-database-real-')))
    cwd = join(root, 'work')
    await mkdir(cwd)
  })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  function request(id: string): ChatRequest {
    return {
      cwd, session_id: id, model: 'opencode', messages: [],
      jailSpec: { projectDir: cwd, root: join(cwd, '.agent-home'), readConfine: true,
        backend: 'bwrap', network: 'none', fallback: 'deny' },
    }
  }

  async function query(req: ChatRequest, sql: string, session: SessionRecord | null = null, legacy = false) {
    const spawned = await hostSpawner(BIN, ['db', sql, '--format', 'json'], {
      cwd, jail: req.jailSpec!, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CHANNEL_DB: '1',
        ...(legacy ? {} : opencodeDatabaseEnv(req, session)) },
    })
    let stdout = '', stderr = ''
    spawned.child.stdout!.on('data', (chunk) => { stdout += chunk })
    spawned.child.stderr!.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => { void terminateSpawned(spawned) }, 60_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        spawned.child.once('error', reject)
        spawned.child.once('close', resolve)
      })
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timeout)
      await terminateSpawned(spawned)
      spawned.release()
    }
  }

  it('initializes cold session databases concurrently, retains each one, and leaves the legacy native store intact', async () => {
    const a = request('node/a'), b = request('node?a')
    const initialized = await Promise.all([a, b].map((req) => query(req, 'CREATE TABLE bridge_probe (value TEXT)')))
    for (const result of initialized) expect(result.code, result.stderr).toBe(0)
    const dbA = opencodeDatabaseEnv(a, null).OPENCODE_DB!, dbB = opencodeDatabaseEnv(b, null).OPENCODE_DB!
    expect(dbA).not.toBe(dbB)
    expect(existsSync(dbA)).toBe(true)
    expect(existsSync(dbB)).toBe(true)
    const inserts = await Promise.all([query(a, "INSERT INTO bridge_probe VALUES ('a')"), query(b, "INSERT INTO bridge_probe VALUES ('b')")])
    for (const result of inserts) expect(result.code, result.stderr).toBe(0)
    const resumed: SessionRecord = { externalId: a.session_id!, internalId: 'existing-native-id', backend: 'opencode',
      cwd, turns: 1, createdAt: 1, lastUsedAt: 1, metadata: {} }
    const read = await query(a, 'SELECT value FROM bridge_probe', resumed)
    expect(read.code, read.stderr).toBe(0)
    expect(JSON.parse(read.stdout)).toEqual([{ value: 'a' }])

    const old = request('legacy-session')
    const oldSession = { ...resumed, externalId: old.session_id! }
    const seeded = await query(old, 'CREATE TABLE bridge_legacy (value TEXT)', null, true)
    expect(seeded.code, seeded.stderr).toBe(0)
    expect(opencodeDatabaseEnv(old, oldSession).OPENCODE_DB).toBeUndefined()
    const legacyDatabase = join(cwd, '.agent-home', '.local', 'share', 'opencode', 'opencode.db')
    const lock = new Database(legacyDatabase)
    try {
      lock.exec('BEGIN IMMEDIATE')
      // A real default-store writer reproduces SQLITE_BUSY, while distinct native sessions
      // keep their bounded parallelism. There is no retry of unknown native tool effects.
      const [blocked, ...isolated] = await Promise.all([
        query(old, "INSERT INTO bridge_legacy VALUES ('blocked')", oldSession),
        query(a, "INSERT INTO bridge_probe VALUES ('continued-a')", resumed),
        query(b, "INSERT INTO bridge_probe VALUES ('continued-b')"),
      ])
      expect(blocked!.code).not.toBe(0)
      expect(blocked!.stderr).toMatch(/locked|SQLITE_BUSY/i)
      for (const result of isolated) expect(result.code, result.stderr).toBe(0)
    } finally { lock.exec('ROLLBACK'); lock.close() }
    const retained = await query(a, 'SELECT value FROM bridge_probe ORDER BY rowid', resumed)
    expect(retained.code, retained.stderr).toBe(0)
    expect(JSON.parse(retained.stdout)).toEqual([{ value: 'a' }, { value: 'continued-a' }])
    const legacyRead = await query(old, 'SELECT value FROM bridge_legacy', oldSession)
    expect(legacyRead.code, legacyRead.stderr).toBe(0)
    expect(JSON.parse(legacyRead.stdout)).toEqual([])
  }, 180_000)
})
