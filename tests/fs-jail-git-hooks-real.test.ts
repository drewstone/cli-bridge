/**
 * A commit inside an fs-jail runs the operator's global `core.hooksPath`.
 *
 * Reported 2026-11-07 (agent-container `tangle graph run`, runs 278f12eb and
 * 34bb2395): with HOME redirected into the jail the confined git saw no global
 * config, so it had no identity and ran the clone's template hooks, which
 * looked for their tool under the jail HOME; every commit failed. The hooks
 * here mirror that dotfiles layout: a hooks dir whose hook execs a sibling
 * `bin/` script through `$(dirname "$0")/../..`.
 *
 * Real bwrap, real git; skipped where bwrap cannot create its namespaces.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitConfigSources } from '../src/jail/auth-preserve.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const ENABLED = new LinuxBwrapJail().isAvailable()
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fs-jail-git-hooks-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('git hooks under the fs-jail', () => {
  it.skipIf(!ENABLED)('commits through the global core.hooksPath and the tool its hook execs', async () => {
    const home = join(base, 'home')
    const dotfiles = join(base, 'dotfiles')
    const project = join(base, 'project')
    for (const dir of [home, join(dotfiles, 'git', 'hooks'), join(dotfiles, 'bin'), project]) mkdirSync(dir, { recursive: true })
    const script = (path: string, body: string) => {
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    script(join(dotfiles, 'git', 'hooks', 'pre-commit'), 'exec "$(cd "$(dirname "$0")/../.." && pwd)/bin/check"')
    script(join(dotfiles, 'bin', 'check'), 'echo hook-tool-ran >&2')
    writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Jail Test\n\temail = jail@example.test\n[core]\n\thooksPath = ${join(dotfiles, 'git', 'hooks')}\n`)
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }
    const host = (...args: string[]) => spawnSync('git', ['-C', project, ...args], { env, encoding: 'utf8' })
    // The dotfiles checkout is a git work tree: the hooks dir widens to it.
    expect(spawnSync('git', ['init', '-q', dotfiles], { env }).status).toBe(0)
    expect(host('init', '-q').status).toBe(0)
    writeFileSync(join(project, 'a.txt'), 'a\n')
    expect(host('add', 'a.txt').status).toBe(0)

    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    delete process.env.XDG_CONFIG_HOME
    try {
      const wrap = await new LinuxBwrapJail().wrap('git', ['commit', '-q', '-m', 'jailed'], {
        root: join(project, '.agent-home'),
        projectDir: project,
        readConfine: true,
        authSources: gitConfigSources(),
      })
      const run = spawnSync(wrap.bin, wrap.args, { env, encoding: 'utf8' })
      expect(run.stderr).toContain('hook-tool-ran')
      expect(run.status, run.stderr).toBe(0)
      expect(host('log', '-1', '--format=%an <%ae> %s').stdout.trim()).toBe('Jail Test <jail@example.test> jailed')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
