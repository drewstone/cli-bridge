import { expect, it } from 'vitest'
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureConfinedOpenCodeStore } from '../src/executors/native-snapshot.js'

it.each(['fifo', 'hardlink'] as const)('refuses unsafe shared SQLite %s before launching the reader and leaves source files intact', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'native-snapshot-boundary-'))
  const store = join(root, 'store'), spool = join(root, 'spool'), main = join(store, 'opencode.db')
  await Promise.all([mkdir(store), mkdir(spool, { mode: 0o700 })])
  await writeFile(main, 'primary source is unchanged')
  const canary = join(root, 'canary')
  await writeFile(canary, 'do not modify')
  if (kind === 'fifo') execFileSync('mkfifo', [main + '-wal'])
  else await link(canary, main + '-shm')
  const directory = await open(store, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const database = await open(main, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await expect(captureConfinedOpenCodeStore(directory, database, ['native-root'], spool))
      .rejects.toMatchObject({ reason: 'native-snapshot-companion-outside-host-policy' })
    expect(await readFile(main, 'utf8')).toBe('primary source is unchanged')
    expect(await readFile(canary, 'utf8')).toBe('do not modify')
    expect(await readdir(spool)).toEqual([])
    if (kind === 'fifo') expect((await stat(main + '-wal')).isFIFO()).toBe(true)
    else {
      expect((await stat(main + '-shm')).nlink).toBe(2)
      expect((await stat(main + '-wal')).isFile()).toBe(true)
      expect((await stat(main + '-wal')).size).toBe(0)
    }
  } finally {
    await database.close(); await directory.close()
    await rm(root, { recursive: true, force: true })
  }
})
