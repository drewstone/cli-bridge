/**
 * Per-backend auth preservation for the write-jail.
 *
 * A jailed run sets HOME to the (empty) jail root, so a CLI would no longer
 * find the operator's credentials at ~/.claude, ~/.config/opencode, etc. and
 * could not authenticate. This module declares, per backend, the host paths
 * that hold its auth/config and makes them available inside the jail:
 *   - Linux (bwrap): read-only bind-mounted unless the CLI must lock settings;
 *     those exact sources are copied into writable jail storage.
 *   - macOS (sandbox-exec, no bind): copied in via {@link copyAuthIntoJail}.
 *
 * Only paths that actually exist on the host are surfaced. The mapping mirrors
 * what codex.ts already does for CODEX_HOME, generalized to every host CLI.
 */

import { existsSync, lstatSync } from 'node:fs'
import { chmod, cp, mkdir, open, readdir, rm } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveJailChild, type JailAuthSource } from './types.js'
import { hardenPrivateTemporaryTree } from '../runtime/private-temporary.js'
import { resolvePiAgentDir } from '../runtime/pi-paths.js'
import {
  ensureDirectoryNoSymlinks,
  assertNoSymlinkComponents,
  expandUserPath,
  isWithin,
  validateStablePath,
  validateStableTree,
  verifyStablePath,
  verifyStableTree,
  trustedTemporaryRoot,
  type StablePath,
} from './path-policy.js'

/**
 * $HOME-relative auth/config paths per REGISTERED backend name. Aliases that
 * share the same on-disk credentials are listed explicitly (claude-code /
 * claudish / claude all read ~/.claude; kimi-code / kimi read ~/.kimi) rather
 * than fuzzy-matched, so the credential mapping is exact and auditable.
 */
const AUTH_PATHS: Record<string, readonly string[]> = {
  'claude-code': ['.claude', '.claude.json'],
  claudish: ['.claude', '.claude.json'],
  claude: ['.claude', '.claude.json'],
  'kimi-code': ['.kimi'],
  kimi: ['.kimi'],
  opencode: ['.config/opencode', '.local/share/opencode'],
  gemini: ['.gemini'],
  // codex.ts only synthesizes a CODEX_HOME (with copied auth) when MCP passthrough
  // is active; in the common no-MCP case it reads ~/.codex, which the jail would
  // otherwise hide. Preserve it here so jailed codex authenticates either way.
  codex: ['.codex'],
  // Pi keeps provider registrations / model defaults in ~/.pi/agent. Without
  // it a jailed Pi run starts from an empty HOME and loses every provider/default.
  pi: ['.pi/agent'],
}

/** The HOME the spawned CLIs actually read, honoring a cli-bridge-set HOME. */
function backendHome(projectDir?: string): string {
  const systemHome = trustedHome()
  const configured = process.env.HOME?.trim()
  if (!configured) return systemHome
  const home = expandUserPath(configured, systemHome)
  assertNoSymlinkComponents(home, 'HOME', true)
  if (projectDir && isWithin(resolve(projectDir), resolve(home))) {
    throw new Error(`HOME is inside the project: ${home}`)
  }
  // The process's ordinary home is the discovery base, not a mount source.
  // It is safe to inspect that one directory; hostile broad roots such as `/`
  // or `/home` remain rejected by the shared policy.
  validateStablePath(home, {
    label: 'HOME',
    kind: 'directory',
    allowBroadDirectory: resolve(home) === resolve(systemHome),
    allowedRoots: authSourceRoots(),
  })
  return home
}

function trustedHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
}

/** Host roots permitted for credential/config inputs supplied to a jail. */
export function authSourceRoots(): string[] {
  return [trustedHome(), trustedTemporaryRoot()]
}

function configuredDirectory(name: string, value: string | undefined, projectDir?: string): string | null {
  if (!value?.trim()) return null
  const path = expandUserPath(value, backendHome())
  assertNoSymlinkComponents(path, name, true)
  if (projectDir && isWithin(resolve(projectDir), resolve(path))) {
    throw new Error(`${name} is inside the project: ${path}`)
  }
  if (!existsSync(path)) {
    if (!authSourceRoots().some((root) => isWithin(resolve(root), resolve(path)))) {
      throw new Error(`${name} is outside the allowed credential roots: ${path}`)
    }
    return path
  }
  validateStablePath(path, {
    label: name,
    kind: 'directory',
    ...(projectDir ? { projectDir } : {}),
    allowedRoots: authSourceRoots(),
  })
  return path
}

