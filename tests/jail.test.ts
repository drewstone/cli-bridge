/**
 * Composition tests for the local write-jail backends.
 *
 * These assert that the argv-rewriting logic composes correctly WITHOUT
 * ever spawning a sandbox: the backends only build the wrapper argv (and,
 * for seatbelt, an SBPL profile file), so we can call each backend
 * directly and inspect the result regardless of the host OS.
 *
 *   - bwrap (Linux): wraps in a bubblewrap invocation that ro-binds the
 *     host, writable-binds the jail root, sets HOME, and chdir's into the
 *     project dir, ending in the original command.
 *   - seatbelt (macOS): emits a sandbox-exec invocation pointing at a
 *     generated profile that denies all writes then re-allows the root.
 *   - NoopJail: pass-through, argv unchanged.
 *   - resolveJailSpec: null when off; root clamped inside cwd.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LinuxBwrapJail,
  MacosSeatbeltJail,
  NoopJail,
  resolveJailRoot,
} from '../src/jail/index.js'
import { DEFAULT_JAIL_ROOT, resolveJailSpec } from '../src/jail/resolve-spec.js'
import { applyJail } from '../src/executors/jail-support.js'
import { authSourcesFor, jailRelPath } from '../src/jail/auth-preserve.js'
import { ignoreJailRoot } from '../src/jail/types.js'
import { anyBackendSpawnsOnHost } from '../src/config.js'
import type { BackendExecutorConfig } from '../src/config.js'
import type { JailBackend } from '../src/jail/index.js'

/** Index of the first position where `seq` appears contiguously in `argv`, else -1. */
function seqIndex(argv: string[], ...seq: string[]): number {
  for (let i = 0; i + seq.length <= argv.length; i++) {
    let ok = true
    for (let j = 0; j < seq.length; j++) {
      if (argv[i + j] !== seq[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
})

async function tempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-jail-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('LinuxBwrapJail.wrap', () => {
  it('builds a bwrap argv that ro-binds the host, writable-binds the root, sets HOME/chdir, and ends in the original command', async () => {
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const cmd = 'echo jailed'

    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', cmd], { root, projectDir })

    // Runs unprivileged: bwrap IS the spawned bin (no sudo prefix).
    expect(wrap.bin).toBe('bwrap')
    const argv = [wrap.bin, ...wrap.args]
    expect(argv).not.toContain('sudo')

    const expectedRoot = resolveJailRoot(root, projectDir)

    expect(argv).toContain('--ro-bind')
    expect(seqIndex(argv, '--bind', expectedRoot), 'writable --bind of the jail root').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--setenv', 'HOME', expectedRoot), 'HOME set to the jail root').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--setenv', 'XDG_CONFIG_HOME', join(expectedRoot, '.config')), 'XDG_CONFIG_HOME redirected into the jail').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--setenv', 'XDG_CACHE_HOME', join(expectedRoot, '.cache')), 'XDG_CACHE_HOME redirected into the jail').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--setenv', 'TMPDIR', join(expectedRoot, '.tmp')), 'TMPDIR redirected into the jail').toBeGreaterThanOrEqual(0)
    expect(argv, 'no tmpfs shadowing /tmp (would hide materialized configs)').not.toContain('--tmpfs')
    expect(seqIndex(argv, '--chdir', projectDir), 'chdir into the project dir').toBeGreaterThanOrEqual(0)

    // The original command is the tail of the argv.
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', cmd])

    // The jail root is gitignored so scratch/copied-creds never get committed.
    const gi = await readFile(join(expectedRoot, '.gitignore'), 'utf8')
    expect(gi).toContain('*')

    // The project dir is exposed read-only.
    expect(seqIndex(argv, '--ro-bind', projectDir, projectDir)).toBeGreaterThanOrEqual(0)
  })
})

