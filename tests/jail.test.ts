import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
import {
  authSourcesFor,
  copyAuthIntoJail,
  removeStaleAuthCopies,
} from '../src/jail/auth-preserve.js'
import { ignoreJailRoot } from '../src/jail/types.js'
import { anyBackendSpawnsOnHost } from '../src/config.js'
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
  return realpath(dir)
}

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
    expect(profile, 'must not whitelist the per-user temp tree').not.toContain('(subpath "/private/var/folders")')
    expect(profile, 'must not whitelist /private/tmp').not.toContain('(subpath "/private/tmp")')
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

  it('links the host keychain directory into the jail HOME', async () => {
    // Regression: claude keeps its macOS login in the login keychain, and with
    // HOME at the jail root a jailed claude answered "Not logged in".
    const home = await tempProjectDir()
    await mkdir(join(home, 'Library', 'Keychains'), { recursive: true })
    const previousHome = process.env.HOME
    process.env.HOME = home
    cleanups.push(async () => {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    })
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')

    const wrap = await new MacosSeatbeltJail().wrap('/bin/sh', ['-c', 'x'], { root, projectDir })
    if (wrap.cleanup) cleanups.push(async () => { await wrap.cleanup?.() })

    const expectedRoot = await realpath(resolveJailRoot(root, projectDir))
    expect(await readlink(join(expectedRoot, 'Library', 'Keychains'))).toBe(join(home, 'Library', 'Keychains'))
    // The confined child must not be able to redirect the link or its parent.
    const profile = await readFile(wrap.args[1] as string, 'utf8')
    expect(profile).toContain(`(literal "${join(expectedRoot, 'Library')}")`)
    expect(profile).toContain(`(literal "${join(expectedRoot, 'Library', 'Keychains')}")`)
  })

  it('never follows a Library link a confined run planted in the jail HOME', async () => {
    // Review finding on #238: an earlier run could replace <root>/Library with a
    // link to a host directory, and the unsandboxed rm -r then deleted host
    // files through it.
    const home = await tempProjectDir()
    await mkdir(join(home, 'Library', 'Keychains'), { recursive: true })
    const previousHome = process.env.HOME
    process.env.HOME = home
    cleanups.push(async () => {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    })
    const hostDir = await tempProjectDir()
    await mkdir(join(hostDir, 'Keychains'), { recursive: true })
    await writeFile(join(hostDir, 'Keychains', 'login.keychain-db'), 'host')
    const projectDir = await tempProjectDir()
    const root = join(projectDir, '.agent-home')
    await mkdir(root, { recursive: true })
    await symlink(hostDir, join(root, 'Library'))

    const wrap = await new MacosSeatbeltJail().wrap('/bin/sh', ['-c', 'x'], { root, projectDir })
    if (wrap.cleanup) cleanups.push(async () => { await wrap.cleanup?.() })

    expect(await readFile(join(hostDir, 'Keychains', 'login.keychain-db'), 'utf8')).toBe('host')
    const expectedRoot = await realpath(resolveJailRoot(root, projectDir))
    expect((await lstat(join(expectedRoot, 'Library'))).isDirectory()).toBe(true)
    expect(await readlink(join(expectedRoot, 'Library', 'Keychains'))).toBe(join(home, 'Library', 'Keychains'))
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
  it('authSourcesFor seeds current and legacy Kimi homes', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'cli-bridge-kimi-home-'))
    cleanups.push(() => rm(fakeHome, { recursive: true, force: true }))
    await mkdir(join(fakeHome, '.kimi-code'), { recursive: true })
    await mkdir(join(fakeHome, '.kimi'), { recursive: true })
    const previousHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      expect(authSourcesFor('kimi-code')).toEqual([
        {
          source: join(fakeHome, '.kimi-code'),
          jailRel: '.kimi-code',
          mode: 'seed-writable',
          only: ['config.toml', 'credentials', 'device_id'],
        },
        {
          source: join(fakeHome, '.kimi'),
          jailRel: '.kimi',
          mode: 'seed-writable',
          only: ['config.toml', 'credentials', 'device_id'],
        },
      ])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
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

  it('defaults the writable root to .agent-home inside cwd', async () => {
    const cwd = await tempProjectDir()
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', env: {} })
    expect(spec).not.toBeNull()
    expect(spec?.projectDir).toBe(resolve(cwd))
    expect(spec?.root).toBe(resolve(cwd, DEFAULT_JAIL_ROOT))
  })

  it('honors a nested root inside the .agent-home scratch namespace', async () => {
    const cwd = await tempProjectDir()
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', execRoot: '.agent-home/run1', env: {} })
    expect(spec?.root).toBe(resolve(cwd, '.agent-home/run1'))
  })

  it('honors nested scratch roots when cwd uses a symlink alias', async () => {
    const projectDir = await tempProjectDir()
    const alias = join(await tempProjectDir(), 'workspace')
    await symlink(projectDir, alias)
    const spec = resolveJailSpec({
      cwd: alias,
      execMode: 'write-jail',
      execRoot: '.agent-home/run1',
      env: {},
    })
    expect(spec?.root).toBe(join(projectDir, '.agent-home/run1'))
    const escaped = resolveJailSpec({ cwd: alias, execMode: 'write-jail', execRoot: 'src', env: {} })
    expect(escaped?.root).toBe(join(projectDir, DEFAULT_JAIL_ROOT))
  })

  it('clamps a root that points at an arbitrary repo subtree to the scratch default', async () => {
    const cwd = await tempProjectDir()
    // 'src' is inside cwd but OUTSIDE .agent-home — must not become the writable jail.
    const spec = resolveJailSpec({ cwd, execMode: 'write-jail', execRoot: 'src', env: {} })
    expect(spec?.root).toBe(resolve(cwd, DEFAULT_JAIL_ROOT))
  })

  it('clamps a root that escapes cwd back to the in-cwd default (fail closed)', async () => {
    const cwd = await tempProjectDir()
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
