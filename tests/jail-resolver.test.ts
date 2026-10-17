/** Real filesystem-jail boundary: DNS remains usable without exposing sibling workspaces. */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const exec = promisify(execFile)
const jail = new LinuxBwrapJail()
const available = jail.isAvailable()
if (process.env.CLI_BRIDGE_REAL_OPENCODE_TESTS === '1' && !available) {
  throw new Error('The requested live proof requires a working Linux filesystem jail')
}

test.runIf(available)('reads the real DNS resolver read-only while hiding a sibling file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jail-resolver-'))
  const workspace = join(root, 'workspace')
  const hidden = join(root, 'private-sibling')
  await mkdir(workspace)
  await writeFile(hidden, randomBytes(32), { mode: 0o600 })
  const expected = createHash('sha256').update(await readFile('/etc/resolv.conf')).digest('hex')
  const script = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const digest = crypto.createHash('sha256').update(fs.readFileSync('/etc/resolv.conf')).digest('hex');
    let writable = false;
    try { const fd = fs.openSync('/etc/resolv.conf', 'r+'); fs.closeSync(fd); writable = true; }
    catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    let siblingVisible = false;
    try { fs.readFileSync(process.argv[1]); siblingVisible = true; }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    process.stdout.write(JSON.stringify({ digest, writable, siblingVisible }));
  `
  let wrapped
  try {
    wrapped = await jail.wrap(process.execPath, ['-e', script, hidden], {
      root: join(workspace, '.agent-home'), projectDir: workspace,
      readConfine: true, requireEnforcement: true,
    })
    const result = await exec(wrapped.bin, wrapped.args, {
      cwd: workspace, timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: root },
    })
    expect(JSON.parse(result.stdout)).toEqual({ digest: expected, writable: false, siblingVisible: false })
  } finally {
    await wrapped?.cleanup?.()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
