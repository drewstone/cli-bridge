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
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LinuxBwrapJail,
  MacosSeatbeltJail,
  NoopJail,
  registerJailEnvironment,
  registerJailReadable,
  resolveJailRoot,
} from '../src/jail/index.js'
import { toolchainReadPaths } from '../src/jail/linux-bwrap.js'
import { DEFAULT_JAIL_ROOT, resolveJailSpec } from '../src/jail/resolve-spec.js'
import { applyJail } from '../src/executors/jail-support.js'
import {
  authSourcesFor,
  copyAuthIntoJail,
  removeStaleAuthCopies,
} from '../src/jail/auth-preserve.js'
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

describe('LinuxBwrapJail.wrap read-confine (fs-jail)', () => {
  it('drops the whole-host read bind, uses a system allowlist + fresh /tmp, and binds the workspace READ-WRITE', async () => {
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')

    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'echo hi'], { root, projectDir, readConfine: true })
    const argv = [wrap.bin, ...wrap.args]
    const expectedRoot = resolveJailRoot(root, projectDir)

    // The read hole is CLOSED: the whole host root is no longer mounted readable.
    expect(seqIndex(argv, '--ro-bind', '/', '/'), 'must NOT ro-bind the whole host root').toBe(-1)
    // A minimal system allowlist is bound read-only instead.
    expect(seqIndex(argv, '--ro-bind-try', '/usr', '/usr'), '/usr allowlisted read-only').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--ro-bind-try', '/etc', '/etc'), '/etc allowlisted read-only').toBeGreaterThanOrEqual(0)
    // Fresh empty /tmp so the host /tmp (twins, other runs) is invisible.
    expect(seqIndex(argv, '--tmpfs', '/tmp'), 'fresh tmpfs over /tmp').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--proc', '/proc')).toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--dev', '/dev')).toBeGreaterThanOrEqual(0)
    // The workspace is READ-WRITE (a coding agent builds here), not read-only.
    expect(seqIndex(argv, '--bind', projectDir, projectDir), 'workspace bound read-write').toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--ro-bind', projectDir, projectDir), 'workspace must not be read-only in fs-jail').toBe(-1)
    // HOME + chdir still wired; original command still the tail.
    expect(seqIndex(argv, '--setenv', 'HOME', expectedRoot)).toBeGreaterThanOrEqual(0)
    expect(seqIndex(argv, '--chdir', projectDir)).toBeGreaterThanOrEqual(0)
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi'])
  })

  it('re-binds extraReadablePaths AFTER the fresh /tmp so a materialized config under /tmp survives', async () => {
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const cfgDir = await mkdtemp(join(tmpdir(), 'cli-bridge-cfg-'))
    cleanups.push(() => rm(cfgDir, { recursive: true, force: true }))

    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root, projectDir, readConfine: true, extraReadablePaths: [cfgDir],
    })
    const argv = [wrap.bin, ...wrap.args]
    const tmpfsAt = seqIndex(argv, '--tmpfs', '/tmp')
    const cfgAt = seqIndex(argv, '--ro-bind-try', cfgDir, cfgDir)
    expect(tmpfsAt).toBeGreaterThanOrEqual(0)
    expect(cfgAt, 'config dir re-bound').toBeGreaterThanOrEqual(0)
    expect(cfgAt, 'config re-bind comes AFTER the tmpfs so it wins').toBeGreaterThan(tmpfsAt)
  })
})

