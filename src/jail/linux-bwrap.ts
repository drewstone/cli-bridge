/**
 * Linux write-jail via bubblewrap. Network is always unshared; egress.ts owns
 * what a `router` or `relay` spawn may reach. Unprivileged user namespaces: if apparmor blocks
 * them and bwrap is not setuid, `isAvailable()` is false and the caller refuses
 * unconfined execution. Bind order is left-to-right, last wins.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  copyAuthIntoJail,
  gitConfigSources,
  removeAuthCopies,
  removeStaleAuthCopies,
  seedAuthIntoJail,
} from './auth-preserve.js'
import { prepareEgress, type PreparedEgress } from './egress.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { canonicalizeJailPath, ignoreJailRoot, jailEnv, prepareJailHome, resolveJailRoot } from './types.js'

const BWRAP_BIN = 'bwrap'

/** fs-jail read allowlist. `--ro-bind-try` skips a missing path. /home, /root, /tmp, /var, /mnt, and /media stay unbound. */
const SYSTEM_RO_PATHS: readonly string[] = [
  '/usr',
  '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32',
  '/etc',
  '/opt',
]

export class LinuxBwrapJail implements JailBackend {
  readonly name = 'bwrap'

  isAvailable(): boolean {
    if (process.platform !== 'linux' || !onPath(BWRAP_BIN)) return false
    return canRunUnprivileged()
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const config = await gitConfigSources(spec.projectDir, spec.extraWritablePaths)
    let egress: PreparedEgress | undefined
    try {
      egress = await prepareEgress(spec)
      return await this.wrapWithGitConfig(bin, args, spec, config, egress)
    } catch (error) {
      try { await egress?.cleanup() } finally { await config.cleanup() }
      throw error
    }
  }

  private async wrapWithGitConfig(bin: string, args: string[], spec: JailSpec, config: Awaited<ReturnType<typeof gitConfigSources>>, egress: PreparedEgress): Promise<JailWrap> {
    const root = resolveJailRoot(spec.root, spec.projectDir)
    await prepareJailHome(root)
    ignoreJailRoot(spec.projectDir, root)
    const availableAuthSources = [...(spec.authSources ?? []), ...config.sources].filter((source) =>
      existsSync(source.source),
    )
    const writableAuthSources = availableAuthSources.filter(
      (source) => source.mode === 'copy-writable',
    )
    const seededAuthSources = availableAuthSources.filter(
      (source) => source.mode === 'seed-writable',
    )
    for (const source of availableAuthSources) resolveJailRoot(source.jailRel, root)
    for (const source of writableAuthSources) {
      if (!source.envVar) {
        throw new Error('a copy-writable jail auth source requires envVar')
      }
    }
    const resolver = spec.readConfine ? tryRealpath('/etc/resolv.conf') : null
    if (resolver && !statSync(resolver).isFile()) throw new Error('DNS resolver is not a regular file')
    const hooks = spec.readConfine ? gitHookReadPaths(spec.projectDir, config.hooks) : undefined
    await removeStaleAuthCopies(root)
    const copiedWritableAuth = await copyAuthIntoJail(
      root,
      writableAuthSources,
      { replace: false },
    )
    await seedAuthIntoJail(root, seededAuthSources)
    const resolvedAuthSources = availableAuthSources.map((source) => ({
      source,
      destination: resolveJailRoot(source.jailRel, root),
    }))

    const bwrapArgs = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
    ]

    if (spec.readConfine) {
      for (const path of SYSTEM_RO_PATHS) bwrapArgs.push('--ro-bind-try', path, path)
      bwrapArgs.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
      for (const path of toolchainReadPaths(bin, spec.projectDir)) {
        bwrapArgs.push('--ro-bind-try', path, path)
      }
      for (const path of hooks!.paths) bwrapArgs.push('--ro-bind-try', path, path)
      for (const [alias, target] of hooks!.links) bwrapArgs.push('--symlink', target, alias)
      bwrapArgs.push('--bind', spec.projectDir, spec.projectDir)
    } else {
      bwrapArgs.push(
        '--ro-bind', '/', '/',
        '--proc', '/proc',
        '--dev', '/dev',
        '--ro-bind', spec.projectDir, spec.projectDir,
      )
    }

    for (const path of spec.extraWritablePaths ?? []) {
      bwrapArgs.push('--bind', path, path)
    }
    const writableExtras = new Set(spec.extraWritablePaths ?? [])
    for (const path of spec.extraReadablePaths ?? []) {
      if (writableExtras.has(path)) continue
      bwrapArgs.push('--ro-bind-try', path, path)
    }
    // Writable root last so it wins over any read-only mount above it.
    bwrapArgs.push('--bind', root, root)
    if (resolver && resolver !== '/etc/resolv.conf') {
      bwrapArgs.push('--ro-bind', resolver, resolver)
    }

    for (const { source: authSource, destination } of resolvedAuthSources) {
      const { source, envVar, mode } = authSource
      if (mode === 'read-only') bwrapArgs.push('--ro-bind', source, destination)
      if (envVar) bwrapArgs.push('--setenv', envVar, destination)
    }

    for (const { source, destination } of config.binds) bwrapArgs.push('--ro-bind', source, destination)
    bwrapArgs.push(...egress.bwrapArgs)
    for (const [key, value] of Object.entries(egress.env)) bwrapArgs.push('--setenv', key, value)

