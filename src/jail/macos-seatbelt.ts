/**
 * macOS write-jail via sandbox-exec (SBPL).
 *
 * Modeled on holtwick/bx-mac. The profile starts permissive — reads,
 * exec, and network are allowed — then denies ALL file writes and
 * re-allows them only under the jail root (HOME), the system temp dirs,
 * and any caller-supplied writable paths. SBPL is last-match-wins, so the
 * narrow `allow` rules after the broad `deny` carve out the writable set.
 *
 * Symlinks: macOS routes /tmp and /var through /private, so subpath rules
 * must use realpath'd targets or they silently fail to match. We resolve
 * the root and every allow/deny path through realpath after creating the
 * root, and escape each before embedding it in the profile.
 *
 * The generated profile is written to a 0o600 temp file; `cleanup`
 * removes it (and its temp dir) after the spawn completes.
 */

import { accessSync, constants, existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  backendHome,
  copyAuthIntoJail,
  removeAuthCopies,
  removeStaleAuthCopies,
  seedAuthIntoJail,
} from './auth-preserve.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { ignoreJailRoot, jailEnv, prepareJailHome, resolveJailRoot } from './types.js'

const SANDBOX_EXEC_BIN = 'sandbox-exec'
// Device nodes a normal process writes to (output redirection, RNG, tracing,
// the controlling tty). These are not filesystem locations a confined run can
// persist files to, so allowing them does not weaken the "writes confined to
// the jail root" guarantee. We deliberately do NOT allow the shared temp trees
// (/private/tmp, /private/var/folders): the CLI's temp writes are redirected to
// TMPDIR=<root>/.tmp (jailEnv), which sits inside the writable root.
const DEVICE_WRITABLE = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/dtracehelper',
  '/dev/tty',
]

export class MacosSeatbeltJail implements JailBackend {
  readonly name = 'seatbelt'

  isAvailable(): boolean {
    return process.platform === 'darwin' && onPath(SANDBOX_EXEC_BIN)
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const root = await canonicalize(resolveJailRoot(spec.root, spec.projectDir))
    // Create the redirected HOME/XDG dirs under the (canonical) root so the CLI
    // can write to them; they sit inside `root`, already in the writable set.
    await prepareJailHome(root)
    const fixedPaths = await linkHostKeychains(root)
    ignoreJailRoot(spec.projectDir, root)
    // sandbox-exec cannot bind-mount, so copy the backend's host auth into the
    // jail HOME (writable, under root) — the CLI authenticates as the operator.
    // The copies are removed in cleanup() so credentials never linger in the
    // project-local jail root.
    const stableAuthSources = (spec.authSources ?? []).filter(
      (source) => source.mode === 'read-only',
    )
    const writableAuthSources = (spec.authSources ?? []).filter(
      (source) => source.mode === 'copy-writable',
    )
    const seededAuthSources = (spec.authSources ?? []).filter(
      (source) => source.mode === 'seed-writable',
    )
    for (const source of writableAuthSources) {
      if (!source.envVar) {
        throw new Error('a copy-writable jail auth source requires envVar')
      }
    }
    await removeStaleAuthCopies(root)
    const copiedAuth = await copyAuthIntoJail(root, stableAuthSources)
    // Stable writable homes (codex/claude): refreshed per run, retained after
    // exit so a later turn's `resume` finds the CLI's own session state.
    await seedAuthIntoJail(root, seededAuthSources)
    let copiedWritableAuth: string[] = []
    try {
      if (writableAuthSources.length > 0) {
        copiedWritableAuth = await copyAuthIntoJail(
          root,
          writableAuthSources,
          { replace: false },
        )
      }
    } catch (error) {
      await removeAuthCopies([
        ...copiedAuth,
        ...copiedWritableAuth,
      ])
      throw error
    }
    const removeCopiedAuth = (): Promise<void> =>
      removeAuthCopies([
        ...copiedAuth,
        ...copiedWritableAuth,
      ])
    // From here on, any failure must remove the copied credentials — otherwise a
    // throw before `cleanup` is returned leaves real auth under the repo jail root.
    try {
      const writable = [root]
      for (const path of spec.extraWritablePaths ?? []) {
        writable.push(await canonicalize(path))
      }

      // Point any backend env var (e.g. CODEX_HOME) at the in-jail copy. Done
      // here, where the jail truly applies, so non-jailed paths are untouched.
      const authEnv: Record<string, string> = {}
      for (const { source, jailRel, envVar } of spec.authSources ?? []) {
        if (!envVar || !existsSync(source)) continue
        authEnv[envVar] = resolveJailRoot(jailRel, root)
      }

      const profile = buildProfile(writable, fixedPaths)
      const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-jail-'))
      const profilePath = join(dir, 'profile.sb')
      await writeFile(profilePath, profile, { mode: 0o600 })

      return {
        bin: SANDBOX_EXEC_BIN,
        args: ['-f', profilePath, '-D', `HOME=${root}`, '-D', `WORK=${spec.projectDir}`, bin, ...args],
        // sandbox-exec does NOT rewrite the child env; -D only parameterizes the
        // profile. Return the real env so HOME/XDG actually point into the jail.
        env: { ...jailEnv(root), ...authEnv },
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true })
          await removeCopiedAuth()
        },
      }
    } catch (err) {
      await removeCopiedAuth()
      throw err
    }
  }
}

