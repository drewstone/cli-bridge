/**
 * Linux write-jail via bubblewrap. Network starts unshared; `router` reaches
 * only router.tangle.tools. Unprivileged user namespaces: if apparmor blocks
 * them and bwrap is not setuid, `isAvailable()` is false and the caller refuses
 * unconfined execution. Bind order is left-to-right, last wins.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve4 } from 'node:dns/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  copyAuthIntoJail,
  gitConfigSources,
  removeAuthCopies,
  removeStaleAuthCopies,
  seedAuthIntoJail,
} from './auth-preserve.js'
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
    try { return await this.wrapWithGitConfig(bin, args, spec, config) }
    catch (error) { await config.cleanup(); throw error }
  }

  private async wrapWithGitConfig(bin: string, args: string[], spec: JailSpec, config: Awaited<ReturnType<typeof gitConfigSources>>): Promise<JailWrap> {
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

    const router = (spec.network ?? 'none') === 'router'
    const bwrapArgs = [
      '--unshare-user',
      ...(router ? ['--uid', '0', '--gid', '0', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SETPCAP'] : []),
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

    for (const [key, value] of Object.entries(jailEnv(root))) {
      bwrapArgs.push('--setenv', key, value)
    }

    const nativeHome = resolvedAuthSources.find(({ source }) => source.envVar === 'CODEX_HOME')
    const cleanup = async () => { try { await removeAuthCopies(copiedWritableAuth) } finally { await config.cleanup() } }
    const store = nativeHome
      ? { effectiveNativeStore: { harness: 'codex' as const, root: nativeHome.destination, basis: 'host-jail' as const } }
      : {}
    if (!router) {
      bwrapArgs.push('--chdir', spec.projectDir, '--die-with-parent', bin, ...args)
      return { bin: BWRAP_BIN, args: bwrapArgs, ...store, cleanup }
    }
    return launchRouter(bwrapArgs, spec.projectDir, bin, args, { ...store, cleanup })
  }
}

const ROUTER_HOST = 'router.tangle.tools'

/** Unshared net plus slirp, then nft drops every destination except the Router. */
async function launchRouter(
  bwrapArgs: string[],
  projectDir: string,
  bin: string,
  args: string[],
  wrap: Pick<JailWrap, 'cleanup' | 'effectiveNativeStore'>,
): Promise<JailWrap> {
  const ips = [...new Set(await resolve4(ROUTER_HOST))]
  if (ips.length === 0) throw new Error(`jail network: ${ROUTER_HOST} did not resolve`)
  const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-net-'))
  const allow = ips.map((ip) => `ip daddr ${ip} tcp dport 443 accept`).join('\n    ')
  const rules = `table inet jail {\n  chain output {\n    type filter hook output priority 0; policy drop;\n    oifname "lo" accept\n    ${allow}\n  }\n}\n`
  const enter = `#!/bin/sh\nnft -f /jail-net.nft || exit 125\nexec setpriv --nnp --bounding-set -all --inh-caps -all --ambient-caps -all -- "$@"\n`
  await writeFile(join(dir, 'hosts'), `127.0.0.1 localhost\n${ips.map((ip) => `${ip} ${ROUTER_HOST}`).join('\n')}\n`)
  await writeFile(join(dir, 'rules.nft'), rules)
  await writeFile(join(dir, 'enter'), enter)
  const supervisor = `import { spawn } from 'node:child_process'
const child = spawn('bwrap', ${JSON.stringify([...bwrapArgs, '--ro-bind', join(dir, 'hosts'), '/etc/hosts', '--ro-bind', join(dir, 'rules.nft'), '/jail-net.nft', '--ro-bind', join(dir, 'enter'), '/jail-net-enter', '--info-fd', '3', '--block-fd', '4', '--chdir', projectDir, '--die-with-parent', '/bin/sh', '/jail-net-enter', bin, ...args])}, { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] })
let info = ''
const pid = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('jail network: no pid')), 5000)
  child.stdio[3].on('data', (chunk) => { info += chunk; try { clearTimeout(timer); resolve(JSON.parse(info)['child-pid']) } catch {} })
  child.on('exit', (code) => reject(new Error('bwrap exited ' + code + ' ' + info)))
})
const slirp = spawn('slirp4netns', ['--configure', '--disable-host-loopback', '--disable-dns', '--ready-fd', '3', '--userns-path', '/proc/' + pid + '/ns/user', '--netns-type', 'path', '/proc/' + pid + '/ns/net', 'tap0'], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('jail network: slirp not ready')), 5000)
  slirp.stdio[3].once('data', () => { clearTimeout(timer); resolve() })
  slirp.on('exit', (code) => reject(new Error('slirp exited ' + code)))
})
child.stdio[4].end('x')
const code = await new Promise((resolve) => child.on('exit', resolve))
try { slirp.kill('SIGKILL') } catch {}
process.exit(code ?? 1)
`
  await writeFile(join(dir, 'supervise.mjs'), supervisor)
  const previous = wrap.cleanup
  return {
    bin: process.execPath,
    args: [join(dir, 'supervise.mjs')],
    ...wrap,
    cleanup: async () => { try { await previous?.() } finally { await rm(dir, { recursive: true, force: true }) } },
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
