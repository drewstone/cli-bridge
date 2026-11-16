/** Shared Linux filesystem policy. Mount backends and Landlock consume the same resolved paths. */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { copyAuthIntoJail, gitConfigSources, removeAuthCopies, removeStaleAuthCopies, seedAuthIntoJail } from './auth-preserve.js'
import { canonicalizeJailPath, ignoreJailRoot, jailEnv, prepareJailHome, resolveJailRoot, type JailSpec } from './types.js'

export interface LinuxPathRule { source: string; destination: string; writable: boolean; optional?: boolean }
const SYSTEM_RO_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32', '/etc', '/opt']

export async function prepareLinuxPaths(bin: string, spec: JailSpec) {
  const config = await gitConfigSources(spec.projectDir, spec.extraWritablePaths)
  let copiedWritableAuth: string[] = []
  const cleanup = async () => { try { await removeAuthCopies(copiedWritableAuth) } finally { await config.cleanup() } }
  try {
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
    copiedWritableAuth = await copyAuthIntoJail(
      root,
      writableAuthSources,
      { replace: false },
    )
    await seedAuthIntoJail(root, seededAuthSources)
    const resolvedAuthSources = availableAuthSources.map((source) => ({
      source,
      destination: resolveJailRoot(source.jailRel, root),
    }))


    const paths: LinuxPathRule[] = []
    const add = (source: string, writable = false, destination = source, optional = false) => paths.push({ source, destination, writable, optional })
    if (spec.readConfine) {
      for (const path of [...SYSTEM_RO_PATHS, ...toolchainReadPaths(bin, spec.projectDir), ...hooks!.paths]) add(path, false, path, true)
      add(spec.projectDir, true)
    } else {
      add('/')
      add(spec.projectDir)
    }
    for (const path of spec.extraWritablePaths ?? []) add(path, true)
    const writableExtras = new Set(spec.extraWritablePaths ?? [])
    for (const path of spec.extraReadablePaths ?? []) if (!writableExtras.has(path)) add(path, false, path, true)
    add(root, true)
    if (resolver && resolver !== '/etc/resolv.conf') add(resolver)
    const env = jailEnv(root)
    for (const { source, destination } of resolvedAuthSources) {
      if (source.mode === 'read-only') add(source.source, false, destination)
      if (source.envVar) env[source.envVar] = destination
    }
    for (const { source, destination } of config.binds) add(source, false, destination)
    const nativeHome = resolvedAuthSources.find(({ source }) => source.envVar === 'CODEX_HOME')
    return { root, paths, links: hooks?.links ?? new Map<string, string>(), env, cleanup,
      effectiveNativeStore: nativeHome ? { harness: 'codex' as const, root: nativeHome.destination, basis: 'host-jail' as const } : undefined }
  } catch (error) { await cleanup(); throw error }
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