/**
 * Claude Code on macOS keeps its OAuth login in the login keychain, not in
 * ~/.claude. macOS resolves the keychain search list under
 * $HOME/Library/Keychains, so with HOME at the jail root a confined claude saw
 * only the System keychain and answered "Not logged in". Link the host
 * keychain directory into the jail HOME. The profile already allows reads
 * everywhere, so the link grants the child no access it lacked. Writes stay
 * denied: measured on macOS, `security add-generic-password` fails inside the
 * jail. A jailed claude that refreshes its token therefore cannot persist it,
 * as with the per-run credential seed on Linux.
 *
 * The bridge runs this unsandboxed on a tree the confined child can write, so
 * it never follows an entry the child could have planted: it removes a
 * non-directory `Library` and a foreign link by unlinking the entry itself,
 * and moves a real `Keychains` directory aside instead of deleting it. The
 * returned paths are fixed in the profile, so no later confined run can
 * redirect them.
 */
async function linkHostKeychains(root: string): Promise<string[]> {
  const source = join(backendHome(), 'Library', 'Keychains')
  if (!existsSync(source)) return []
  const library = join(root, 'Library')
  const target = join(library, 'Keychains')
  const libraryStat = await lstat(library).catch(() => null)
  if (libraryStat && !libraryStat.isDirectory()) await unlink(library)
  await mkdir(library, { recursive: true })
  const targetStat = await lstat(target).catch(() => null)
  if (targetStat?.isSymbolicLink()) {
    if ((await readlink(target)) === source) return [library, target]
    await unlink(target)
  } else if (targetStat?.isDirectory()) {
    await rename(target, `${target}.moved-${process.pid}-${Date.now()}`)
  } else if (targetStat) {
    await unlink(target)
  }
  try {
    await symlink(source, target)
  } catch (error) {
    // A concurrent wrap of the same jail root may have linked it first.
    const linked = (await readlink(target).catch(() => null)) === source
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !linked) throw error
  }
  return [library, target]
}

function buildProfile(writable: string[], fixed: string[] = []): string {
  const allowSubpaths = writable.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  const allowDevices = DEVICE_WRITABLE.map((path) => `  (literal "${sbplEscape(path)}")`).join('\n')
  const denyFixed = fixed.length === 0 ? [] : [
    '; The keychain link and its parent stay fixed, so a confined run cannot',
    '; point them at host paths the unsandboxed bridge later touches.',
    '(deny file-write*',
    ...fixed.map((path) => `  (literal "${sbplEscape(path)}")`),
    ')',
    '',
  ]
  return [
    '(version 1)',
    '(allow default)',
    '',
    '; Deny all writes, then re-allow only the jail root + explicit writable paths',
    '; (subpaths) and standard device nodes (literals). Shared temp trees stay',
    '; denied; the CLI writes temp to TMPDIR=<root>/.tmp instead.',
    '(deny file-write* (subpath "/"))',
    '(allow file-write*',
    allowSubpaths,
    allowDevices,
    ')',
    '',
    ...denyFixed,
  ].join('\n')
}

/** Resolve symlinks so subpath rules match macOS /private aliases; tolerate
 * a not-yet-existing path by creating it (the jail root) or returning it
 * unchanged (a writable path the CLI will create later). */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    try {
      await mkdir(path, { recursive: true })
      return await realpath(path)
    } catch {
      return path
    }
  }
}

function sbplEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
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