describe('toolchainReadPaths', () => {
  it('includes the node install prefix and never a jail-defeating path', () => {
    const projectDir = '/tmp/some-run/workspace'
    const paths = toolchainReadPaths('/bin/sh', projectDir)
    // The Node prefix (two levels up from the running node) is present.
    const nodePrefix = dirname(dirname(process.execPath))
    expect(paths).toContain(nodePrefix)
    // Never the root, /home, the operator HOME, or an ancestor of the workspace.
    for (const p of paths) {
      expect(p).not.toBe('/')
      expect(p).not.toBe('/home')
      expect(p).not.toBe(homedir())
      // p must not be an ancestor of (or equal to) the workspace.
      expect(projectDir === p || projectDir.startsWith(`${p}/`), `${p} must not contain the workspace`).toBe(false)
    }
  })

  it('honors BRIDGE_JAIL_RO_PATHS but still rejects an ancestor of the workspace', () => {
    const projectDir = '/tmp/run42/ws'
    const prev = process.env.BRIDGE_JAIL_RO_PATHS
    // One safe extra dir + one that is an ancestor of the workspace (must be dropped).
    process.env.BRIDGE_JAIL_RO_PATHS = `/opt/custom-runtime:/tmp/run42`
    try {
      const paths = toolchainReadPaths('/bin/sh', projectDir)
      expect(paths).toContain('/opt/custom-runtime')
      expect(paths, 'an ancestor of the workspace must be refused').not.toContain('/tmp/run42')
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_JAIL_RO_PATHS
      else process.env.BRIDGE_JAIL_RO_PATHS = prev
    }
  })
})

