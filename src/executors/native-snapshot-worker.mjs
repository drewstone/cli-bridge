// Trusted internal worker. The execution owner supplies the installed reader URL
// and pinned store mounts; this file owns no native format or parser. Only the
// exact shared WAL/SHM files are writable, for SQLite's normal lock/index setup.
import { lstat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

const suffixes = ['', '-wal', '-shm', '-journal']

async function identities(path) {
  const records = await Promise.all(suffixes.map(async suffix => {
    let record
    try { record = await lstat(`${path}${suffix}`, { bigint: true }) }
    catch (error) { if (suffix === '-journal' && error?.code === 'ENOENT') return null; throw error }
    if (!record.isFile() || record.nlink !== 1n) throw new Error('unsafe SQLite file')
    return record
  }))
  if (records.some(record => record && record.uid !== records[0].uid)) throw new Error('SQLite file ownership differs')
  return records
}

async function verifyIdentities(pinned, path, source) {
  for (const current of await Promise.all([identities(path), identities(source)])) {
    if (current.some((record, index) => {
      const expected = pinned[index]
      return record === null || expected === null ? record !== expected
        : record.dev !== expected.dev || record.ino !== expected.ino || record.uid !== expected.uid
    })) throw new Error('SQLite source identity changed')
  }
}

let input = ''
try {
  for await (const bytes of process.stdin) {
    input += bytes.toString('utf8')
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('bounded input')
  }
  const ids = JSON.parse(input)
  const reader = await import(process.argv[2])
  if (typeof reader.captureOpenCodeSessionStore !== 'function') throw new Error('unsupported reader')
  const path = process.argv[3], source = process.argv[4]
  if (!path || !source) throw new Error('missing source views')
  // Static checks refuse special files before SQLite can block opening a journal.
  // The parent jail/deadline owns replacement races; these checks are not a sandbox.
  const pinned = await identities(path)
  await verifyIdentities(pinned, path, source)
  const custody = new DatabaseSync(path, { readOnly: true })
  let captured
  try {
    custody.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    custody.prepare('SELECT name FROM sqlite_schema LIMIT 1').get()
    // A real read transaction prevents ordinary SQLite close/checkpoint from
    // removing shared companions during verification and the reader's projection.
    await verifyIdentities(pinned, path, source)
    captured = await reader.captureOpenCodeSessionStore(path, ids, { corruption: 'strict' })
    await verifyIdentities(pinned, path, source)
  } finally {
    // Both connections use node:sqlite, which coordinates same-inode locks and
    // deferred descriptor closes. Never open/close raw database FDs in this worker.
    custody.close()
  }
  process.stdout.write(JSON.stringify({ nativeSessionIds: captured.nativeSessionIds, bytes: Buffer.from(captured.bytes).toString('base64') }))
} catch {
  // No native record values or credential-shaped paths become diagnostics.
  process.stderr.write('Native session snapshot failed\n')
  process.exitCode = 1
}