function existingAuthPath(path: string, label: string, projectDir?: string): boolean {
  assertNoSymlinkComponents(path, label, true)
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`)
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`${label} is not a regular path: ${path}`)
  const identity = validateStablePath(path, {
    label,
    kind: 'file-or-directory',
    ...(projectDir ? { projectDir } : {}),
    allowedRoots: authSourceRoots(),
  })
  if (projectDir && isWithin(resolve(projectDir), identity.realPath)) {
    throw new Error(`${label} is inside the project: ${path}`)
  }
  return true
}

/** Auth sources for a backend that actually exist on this host. */
export function authSourcesFor(backendName: string, options: { projectDir?: string } = {}): JailAuthSource[] {
  const projectDir = options.projectDir
  const home = backendHome(projectDir)
  const out: JailAuthSource[] = []
  for (const rel of AUTH_PATHS[backendName] ?? []) {
    const source = join(home, rel)
    if (existingAuthPath(source, `${backendName} credential path`, projectDir)) out.push({ source, jailRel: rel, mode: 'read-only' })
  }
  if (backendName === 'codex') {
    const codexHome = configuredDirectory('CODEX_HOME', process.env.CODEX_HOME, projectDir)
    if (codexHome) {
      const source = codexHome
      const idx = out.findIndex((entry) => entry.jailRel === '.codex')
      if (idx >= 0) out.splice(idx, 1)
      if (existingAuthPath(source, 'CODEX_HOME', projectDir)) out.push({ source, jailRel: '.codex', mode: 'read-only' })
    }
    // The jail applies this redirect only after it proves confinement.
    for (const entry of out) if (entry.jailRel === '.codex') entry.envVar = 'CODEX_HOME'
  }
  if (backendName === 'pi') {
    const configuredPiAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    const source = configuredPiAgentDir
      ? configuredDirectory('PI_CODING_AGENT_DIR', configuredPiAgentDir, projectDir)
      : resolvePiAgentDir(undefined)
    const idx = out.findIndex((entry) => entry.jailRel === '.pi/agent')
    if (idx >= 0) out.splice(idx, 1)
    if (source && existingAuthPath(source, 'PI_CODING_AGENT_DIR', projectDir)) {
      // Linux can bind the credential/config input read-only. Pi's journal is
      // redirected separately, so no shared agent tree is ever writable.
      out.push({
        source,
        jailRel: '.pi/agent',
        mode: process.platform === 'darwin' ? 'copy-writable' : 'read-only',
        envVar: 'PI_CODING_AGENT_DIR',
      })
    }
  }
  return out
}

/**
 * Copy auth/config into a jail-owned tree. `replace: false` is for request-
 * unique destinations and fails on an existing path; the default preserves
 * stable destination files used by another run while updating matching files.
 */
export async function copyAuthIntoJail(
  root: string,
  sources: JailAuthSource[] | undefined,
  options: {
    replace?: boolean
    expectedSources?: ReadonlyMap<string, StablePath>
    ownership?: Map<string, StablePath>
  } = {},
): Promise<string[]> {
  const copied: string[] = []
  const ownership = options.ownership ?? new Map<string, StablePath>()
  try {
    for (const { source, jailRel } of sources ?? []) {
      if (!existsSync(source)) {
        if (options.expectedSources?.has(source)) {
          throw new Error(`jail auth source disappeared before copy: ${source}`)
        }
        continue
      }
      const expected = options.expectedSources?.get(source)
      if (expected) {
        if (expected.kind === 'directory') verifyStableTree(expected, 'jail auth source')
        else verifyStablePath(expected, 'jail auth source')
      }
      const sourceIdentity = expected ?? (lstatSync(source).isDirectory()
        ? validateStableTree(source, { label: 'jail auth source', allowedRoots: authSourceRoots() })
        : validateStablePath(source, { label: 'jail auth source', kind: 'file', allowedRoots: authSourceRoots() }))
      const dest = resolveJailChild(root, jailRel)
      ensureDirectoryNoSymlinks(dirname(dest), 'jail auth destination parent')
      const destinationExists = existsSync(dest)
      if (destinationExists) {
        const destinationStat = lstatSync(dest)
        if (destinationStat.isSymbolicLink()) {
          throw new Error(`jail auth destination is a symlink: ${dest}`)
        }
        if (!destinationStat.isDirectory() && !destinationStat.isFile()) {
          throw new Error(`jail auth destination is not a regular path: ${dest}`)
        }
        if (options.replace === false) {
          throw new Error(`jail auth destination already exists: ${dest}`)
        }
      } else {
        // Acquire a missing destination exclusively before copying. This gives
        // rollback ownership to this invocation even if cp or the post-copy
        // source recheck fails, and a concurrent creator gets EEXIST instead of
        // having its state removed by our cleanup.
        if (sourceIdentity.kind === 'directory') {
          await mkdir(dest, { mode: 0o700 })
        } else {
          const handle = await open(dest, 'wx', 0o600)
          await handle.close()
        }
        ownership.set(
          dest,
          validateStablePath(dest, {
            label: 'jail auth destination',
            kind: sourceIdentity.kind,
          }),
        )
        copied.push(dest)
      }
      await cp(source, dest, {
        recursive: true,
        force: true,
      })
      await chmod(dest, 0o700)
      // A source replacement during cp is detected before the child can spawn.
      if (sourceIdentity.kind === 'directory') verifyStableTree(sourceIdentity, 'jail auth source')
      else verifyStablePath(sourceIdentity, 'jail auth source')
      if (copied.includes(dest)) {
        ownership.set(
          dest,
          sourceIdentity.kind === 'directory'
            ? validateStableTree(dest, { label: 'jail auth destination' })
            : validateStablePath(dest, { label: 'jail auth destination', kind: 'file' }),
        )
      }
    }
    hardenPrivateTemporaryTree(root)
    return copied
  } catch (error) {
    await removeAuthCopies(copied, ownership)
    throw error
  }
}

/** Remove dead-process Pi config copies left by the older shared-root path. */
export async function removeStaleAuthCopies(root: string): Promise<void> {
  const parent = resolveJailChild(root, '.auth-copies')
  let parentIdentity: StablePath
  try {
    const parentStat = lstatSync(parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`stale auth-copy parent is not a real directory: ${parent}`)
    }
    parentIdentity = validateStablePath(parent, {
      label: 'stale auth-copy parent',
      kind: 'directory',
    })
  } catch (error) {
    if (isMissingPath(error)) return
    throw error
  }
  const names = await readdir(parent)
  verifyStablePath(parentIdentity, 'stale auth-copy parent')
  for (const name of names) {
    const match = /^pi-(\d+)-/u.exec(name)
    if (!match) continue
    const ownerPid = Number(match[1])
    if (ownerPid === process.pid || processExists(ownerPid)) continue
    const path = resolveJailChild(root, `.auth-copies/${name}`)
    let identity: StablePath
    try {
      identity = validateStablePath(path, {
        label: 'stale auth copy',
        kind: 'file-or-directory',
      })
      if (identity.kind === 'directory') validateStableTree(path, { label: 'stale auth copy' })
    } catch (error) {
      if (isMissingPath(error)) continue
      throw error
    }
    // Recheck both the parent and the exact child immediately before removal.
    // A replaced parent must fail closed rather than turning a cleanup path
    // into a recursive delete through an attacker-controlled symlink.
    verifyStablePath(parentIdentity, 'stale auth-copy parent')
    if (identity.kind === 'directory') verifyStableTree(identity, 'stale auth copy')
    else verifyStablePath(identity, 'stale auth copy')
    await rm(path, { recursive: true, force: true })
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Remove ephemeral auth/config copies after a confined process exits. */
export async function removeAuthCopies(
  paths: readonly string[],
  ownership?: ReadonlyMap<string, StablePath>,
): Promise<void> {
  for (const path of paths) {
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to remove a symlinked auth copy: ${path}`)
    if (ownership) {
      const identity = ownership.get(path)
      if (!identity) throw new Error(`refusing to remove an unowned auth copy: ${path}`)
      // The confined child is allowed to update its private config and create
      // journals beneath this directory. Preserve the ownership proof for the
      // directory itself, while still rejecting a symlink or special file
      // planted anywhere in the tree before recursive removal.
      verifyStablePath(identity, 'jail auth copy')
      if (identity.kind === 'directory') validateStableTree(path, { label: 'jail auth copy' })
    }
    await rm(path, { recursive: true, force: true })
  }
}