describe('registerJailReadable', () => {
  it('adds paths to a read-confined spec, deduped', () => {
    const spec = { root: '/p/.agent-home', projectDir: '/p', readConfine: true } as const
    const mut = { ...spec, extraReadablePaths: undefined as string[] | undefined }
    registerJailReadable(mut, '/tmp/cfg-a', '/tmp/cfg-a', '/tmp/cfg-b')
    expect(mut.extraReadablePaths?.sort()).toEqual(['/tmp/cfg-a', '/tmp/cfg-b'])
  })

  it('is a no-op on a write-jail spec (whole host already readable) and on null', () => {
    const writeJail = { root: '/p/.agent-home', projectDir: '/p', extraReadablePaths: undefined as string[] | undefined }
    registerJailReadable(writeJail, '/tmp/cfg')
    expect(writeJail.extraReadablePaths).toBeUndefined()
    expect(() => registerJailReadable(null, '/tmp/cfg')).not.toThrow()
    expect(() => registerJailReadable(undefined, '/tmp/cfg')).not.toThrow()
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

    // Regression: shared temp trees must NOT be writable — a confined run could
    // otherwise persist files outside the jail root. Temp goes to <root>/.tmp.
    expect(profile, 'must not whitelist the per-user temp tree').not.toContain('/private/var/folders')
    expect(profile, 'must not whitelist /private/tmp').not.toContain('/private/tmp')
    // Standard device nodes stay writable so output redirection / RNG still work.
    expect(profile).toContain('(literal "/dev/null")')

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
  it('authSourcesFor maps registered harness aliases to the same creds, [] for unknown', () => {
    expect(authSourcesFor('totally-unknown-backend')).toEqual([])
    // The server registers 'claude-code'/'claudish'/'kimi-code', not 'claude'/'kimi'.
    expect(authSourcesFor('claude-code')).toEqual(authSourcesFor('claude'))
    expect(authSourcesFor('claudish')).toEqual(authSourcesFor('claude'))
    expect(authSourcesFor('kimi-code')).toEqual(authSourcesFor('kimi'))
    for (const { source, jailRel, mode, only } of authSourcesFor('claude-code')) {
      expect(existsSync(source), `${source} should exist`).toBe(true)
      expect(source.startsWith(homedir())).toBe(true)
      // jailRel must be a relative location strictly inside the jail root.
      expect(jailRel.startsWith('/'), `${jailRel} must be relative`).toBe(false)
      expect(jailRel.startsWith('..'), `${jailRel} must not escape the root`).toBe(false)
      // Claude rewrites ~/.claude.json and persists transcripts under
      // ~/.claude on every run: a read-only home kills the jailed CLI, so
      // its home is a small writable seed instead of a bind.
      expect(mode).toBe('seed-writable')
      if (jailRel === '.claude') {
        expect(only).toEqual(['.credentials.json', 'credentials.json', 'settings.json'])
      }
    }
    const kimiSources = authSourcesFor('kimi-code')
    const kimiHome = kimiSources.find((entry) => entry.jailRel === '.kimi-code')
    expect(kimiHome).toMatchObject({
      jailRel: '.kimi-code',
      mode: 'seed-writable',
      only: ['config.toml', 'credentials', 'device_id'],
    })
    expect(kimiSources.find((entry) => entry.jailRel === '.kimi')?.mode).toBe('seed-writable')
    // codex must be preserved too (no-MCP jailed codex would otherwise lose
    // ~/.codex) and tagged so the jail redirects CODEX_HOME at the in-jail
    // home. Seeded WRITABLE: codex writes PATH aliases + app-server state +
    // session rollouts inside CODEX_HOME before it can run (a read-only bind
    // measured as `codex exited 1: ... Read-only file system (os error 30)`),
    // and `only` keeps the host's multi-GB sessions/ tree out of the copy.
    for (const { source, jailRel, envVar, mode, only } of authSourcesFor('codex')) {
      expect(source.endsWith('.codex')).toBe(true)
      expect(jailRel).toBe('.codex')
      expect(envVar).toBe('CODEX_HOME')
      expect(mode).toBe('seed-writable')
      expect(only).toEqual(['auth.json', 'config.toml'])
    }
  })

  it('authSourcesFor(codex) honors a custom CODEX_HOME outside HOME, mapped to the jail ~/.codex', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'cli-bridge-codexhome-'))
    cleanups.push(() => rm(ext, { recursive: true, force: true }))
    await writeFile(join(ext, 'auth.json'), '{}')
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = ext
    try {
      const codexEntries = authSourcesFor('codex').filter((e) => e.jailRel === '.codex')
      // Exactly one .codex entry, pointing at the custom CODEX_HOME (not ~/.codex),
      // still placed at the jail's ~/.codex so a confined codex (HOME=root) finds it,
      // and tagged with the env var the jail will redirect.
      expect(codexEntries).toHaveLength(1)
      expect(codexEntries[0]?.source).toBe(resolve(ext))
      expect(codexEntries[0]?.envVar).toBe('CODEX_HOME')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('seeds only OpenCode auth into a writable jailed data directory', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'cli-bridge-opencode-home-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    const data = join(fakeHome, '.local', 'share', 'opencode')
    await mkdir(join(fakeHome, '.config', 'opencode'), { recursive: true })
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'auth.json'), '{"provider":"token"}')
    await writeFile(join(data, 'opencode.db'), 'must not be copied')
    const previousHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const entries = authSourcesFor('opencode')
      const dataEntry = entries.find((entry) => entry.jailRel === '.local/share/opencode')
      expect(dataEntry).toMatchObject({
        source: data,
        mode: 'seed-writable',
        only: ['auth.json'],
      })
      expect(entries.find((entry) => entry.jailRel === '.config/opencode')?.mode).toBe('read-only')
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  it('authSourcesFor(pi) preserves ~/.pi/agent so a jailed pi keeps its provider/model config', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'cli-bridge-pihome-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    await mkdir(join(fakeHome, '.pi', 'agent'), { recursive: true })
    await writeFile(join(fakeHome, '.pi', 'agent', 'config.json'), '{"provider":"x"}')
    const prev = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const sources = authSourcesFor('pi')
      expect(sources).toHaveLength(1)
      expect(sources[0]?.jailRel).toMatch(/^\.auth-copies\/pi-\d+-[0-9a-f-]+$/u)
      expect(sources[0]?.source).toBe(join(fakeHome, '.pi', 'agent'))
      expect(sources[0]?.envVar).toBe('PI_CODING_AGENT_DIR')
      expect(sources[0]?.mode).toBe('copy-writable')
      expect(authSourcesFor('pi')[0]?.jailRel).not.toBe(sources[0]?.jailRel)
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
    }
  })

  it('authSourcesFor(pi) honors a custom PI_CODING_AGENT_DIR instead of substituting the default', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'cli-bridge-pihome-custom-'))
    const customAgentDir = await mkdtemp(join(tmpdir(), 'cli-bridge-piagent-custom-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    cleanups.push(() => rm(customAgentDir, { recursive: true, force: true }))
    await mkdir(join(fakeHome, '.pi', 'agent'), { recursive: true })
    await writeFile(join(fakeHome, '.pi', 'agent', 'models.json'), '{"default":true}')
    await writeFile(join(customAgentDir, 'models.json'), '{"custom":true}')
    const previousHome = process.env.HOME
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.HOME = fakeHome
    process.env.PI_CODING_AGENT_DIR = customAgentDir
    try {
      const sources = authSourcesFor('pi')
      expect(sources).toHaveLength(1)
      expect(sources[0]).toMatchObject({
        source: resolve(customAgentDir),
        mode: 'copy-writable',
        envVar: 'PI_CODING_AGENT_DIR',
      })
      expect(sources[0]?.jailRel).toMatch(/^\.auth-copies\/pi-\d+-[0-9a-f-]+$/u)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
  })

  it('authSourcesFor(pi) does not fall back to ~/.pi/agent when a custom directory is missing', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'cli-bridge-pihome-missing-custom-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    await mkdir(join(fakeHome, '.pi', 'agent'), { recursive: true })
    const previousHome = process.env.HOME
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.HOME = fakeHome
    process.env.PI_CODING_AGENT_DIR = join(fakeHome, 'missing-custom-agent-dir')
    try {
      expect(authSourcesFor('pi')).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
  })

  it('bwrap read-only-binds an auth source into the jail HOME at its relative path', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-authtest-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{ source: authDir, jailRel: '.claude', mode: 'read-only' }],
    })
    const expectedRoot = resolveJailRoot(root, projectDir)
    expect(
      seqIndex(wrap.args, '--ro-bind', authDir, join(expectedRoot, '.claude')),
      'auth source ro-bound into the jail HOME',
    ).toBeGreaterThanOrEqual(0)
  })

  it('bwrap redirects an auth env var (CODEX_HOME) at the in-jail copy — only when it wraps', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-codexauth-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: '.codex',
        mode: 'read-only',
        envVar: 'CODEX_HOME',
      }],
    })
    const expectedRoot = resolveJailRoot(root, projectDir)
    expect(seqIndex(wrap.args, '--ro-bind', authDir, join(expectedRoot, '.codex'))).toBeGreaterThanOrEqual(0)
    expect(
      seqIndex(wrap.args, '--setenv', 'CODEX_HOME', join(expectedRoot, '.codex')),
      'CODEX_HOME redirected to the in-jail copy',
    ).toBeGreaterThanOrEqual(0)
  })

  it('bwrap gives Pi an ephemeral writable config copy and removes it on cleanup', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-piauth-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    await writeFile(join(authDir, 'settings.json'), '{"ok":true}')
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const firstRel = '.auth-copies/pi-first'
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: firstRel,
        mode: 'copy-writable',
        envVar: 'PI_CODING_AGENT_DIR',
      }],
    })
    const expectedRoot = resolveJailRoot(root, projectDir)
    const envIndex = seqIndex(wrap.args, '--setenv', 'PI_CODING_AGENT_DIR')
    expect(envIndex).toBeGreaterThanOrEqual(0)
    const copiedAgentDir = wrap.args[envIndex + 2]!
    expect(copiedAgentDir).toBe(join(expectedRoot, firstRel))
    expect(await readFile(join(copiedAgentDir, 'settings.json'), 'utf8')).toBe('{"ok":true}')
    expect((await stat(copiedAgentDir)).mode & 0o777).toBe(0o700)
    expect(seqIndex(wrap.args, '--ro-bind', authDir, copiedAgentDir)).toBe(-1)
    const concurrentRel = '.auth-copies/pi-second'
    const concurrentWrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'y'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: concurrentRel,
        mode: 'copy-writable',
        envVar: 'PI_CODING_AGENT_DIR',
      }],
    })
    const concurrentEnvIndex = seqIndex(
      concurrentWrap.args,
      '--setenv',
      'PI_CODING_AGENT_DIR',
    )
    expect(concurrentEnvIndex).toBeGreaterThanOrEqual(0)
    const concurrentAgentDir = concurrentWrap.args[concurrentEnvIndex + 2]!
    expect(concurrentAgentDir).not.toBe(copiedAgentDir)
    await wrap.cleanup?.()
    expect(existsSync(copiedAgentDir)).toBe(false)
    expect(existsSync(concurrentAgentDir)).toBe(true)
    await concurrentWrap.cleanup?.()
    expect(existsSync(concurrentAgentDir)).toBe(false)
  })

  it('bwrap seeds a writable codex home: selected files only, no ro-bind, CODEX_HOME redirected', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-codexseed-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    await writeFile(join(authDir, 'auth.json'), '{"token":"t1"}')
    // No config.toml on this host: a missing `only` entry is skipped, never fatal.
    await mkdir(join(authDir, 'sessions'), { recursive: true })
    await writeFile(join(authDir, 'sessions', 'host-rollout.jsonl'), 'HOST SESSION — never copied')
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: '.codex',
        mode: 'seed-writable',
        only: ['auth.json', 'config.toml'],
        envVar: 'CODEX_HOME',
      }],
    })
    const expectedRoot = resolveJailRoot(root, projectDir)
    const seededHome = join(expectedRoot, '.codex')
    // The seed lives INSIDE the writable root: bytes present, never ro-bound,
    // so codex can write PATH aliases / app-server state / rollouts beside it.
    expect(await readFile(join(seededHome, 'auth.json'), 'utf8')).toBe('{"token":"t1"}')
    expect(existsSync(join(seededHome, 'sessions'))).toBe(false)
    expect(seqIndex(wrap.args, '--ro-bind', authDir, seededHome)).toBe(-1)
    expect(seqIndex(wrap.args, '--setenv', 'CODEX_HOME', seededHome)).toBeGreaterThanOrEqual(0)
    expect((await stat(join(seededHome, 'auth.json'))).mode & 0o777).toBe(0o600)
    // Session state the CLI writes beside the seed must survive both this
    // run's cleanup and the next run's refresh, or `codex exec resume` breaks.
    await mkdir(join(seededHome, 'sessions'), { recursive: true })
    await writeFile(join(seededHome, 'sessions', 'rollout.jsonl'), 'turn 1')
    await wrap.cleanup?.()
    expect(await readFile(join(seededHome, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('turn 1')
    await writeFile(join(authDir, 'auth.json'), '{"token":"t2"}')
    await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'y'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: '.codex',
        mode: 'seed-writable',
        only: ['auth.json', 'config.toml'],
        envVar: 'CODEX_HOME',
      }],
    })
    expect(await readFile(join(seededHome, 'auth.json'), 'utf8')).toBe('{"token":"t2"}')
    expect(await readFile(join(seededHome, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('turn 1')
  })

  it('seeds a dotfiles-managed symlink source as real bytes and survives the next turn', async () => {
    // Measured on the second turn of a jailed claude session: settings.json
    // was a symlink into ~/code/dotfiles, the seed copied the LINK, and the
    // refresh followed it outside the root — "jail root '<dotfiles path>'
    // must be a dedicated subdirectory". The link target is not mounted in an
    // fs-jail either, so only dereferenced bytes work.
    const dotfiles = await mkdtemp(join(homedir(), '.cli-bridge-dotfiles-'))
    cleanups.push(() => rm(dotfiles, { recursive: true, force: true }))
    await writeFile(join(dotfiles, 'settings.json'), '{"linked":true}')
    const claudeDir = await mkdtemp(join(homedir(), '.cli-bridge-claudelink-'))
    cleanups.push(() => rm(claudeDir, { recursive: true, force: true }))
    await symlink(join(dotfiles, 'settings.json'), join(claudeDir, 'settings.json'))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const sources = [{
      source: claudeDir,
      jailRel: '.claude',
      mode: 'seed-writable' as const,
      only: ['settings.json'],
    }]
    await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], { root, projectDir, authSources: sources })
    const seeded = join(resolveJailRoot(root, projectDir), '.claude', 'settings.json')
    expect((await lstat(seeded)).isSymbolicLink()).toBe(false)
    expect(await readFile(seeded, 'utf8')).toBe('{"linked":true}')
    // The second turn refreshes the same leaf; before the fix it threw here.
    await writeFile(join(dotfiles, 'settings.json'), '{"linked":2}')
    await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'y'], { root, projectDir, authSources: sources })
    expect(await readFile(seeded, 'utf8')).toBe('{"linked":2}')
  })

  it('bwrap seeds the claude home surface writable so the CLI can boot and resume', async () => {
    const fakeHome = await mkdtemp(join(homedir(), '.cli-bridge-claudeseed-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    const claudeDir = join(fakeHome, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, '.credentials.json'), '{"oauth":"c1"}')
    await writeFile(join(claudeDir, 'settings.json'), '{"model":"default"}')
    await mkdir(join(claudeDir, 'projects'), { recursive: true })
    await writeFile(join(claudeDir, 'projects', 'host-transcript.jsonl'), 'HOST — never copied')
    await writeFile(join(fakeHome, '.claude.json'), '{"hasCompletedOnboarding":true}')
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [
        {
          source: claudeDir,
          jailRel: '.claude',
          mode: 'seed-writable',
          only: ['.credentials.json', 'credentials.json', 'settings.json'],
        },
        { source: join(fakeHome, '.claude.json'), jailRel: '.claude.json', mode: 'seed-writable' },
      ],
    })
    const expectedRoot = resolveJailRoot(root, projectDir)
    // Both homes are writable seeds at the exact paths claude reads under the
    // jail's HOME redirect — no env var involved, no ro-bind to hit EROFS on.
    expect(await readFile(join(expectedRoot, '.claude', '.credentials.json'), 'utf8')).toBe('{"oauth":"c1"}')
    expect(await readFile(join(expectedRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"model":"default"}')
    expect(await readFile(join(expectedRoot, '.claude.json'), 'utf8')).toBe('{"hasCompletedOnboarding":true}')
    expect(existsSync(join(expectedRoot, '.claude', 'projects'))).toBe(false)
    expect(seqIndex(wrap.args, '--ro-bind', claudeDir, join(expectedRoot, '.claude'))).toBe(-1)
    // Transcripts the jailed claude writes must survive cleanup for --resume.
    await mkdir(join(expectedRoot, '.claude', 'projects'), { recursive: true })
    await writeFile(join(expectedRoot, '.claude', 'projects', 'turn1.jsonl'), 'turn 1')
    await wrap.cleanup?.()
    expect(await readFile(join(expectedRoot, '.claude', 'projects', 'turn1.jsonl'), 'utf8')).toBe('turn 1')
  })

  it('updates a stable auth copy in place without deleting files used by another run', async () => {
    const source = await mkdtemp(join(homedir(), '.cli-bridge-stable-source-'))
    cleanups.push(() => rm(source, { recursive: true, force: true }))
    await writeFile(join(source, 'settings.json'), 'updated')
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const destination = join(root, '.claude')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'settings.json'), 'old')
    await writeFile(join(destination, 'live-run.json'), 'still in use')

    await copyAuthIntoJail(root, [
      { source, jailRel: '.claude', mode: 'read-only' },
    ])

    expect(await readFile(join(destination, 'settings.json'), 'utf8')).toBe('updated')
    expect(await readFile(join(destination, 'live-run.json'), 'utf8')).toBe('still in use')
  })

  it('removes dead-process Pi config copies without touching a live process copy', async () => {
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const copies = join(root, '.auth-copies')
    const live = join(copies, `pi-${process.pid}-live`)
    const dead = join(copies, 'pi-2147483646-dead')
    await mkdir(live, { recursive: true })
    await mkdir(dead, { recursive: true })
    await writeFile(join(live, 'auth.json'), 'live')
    await writeFile(join(dead, 'auth.json'), 'dead')

    await removeStaleAuthCopies(root)

    expect(existsSync(live)).toBe(true)
    expect(existsSync(dead)).toBe(false)
  })

  it('rejects a writable auth copy with no environment redirect before copying', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-piauth-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const jailRel = `.auth-copies/pi-${process.pid}-missing-env`

    await expect(new LinuxBwrapJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{ source: authDir, jailRel, mode: 'copy-writable' }],
    })).rejects.toThrow(/requires envVar/u)
    expect(existsSync(join(root, jailRel))).toBe(false)
  })

  it('seatbelt returns an auth env var (CODEX_HOME) pointing at the in-jail copy', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-codexauth-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const wrap = await new MacosSeatbeltJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: '.codex',
        mode: 'read-only',
        envVar: 'CODEX_HOME',
      }],
    })
    if (wrap.cleanup) cleanups.push(async () => { await wrap.cleanup?.() })
    const expectedRoot = await realpath(resolveJailRoot(root, projectDir))
    expect(wrap.env?.CODEX_HOME).toBe(join(expectedRoot, '.codex'))
  })

  it('seatbelt points PI_CODING_AGENT_DIR at the copied in-jail config', async () => {
    const authDir = await mkdtemp(join(homedir(), '.cli-bridge-piauth-'))
    cleanups.push(() => rm(authDir, { recursive: true, force: true }))
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    const writableRel = '.auth-copies/pi-seatbelt'
    const wrap = await new MacosSeatbeltJail().wrap('/bin/sh', ['-c', 'x'], {
      root,
      projectDir,
      authSources: [{
        source: authDir,
        jailRel: writableRel,
        mode: 'copy-writable',
        envVar: 'PI_CODING_AGENT_DIR',
      }],
    })
    const expectedRoot = await realpath(resolveJailRoot(root, projectDir))
    const copiedAgentDir = join(expectedRoot, writableRel)
    expect(wrap.env?.PI_CODING_AGENT_DIR).toBe(copiedAgentDir)
    expect(existsSync(copiedAgentDir)).toBe(true)
    await wrap.cleanup?.()
    expect(existsSync(copiedAgentDir)).toBe(false)
  })
})