    for (const [key, value] of Object.entries(jailEnv(root))) {
      bwrapArgs.push('--setenv', key, value)
    }

    const nativeHome = resolvedAuthSources.find(({ source }) => source.envVar === 'CODEX_HOME')
    bwrapArgs.push('--chdir', spec.projectDir, '--die-with-parent', ...egress.prefix, bin, ...args)
    return {
      bin: BWRAP_BIN,
      args: bwrapArgs,
      ...(nativeHome
        ? { effectiveNativeStore: { harness: 'codex' as const, root: nativeHome.destination, basis: 'host-jail' as const } }
        : {}),
      cleanup: async () => {
        try { await removeAuthCopies(copiedWritableAuth) } finally {
          try { await egress.cleanup() } finally { await config.cleanup() }
        }
      },
    }
  }
}

/** Node prefix, the CLI's real install root, and ~/.cache. Ancestors of the workspace are refused. */
export function toolchainReadPaths(bin: string, projectDir: string): string[] {
  const home = canonicalizeJailPath(homedir())
  const candidates: string[] = []

  const nodeReal = tryRealpath(process.execPath)
  if (nodeReal) candidates.push(dirname(dirname(nodeReal)))

  const onPathEntry = whichPath(bin)
  if (onPathEntry) {
    candidates.push(dirname(onPathEntry))
    const real = tryRealpath(onPathEntry)
    if (real) {
      const realDir = dirname(real)
      candidates.push(basename(realDir) === 'bin' ? dirname(realDir) : realDir)
    }
  }

  candidates.push(join(home, '.cache'))

  const base = canonicalizeJailPath(projectDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const p = canonicalizeJailPath(c)
    if (seen.has(p)) continue
    seen.add(p)
    if (isSafeReadPath(p, home, base)) out.push(p)
  }
  return out
}

/** Tracked files of a configured hooks directory. Not Git metadata or untracked files. */
function gitHookReadPaths(projectDir: string, candidates: string[]): { paths: string[]; links: Map<string, string> } {
  const home = homedir(), base = canonicalizeJailPath(projectDir)
  const paths = new Set<string>(), links = new Map<string, string>(), owners = new Set<string>()
  const add = (path: string) => {
    const target = tryRealpath(path)
    if (!target || target === base || target.startsWith(`${base}${sep}`) || !isSafeReadPath(target, home, base) || !isSafeReadPath(path, home, base)) return
    paths.add(target)
    if (path !== target) links.set(path, target)
  }
  const configuredHook = git(projectDir, 'config', '--type=path', '--get', 'core.hooksPath')
  for (const configured of [...candidates, ...(configuredHook ? [configuredHook] : [])]) {
    const dir = configured ? tryRealpath(isAbsolute(configured) ? configured : resolve(git(projectDir, 'rev-parse', '--show-toplevel') ?? projectDir, configured)) : null
    if (!dir || !configured) continue
    if (!dir.startsWith(`${base}${sep}`) && dir !== base && !isSafeReadPath(dir, home, base)) throw new Error('Configured Git hooks directory would expose HOME or a workspace ancestor; use a dedicated hooks directory')
    add(isAbsolute(configured) ? configured : dir)
    for (const path of [dir, ...tryReaddir(dir).map((name) => join(dir, name))]) {
      const target = tryRealpath(path)
      if (!target) continue
      add(path)
      const owner = git(statSync(target).isDirectory() ? target : dirname(target), 'rev-parse', '--show-toplevel')
      if (!owner || owners.has(owner)) continue
      owners.add(owner)
      for (const file of (git(owner, 'ls-files', '-z') ?? '').split('\0')) {
        if (!file) continue
        const tracked = join(owner, file), real = tryRealpath(tracked)
        const rel = real && relative(owner, real)
        if (real && rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && statSync(real).isFile()) add(tracked)
      }
    }
  }
  return { paths: [...paths], links }
}

/** One git query's trimmed stdout, or null when git fails or prints nothing. */
function git(cwd: string, ...args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  if (r.error || (args[0] === 'config' && r.status !== 0 && r.status !== 1)) throw new Error('Could not resolve Git hook read paths before confinement')
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

function tryReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Refuse `/`, `/home`, the operator home, and any ancestor of the workspace. */
export function isSafeReadPath(p: string, home: string, base: string): boolean {
  if (!isAbsolute(p) || p === '/home') return false
  return [home, base].every((denied) => {
    const rel = relative(p, denied)
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  })
}

/** Absolute on-PATH location of `bin` (or `bin` itself if absolute), else null. */
function whichPath(bin: string): string | null {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const full = join(dir, bin)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      // not in this dir; keep scanning
    }
  }
  return null
}

/** realpathSync that returns null instead of throwing on a missing path. */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, bin), constants.X_OK)
      return true
    } catch {
      // not in this dir; keep scanning
    }
  }
  return false
}

let probed: boolean | undefined
function canRunUnprivileged(): boolean {
  if (probed !== undefined) return probed
  try {
    const r = spawnSync(BWRAP_BIN, ['--unshare-user', '--ro-bind', '/', '/', '--', 'true'], {
      timeout: 5000,
      stdio: 'ignore',
    })
    probed = r.status === 0
  } catch {
    probed = false
  }
  return probed
}
