/** Real Git and bwrap: global hooks run, enforce privacy and remain read-only. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const jail = new LinuxBwrapJail(), enabled = jail.isAvailable()
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fs-jail-git-hooks-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('Git hooks under the fs-jail', () => {
  it.skipIf(!enabled).each(['default', 'override', 'symlink', 'tilde', 'xdg', 'escape', 'conditional', 'onbranch', 'relative', 'workspace-tmp', 'writable-tmp', 'alias-tmp', 'outbound-tmp'])('%s global hooks enforce commits without opening the owner checkout', async (kind) => {
    const root = join(base, kind), home = join(root, 'home'), tools = join(root, 'tools'), project = join(kind === 'conditional' ? home : root, 'project')
    for (const dir of [join(home, '.config/privacy'), join(tools, 'git/hooks'), join(tools, 'bin'), project]) mkdirSync(dir, { recursive: true })
    const script = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755) }
    script(join(tools, 'git/hooks/pre-commit'), 'exec "$(cd -P "$(dirname "$0")/../.." && pwd)/bin/check"')
    script(join(tools, 'bin/check'), 'if grep -qx "$(git show :a.txt)" "$GIT_PRIVACY_DENYLIST"; then echo privacy-denied >&2; exit 1; fi; echo hook-tool-ran >&2')
    const xdg = join(home, 'custom-config'); mkdirSync(join(xdg, 'git'), { recursive: true })
    const hooks = ['symlink', 'tilde'].includes(kind) ? join(home, 'hook-alias') : join(tools, 'git/hooks')
    if (['symlink', 'tilde'].includes(kind)) symlinkSync(join(tools, 'git/hooks'), hooks, 'dir')
    const config = kind === 'override' ? join(root, 'custom-gitconfig') : kind === 'xdg' ? join(xdg, 'git/config') : join(home, '.gitconfig')
    // The hooks path comes from a relative include, as in common split global configurations.
    writeFileSync(config, `[user]\n name = Jail Test\n email = jail@example.test\n${kind === 'conditional' ? '[includeIf "gitdir:~/project/"]' : kind === 'onbranch' ? '[includeIf "onbranch:feature-hook"]' : '[include]'}\n path = ${kind === 'escape' ? '../' : ''}${kind === 'override' ? 'home/' : ''}hooks-config\n`)
    writeFileSync(kind === 'escape' ? join(root, 'hooks-config') : kind === 'xdg' ? join(xdg, 'git/hooks-config') : join(home, 'hooks-config'), `[core]\n hooksPath = ${kind === 'tilde' ? '~/hook-alias' : kind === 'relative' ? '.hooks' : hooks}\n`)
    writeFileSync(join(home, '.config/privacy/denylist'), 'blocked-fixture\n')
    writeFileSync(join(home, 'private'), 'hidden\n')
    if (kind === 'relative') for (const prefix of ['', 'nested/']) {
      mkdirSync(join(project, prefix, '.hooks'), { recursive: true })
      script(join(project, prefix, '.hooks/pre-commit'), `${prefix ? 'echo nested-hook-ran >&2;' : ''} if grep -qx "$(git show :a.txt)" "$GIT_PRIVACY_DENYLIST"; then echo privacy-denied >&2; exit 1; fi; echo hook-tool-ran >&2`)
    }
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...(kind === 'override' ? { GIT_CONFIG_GLOBAL: config } : {}), ...(kind === 'xdg' ? { XDG_CONFIG_HOME: xdg } : {}) }
    const host = (...args: string[]) => spawnSync('git', ['-C', project, ...args], { env, encoding: 'utf8' })
    expect(spawnSync('git', ['init', '-q', tools], { env }).status).toBe(0)
    expect(spawnSync('git', ['-C', tools, 'add', 'git', 'bin'], { env }).status).toBe(0)
    writeFileSync(join(tools, 'untracked-secret'), 'hidden\n')
    expect(host('init', '-q').status).toBe(0)
    writeFileSync(join(project, 'a.txt'), 'allowed\n'); expect(host('add', 'a.txt').status).toBe(0)
    const temporary = join(['workspace-tmp', 'alias-tmp'].includes(kind) ? project : root, 'operator-tmp'); mkdirSync(temporary)
    if (kind === 'alias-tmp') symlinkSync(temporary, join(home, 'tmp-alias'), 'dir')
    if (kind === 'outbound-tmp') symlinkSync(temporary, join(project, 'tmp-alias'), 'dir')
    const saved = Object.fromEntries(['TMPDIR', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_PRIVACY_DENYLIST'].map((key) => [key, process.env[key]]))
    if (kind.endsWith('-tmp')) process.env.TMPDIR = kind === 'alias-tmp' ? join(home, 'tmp-alias') : kind === 'outbound-tmp' ? join(project, 'tmp-alias') : temporary
    process.env.HOME = home
    if (kind === 'xdg') process.env.XDG_CONFIG_HOME = xdg
    else delete process.env.XDG_CONFIG_HOME
    delete process.env.GIT_PRIVACY_DENYLIST
    if (kind === 'override') process.env.GIT_CONFIG_GLOBAL = config
    else delete process.env.GIT_CONFIG_GLOBAL
    try {
      const run = async (bin: string, args: string[]) => {
        const wrap = await jail.wrap(bin, args, { root: join(project, '.agent-home'), projectDir: project, readConfine: true, ...(kind === 'writable-tmp' ? { extraWritablePaths: [temporary] } : {}) })
        const config = kind.endsWith('-tmp') ? wrap.args[wrap.args.findIndex((arg, i) => arg === '--ro-bind' && wrap.args[i + 2] === join(project, '.agent-home/.gitconfig')) + 1] : undefined
        if (config) {
          expect(existsSync(config)).toBe(true); expect(realpathSync(config)).toBe(config)
          expect(config.startsWith(`${project}/`)).toBe(false)
        }
        try { return spawnSync(wrap.bin, wrap.args, { env, encoding: 'utf8' }) } finally {
          await wrap.cleanup?.(); if (config) expect(existsSync(config)).toBe(false)
        }
      }
      const allowed = kind === 'onbranch' ? await run('sh', ['-c', 'git switch -c feature-hook && git commit -qm jailed']) : await run('git', ['commit', '-q', '-m', 'jailed'])
      expect(allowed.stderr).toContain('hook-tool-ran'); expect(allowed.status, allowed.stderr).toBe(0)
      expect(host('log', '-1', '--format=%an <%ae> %s').stdout.trim()).toBe('Jail Test <jail@example.test> jailed')
      if (kind === 'relative') {
        const nested = await run('sh', ['-c', 'git -C nested init -q && echo allowed > nested/a.txt && git -C nested add a.txt && git -C nested commit -qm nested-jailed'])
        expect(nested.stderr).toContain('nested-hook-ran'); expect(nested.status, nested.stderr).toBe(0)
      }
      writeFileSync(join(project, 'a.txt'), 'blocked-fixture\n'); expect(host('add', 'a.txt').status).toBe(0)
      const refused = await run('git', ['commit', '-q', '-m', 'must be refused'])
      expect(refused.stderr).toContain('privacy-denied'); expect(refused.status).not.toBe(0)
      expect(host('rev-list', '--count', 'HEAD').stdout.trim()).toBe('1')
      const hidden = [join(home, 'private'), join(tools, 'untracked-secret'), join(tools, '.git/config')]
      expect((await run('sh', ['-c', 'for path; do test ! -r "$path" || exit 1; done', 'sh', ...hidden])).status, hidden.join('\n')).toBe(0)
      if (kind.endsWith('-tmp')) expect((await run('sh', ['-c', 'test -z "$(find "$1" -type f -print -quit)"', 'sh', temporary])).status).toBe(0)
      const readonly = await run('sh', ['-c', 'echo corrupt >> "$1"', 'sh', join(tools, 'bin/check')])
      expect(readonly.status).not.toBe(0)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 20_000)
})