describe('applyJail fail-closed', () => {
  const unavailable: JailBackend = {
    name: 'stub',
    isAvailable: () => false,
    wrap: () => { throw new Error('should not wrap when unavailable') },
  }
  const jailedOpts = {
    env: { BASE: 'kept' },
    jail: {
      root: '/proj/.agent-home',
      projectDir: '/proj',
      environment: { PI_CODING_AGENT_SESSION_DIR: '/proj/.agent-home/.pi-sessions' },
    },
  } as never

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
      expect(r.env).toEqual({ BASE: 'kept' })
    } finally {
      delete process.env.BRIDGE_JAIL_FALLBACK
    }
  })

  it('refuses an operator warn fallback when the request requires enforcement', async () => {
    process.env.BRIDGE_JAIL_FALLBACK = 'warn'
    try {
      const required = {
        env: { BASE: 'kept' },
        jail: {
          root: '/proj/.agent-home',
          projectDir: '/proj',
          requireEnforcement: true,
        },
      } as never
      await expect(applyJail('/bin/sh', ['-c', 'x'], required, unavailable))
        .rejects.toThrow(/refusing to run unconfined/u)
      await expect(applyJail('/bin/sh', ['-c', 'x'], required, unavailable))
        .rejects.not.toThrow(/BRIDGE_JAIL_FALLBACK=warn/u)
    } finally {
      delete process.env.BRIDGE_JAIL_FALLBACK
    }
  })

  it('applies registered environment only when a jail actually wraps', async () => {
    const spec = { root: '/proj/.agent-home', projectDir: '/proj' }
    registerJailEnvironment(spec, 'PI_CODING_AGENT_SESSION_DIR', '/proj/.agent-home/.pi-sessions')
    const available: JailBackend = {
      name: 'available',
      isAvailable: () => true,
      wrap: (bin, args) => ({ bin, args, env: { WRAP: 'active' } }),
    }

    const result = await applyJail('/bin/sh', ['-c', 'x'], {
      env: { BASE: 'kept' },
      jail: spec,
    }, available)

    expect(result.env).toEqual({
      BASE: 'kept',
      PI_CODING_AGENT_SESSION_DIR: '/proj/.agent-home/.pi-sessions',
      WRAP: 'active',
    })
  })

  it('rewrites exact path arguments only when an available jail wraps the command', async () => {
    const available: JailBackend = {
      name: 'available-stub',
      isAvailable: () => true,
      wrap: (bin, args) => ({ bin, args }),
    }
    const opts = {
      jail: {
        root: '/proj/.agent-home',
        projectDir: '/proj',
        argumentRewrites: [{
          from: '/host/pi-extension',
          to: '/proj/.agent-home/pi-extension',
          precededBy: '--extension',
        }],
      },
    } as never

    const result = await applyJail(
      'pi',
      ['--extension', '/host/pi-extension', '/host/pi-extension'],
      opts,
      available,
    )

    expect(result.args).toEqual([
      '--extension',
      '/proj/.agent-home/pi-extension',
      '/host/pi-extension',
    ])
  })

  it('keeps ordinary path arguments when explicit warn fallback runs unconfined', async () => {
    process.env.BRIDGE_JAIL_FALLBACK = 'warn'
    try {
      const opts = {
        jail: {
          root: '/proj/.agent-home',
          projectDir: '/proj',
          argumentRewrites: [{
            from: '/host/pi-extension',
            to: '/proj/.agent-home/pi-extension',
            precededBy: '--extension',
          }],
        },
      } as never
      const result = await applyJail(
        'pi',
        ['--extension', '/host/pi-extension'],
        opts,
        unavailable,
      )
      expect(result.args).toEqual(['--extension', '/host/pi-extension'])
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

  it('sets readConfine only for fs-jail: write-jail leaves reads open, fs-jail confines them', () => {
    const cwd = '/home/user/project'
    expect(resolveJailSpec({ cwd, execMode: 'write-jail', env: {} })?.readConfine).toBeUndefined()
    expect(resolveJailSpec({ cwd, execMode: 'fs-jail', env: {} })?.readConfine).toBe(true)
    expect(resolveJailSpec({ cwd, env: { BRIDGE_JAIL_MODE: 'fs-jail' } })?.readConfine).toBe(true)
  })

  it('WORKER_FS_JAIL=1 is a shorthand that turns on fs-jail (readConfine)', () => {
    const cwd = '/home/user/project'
    for (const v of ['1', 'true', 'yes', 'ON']) {
      const spec = resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: v } })
      expect(spec?.readConfine, `WORKER_FS_JAIL=${v}`).toBe(true)
    }
    // Anything falsey is off.
    expect(resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: '0' } })).toBeNull()
    expect(resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: '' } })).toBeNull()
  })

  it('the jail floor is a MAX: a request can raise write-jail→fs-jail but not lower an fs-jail floor', () => {
    const cwd = '/home/user/project'
    // Request raises the floor.
    expect(
      resolveJailSpec({ cwd, execMode: 'fs-jail', env: { BRIDGE_JAIL_MODE: 'write-jail' } })?.readConfine,
      'fs-jail request raises a write-jail floor',
    ).toBe(true)
    // Request cannot lower the fs-jail floor.
    expect(
      resolveJailSpec({ cwd, execMode: 'write-jail', env: { WORKER_FS_JAIL: '1' } })?.readConfine,
      'a write-jail request must not weaken an fs-jail floor',
    ).toBe(true)
    expect(
      resolveJailSpec({ cwd, execMode: 'off', env: { BRIDGE_JAIL_MODE: 'fs-jail' } })?.readConfine,
      'a per-request off must not disable an fs-jail floor',
    ).toBe(true)
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