describe('MacosSeatbeltJail.wrap', () => {
  it('emits a sandbox-exec invocation whose profile denies file-write* and re-allows the jail root', async () => {
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')

    const wrap = await new MacosSeatbeltJail().wrap('/bin/sh', ['-c', 'echo hi'], { root, projectDir })
    if (wrap.cleanup) cleanups.push(async () => { await wrap.cleanup?.() })

    expect(wrap.bin).toBe('sandbox-exec')
    expect(wrap.args[0]).toBe('-f')

    const profilePath = wrap.args[1]
    expect(profilePath, 'profile path arg present').toBeDefined()

    // sandbox-exec is invoked with the profile then the original command.
    expect(wrap.args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(wrap.args).toContain(`HOME=${root}`)

    const profile = await readFile(profilePath as string, 'utf8')
    expect(profile).toContain('(deny file-write* (subpath "/"))')
    expect(profile).toContain('(allow file-write*')

    // The root is canonicalized (realpath) before embedding in the profile.
    const expectedRoot = await realpath(resolveJailRoot(root, projectDir))
    expect(profile).toContain(`(subpath "${expectedRoot}")`)

    // sandbox-exec does not rewrite the child env, so the wrapper MUST return
    // HOME + XDG pointing into the jail (else stateful CLIs write to real $HOME).
    expect(wrap.env?.HOME).toBe(expectedRoot)
    expect(wrap.env?.XDG_CONFIG_HOME).toBe(join(expectedRoot, '.config'))
    expect(wrap.env?.XDG_CACHE_HOME).toBe(join(expectedRoot, '.cache'))
  })
})

describe('resolveJailRoot containment', () => {
  it('rejects a root equal to the base (would make the whole repo writable)', async () => {
    const base = await realpath(await tempProjectDir())
    expect(() => resolveJailRoot('.', base)).toThrow(/dedicated subdirectory/)
    expect(() => resolveJailRoot(base, base)).toThrow(/dedicated subdirectory/)
  })

  it('rejects a repo-local symlink whose real path escapes the base', async () => {
    const base = await realpath(await tempProjectDir())
    await symlink('/tmp', join(base, 'scratch'))
    expect(() => resolveJailRoot('scratch', base)).toThrow()
  })

  it('accepts a normal nested descendant', async () => {
    const base = await realpath(await tempProjectDir())
    expect(resolveJailRoot('.agent-home', base)).toBe(join(base, '.agent-home'))
  })

  it('ignoreJailRoot adds an anchored, idempotent exclude entry', async () => {
    const base = await realpath(await tempProjectDir())
    await mkdir(join(base, '.git', 'info'), { recursive: true })
    ignoreJailRoot(base, join(base, '.agent-home'))
    ignoreJailRoot(base, join(base, '.agent-home'))
    const exclude = await readFile(join(base, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.match(/^\/\.agent-home\/$/gm)?.length).toBe(1)
  })

  it('ignoreJailRoot finds the repo when cwd is a subdirectory (anchored to repo root)', async () => {
    const base = await realpath(await tempProjectDir())
    await mkdir(join(base, '.git', 'info'), { recursive: true })
    const sub = join(base, 'pkg', 'app')
    await mkdir(sub, { recursive: true })
    ignoreJailRoot(sub, join(sub, '.agent-home'))
    const exclude = await readFile(join(base, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('/pkg/app/.agent-home/')
  })

  it('ignoreJailRoot follows a .git FILE (worktree) to the real gitdir', async () => {
    const base = await realpath(await tempProjectDir())
    const realGit = join(base, 'realgit')
    await mkdir(join(realGit, 'info'), { recursive: true })
    await writeFile(join(base, '.git'), `gitdir: ${realGit}\n`)
    ignoreJailRoot(base, join(base, '.agent-home'))
    const exclude = await readFile(join(realGit, 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('/.agent-home/')
  })
})

describe('auth preservation', () => {
  it('jailRelPath maps a host auth path to its $HOME-relative location', () => {
    expect(jailRelPath(join(homedir(), '.claude'))).toBe('.claude')
    expect(jailRelPath(join(homedir(), '.config', 'opencode'))).toBe(join('.config', 'opencode'))
  })

  it('authSourcesFor maps registered harness aliases to the same creds, [] for unknown', () => {
    expect(authSourcesFor('totally-unknown-backend')).toEqual([])
    // The server registers 'claude-code'/'claudish'/'kimi-code', not 'claude'/'kimi'.
    expect(authSourcesFor('claude-code')).toEqual(authSourcesFor('claude'))
    expect(authSourcesFor('claudish')).toEqual(authSourcesFor('claude'))
    expect(authSourcesFor('kimi-code')).toEqual(authSourcesFor('kimi'))
    for (const p of authSourcesFor('claude-code')) {
      expect(existsSync(p), `${p} should exist`).toBe(true)
      expect(p.startsWith(homedir())).toBe(true)
    }
    // codex must be preserved too (no-MCP jailed codex would otherwise lose ~/.codex).
    for (const p of authSourcesFor('codex')) {
      expect(p.endsWith('.codex')).toBe(true)
    }
  })

  it('bwrap read-only-binds an auth source into the jail HOME at its relative path', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-authtest-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], { root, projectDir, authSources: [authDir] })
    const expectedRoot = resolveJailRoot(root, projectDir)
    expect(
      seqIndex(wrap.args, '--ro-bind', authDir, join(expectedRoot, jailRelPath(authDir))),
      'auth source ro-bound into the jail HOME',
    ).toBeGreaterThanOrEqual(0)
  })
})

describe('applyJail fail-closed', () => {
  const unavailable: JailBackend = {
    name: 'stub',
    isAvailable: () => false,
    wrap: () => { throw new Error('should not wrap when unavailable') },
  }
  const jailedOpts = { jail: { root: '/proj/.agent-home', projectDir: '/proj' } } as never

  it('throws (refuses to run unconfined) when a jail is requested but the backend is unavailable', async () => {
    await expect(applyJail('/bin/sh', ['-c', 'x'], jailedOpts, unavailable))
      .rejects.toThrow(/write-jail requested/)
  })

  it('runs unconfined (pass-through) only when BRIDGE_JAIL_FALLBACK=warn is set', async () => {
    process.env.BRIDGE_JAIL_FALLBACK = 'warn'
    try {
      const r = await applyJail('/bin/sh', ['-c', 'x'], jailedOpts, unavailable)
      expect(r.bin).toBe('/bin/sh')
      expect(r.args).toEqual(['-c', 'x'])
    } finally {
      delete process.env.BRIDGE_JAIL_FALLBACK
    }
  })

  it('is a pure pass-through when no jail is requested (never throws)', async () => {
    const r = await applyJail('mybin', ['--x'], {} as never, unavailable)
    expect(r.bin).toBe('mybin')
    expect(r.args).toEqual(['--x'])
  })

  it('fails closed when the backend is NoopJail (unsupported platform auto-selection)', async () => {
    // selectJailBackend() returns NoopJail on non-Linux/macOS hosts; a write-jail
    // request there must be rejected, not silently run unconfined.
    await expect(applyJail('/bin/sh', ['-c', 'x'], jailedOpts, new NoopJail()))
      .rejects.toThrow(/write-jail requested/)
  })
})

describe('NoopJail.wrap', () => {
  it('returns bin and args unchanged with no env or cleanup', () => {
    const wrap = new NoopJail().wrap('mybin', ['--flag', 'value'], {
      root: '/anything',
      projectDir: '/anywhere',
    })
    expect(wrap.bin).toBe('mybin')
    expect(wrap.args).toEqual(['--flag', 'value'])
    expect(wrap.env).toBeUndefined()
    expect(wrap.cleanup).toBeUndefined()
  })
})

describe('resolveJailSpec', () => {
  it('returns null when the mode is off (default and explicit)', () => {
    const cwd = '/home/user/project'
    expect(resolveJailSpec({ cwd, env: {} })).toBeNull()
    expect(resolveJailSpec({ cwd, execMode: 'off', env: {} })).toBeNull()
    expect(resolveJailSpec({ cwd, execMode: 'nonsense', env: {} })).toBeNull()
  })

  it('honors write-jail from the per-request mode and the env default', () => {
    const cwd = '/home/user/project'
    expect(resolveJailSpec({ cwd, execMode: 'write-jail', env: {} })).not.toBeNull()
    expect(resolveJailSpec({ cwd, env: { BRIDGE_JAIL_MODE: 'write-jail' } })).not.toBeNull()
  })

  it('treats env BRIDGE_JAIL_MODE=write-jail as a floor a request cannot weaken to off', () => {
    const cwd = '/home/user/project'
    const spec = resolveJailSpec({ cwd, execMode: 'off', env: { BRIDGE_JAIL_MODE: 'write-jail' } })
    expect(spec, 'a per-request off must not disable an operator-enforced write-jail').not.toBeNull()
  })

  it('defaults the writable root to .agent-home inside cwd', () => {
    const cwd = '/home/user/project'
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', env: {} })
    expect(spec).not.toBeNull()
    expect(spec?.projectDir).toBe(resolve(cwd))
    expect(spec?.root).toBe(resolve(cwd, DEFAULT_JAIL_ROOT))
  })

  it('honors a nested root inside the .agent-home scratch namespace', () => {
    const cwd = '/home/user/project'
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', execRoot: '.agent-home/run1', env: {} })
    expect(spec?.root).toBe(resolve(cwd, '.agent-home/run1'))
  })

  it('clamps a root that points at an arbitrary repo subtree to the scratch default', () => {
    const cwd = '/home/user/project'
    // 'src' is inside cwd but OUTSIDE .agent-home — must not become the writable jail.
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', execRoot: 'src', env: {} })
    expect(spec?.root).toBe(resolve(cwd, DEFAULT_JAIL_ROOT))
  })

  it('clamps a root that escapes cwd back to the in-cwd default (fail closed)', () => {
    const cwd = '/home/user/project'
    const escapeAttempts = ['../../etc', '../outside', '/etc', '.']
    for (const execRoot of escapeAttempts) {
      const spec = resolveJailSpec({ cwd, execMode: 'write-jail', execRoot, env: {} })
      expect(spec, `escape attempt ${execRoot} should still produce a spec`).not.toBeNull()
      expect(spec?.root, `escape attempt ${execRoot} must clamp to default`).toBe(
        resolve(cwd, DEFAULT_JAIL_ROOT),
      )
    }
  })
})

describe('anyBackendSpawnsOnHost (startup jail fail-fast gate)', () => {
  const docker = (name: string): BackendExecutorConfig => ({ name, kind: 'docker' })
  const host = (name: string): BackendExecutorConfig => ({ name, kind: 'host' })

  it('is true for the default host-CLI backends', () => {
    expect(anyBackendSpawnsOnHost(new Set(['claude', 'kimi', 'gemini']), {})).toBe(true)
  })

  it('is true for ACP backends absent from the executor map (hermes/openclaw)', () => {
    // Regression: hermes/openclaw forward the jailSpec to the host spawner but are
    // not in config.executors, so an executor-only check missed them and let an
    // ACP-only write-jail deployment boot "healthy" then fail every request.
    expect(anyBackendSpawnsOnHost(new Set(['hermes', 'openclaw']), {})).toBe(true)
    expect(anyBackendSpawnsOnHost(new Set(['sandbox', 'passthrough', 'hermes']), {})).toBe(true)
  })

  it('is false when every enabled backend is remote/proxy (no host spawn)', () => {
    expect(anyBackendSpawnsOnHost(new Set(['sandbox', 'passthrough', 'nanoclaw']), {})).toBe(false)
  })

  it('is false when the only host-CLI backend is pinned to a docker executor', () => {
    expect(anyBackendSpawnsOnHost(new Set(['claude', 'sandbox']), { claude: docker('claude') })).toBe(false)
  })

  it('is true when at least one host-CLI backend keeps a host executor', () => {
    expect(
      anyBackendSpawnsOnHost(new Set(['claude', 'kimi']), { claude: docker('claude'), kimi: host('kimi') }),
    ).toBe(true)
  })

  it('is false for an empty backend set', () => {
    expect(anyBackendSpawnsOnHost(new Set<string>(), {})).toBe(false)
  })
})
