import Database from 'better-sqlite3'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDataDirectory } from '../runtime/single-instance.js'
import {
  EXPECTED_NAMED_INDEXES,
  EXPECTED_SESSION_SCHEMA,
  RETAINED_SCHEMA_ERROR,
  sanitizeLegacySessionMetadata,
} from './store-contract.js'

export interface OpenSessionDatabase { db: Database.Database; databasePath: string }

export function openSessionDatabase(dataDir: string): OpenSessionDatabase {
  const privateDataDir = ensurePrivateDataDirectory(dataDir)
  const databasePath = join(privateDataDir, 'sessions.sqlite')
  const db = new Database(databasePath)
  try {
    chmodSync(databasePath, 0o600)
    db.pragma('journal_mode = WAL')
    db.pragma('secure_delete = ON')
    restrictDatabaseFiles(databasePath)
    const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    const tableNames = existingTables.map(row => row.name)
    const legacySessionsOnly = tableNames.length === 1 && tableNames[0] === 'sessions'
    if (legacySessionsOnly) assertLegacySessionsSchema(db)
    if (existingTables.length === 0 || legacySessionsOnly) db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_identities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('legacy', 'retained')), created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (external_id TEXT NOT NULL, backend TEXT NOT NULL, internal_id TEXT NOT NULL, cwd TEXT, turns INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (external_id, backend));
        CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used_at);
        CREATE TABLE IF NOT EXISTS retained_sessions (id TEXT PRIMARY KEY, create_request_digest TEXT NOT NULL, backend TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT, turns INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, run_id TEXT, internal_id TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', capabilities_json TEXT NOT NULL, profile_receipt_json TEXT, context_boundary_json TEXT, jail_policy_json TEXT);
        CREATE INDEX IF NOT EXISTS idx_retained_sessions_last_used ON retained_sessions(last_used_at);
        CREATE TABLE IF NOT EXISTS retained_events (session_id TEXT NOT NULL, session_sequence INTEGER NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, cursor TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (session_id, session_sequence), UNIQUE (session_id, run_id, sequence), UNIQUE (session_id, event_id));
        CREATE INDEX IF NOT EXISTS idx_retained_events_session_cursor ON retained_events(session_id, session_sequence);
        CREATE TABLE IF NOT EXISTS retained_run_admissions (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, execution_id TEXT NOT NULL, request_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_retained_run_admissions_session ON retained_run_admissions(session_id, created_at);
        CREATE TABLE IF NOT EXISTS interaction_operations (operation_id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, interaction_id TEXT NOT NULL, request_digest TEXT NOT NULL, acknowledgement_json TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'settled', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS retained_control_operations (operation_id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, request_digest TEXT NOT NULL, acknowledgement_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      `)
      if (legacySessionsOnly) db.prepare(`INSERT INTO session_identities (id, kind, created_at) SELECT external_id, 'legacy', MIN(created_at) FROM sessions GROUP BY external_id`).run()
    })()
    assertRetainedSchema(db)
    if (scrubLegacySessionMetadata(db)) {
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.exec('VACUUM')
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
    restrictDatabaseFiles(databasePath)
    return { db, databasePath }
  } catch (error) {
    try { if (db.open) db.close() } catch { /* preserve startup error */ }
    throw error
  }
}

export function restrictDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600)
}

function assertLegacySessionsSchema(db: Database.Database): void {
  assertColumns(db, 'sessions', EXPECTED_SESSION_SCHEMA.sessions!)
  const index = (db.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string; unique: number }>).find(candidate => candidate.name === 'idx_sessions_last_used' && candidate.unique === 0)
  if (!index) failSchema(db)
  const columns = (db.prepare('PRAGMA index_info(idx_sessions_last_used)').all() as Array<{ name: string }>).map(column => column.name)
  if (JSON.stringify(columns) !== JSON.stringify(['last_used_at'])) failSchema(db)
}

function assertRetainedSchema(db: Database.Database): void {
  const actualTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
  if (JSON.stringify(actualTables) !== JSON.stringify(Object.keys(EXPECTED_SESSION_SCHEMA).sort())) failSchema(db)
  for (const [table, expected] of Object.entries(EXPECTED_SESSION_SCHEMA)) {
    assertColumns(db, table, expected)
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>
    for (const [name, columns] of Object.entries(EXPECTED_NAMED_INDEXES[table] ?? {})) {
      const index = indexes.find(candidate => candidate.name === name && candidate.unique === 0)
      if (!index) failSchema(db)
      const actual = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map(column => column.name)
      if (JSON.stringify(actual) !== JSON.stringify(columns)) failSchema(db)
    }
  }
  const uniqueShapes = (db.prepare('PRAGMA index_list(retained_events)').all() as Array<{ name: string; unique: number }>)
    .filter(index => index.unique === 1)
    .map(index => (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(column => column.name).join('\u0000'))
  if (!uniqueShapes.includes('session_id\u0000run_id\u0000sequence') || !uniqueShapes.includes('session_id\u0000event_id')) failSchema(db)
}

function assertColumns(db: Database.Database, table: string, expected: Array<{ name: string; type: string; notnull: number; defaultValue: string | null; pk: number }>): void {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>
  if (actual.length !== expected.length) failSchema(db)
  for (const [index, column] of expected.entries()) {
    const observed = actual[index]
    if (!observed || observed.name !== column.name || observed.type !== column.type || observed.notnull !== column.notnull || observed.dflt_value !== column.defaultValue || observed.pk !== column.pk) failSchema(db)
  }
}

function failSchema(db: Database.Database): never { db.close(); throw new Error(RETAINED_SCHEMA_ERROR) }

function scrubLegacySessionMetadata(db: Database.Database): boolean {
  const rows = db.prepare('SELECT external_id, backend, metadata_json FROM sessions').all() as Array<{ external_id: string; backend: string; metadata_json: string }>
  const update = db.prepare('UPDATE sessions SET metadata_json = ? WHERE external_id = ? AND backend = ?')
  let changed = false
  db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown = {}; try { parsed = JSON.parse(row.metadata_json || '{}') } catch { /* discard malformed metadata */ }
      const safe = JSON.stringify(sanitizeLegacySessionMetadata(parsed))
      if (safe !== row.metadata_json) { update.run(safe, row.external_id, row.backend); changed = true }
    }
  })()
  return changed
}
