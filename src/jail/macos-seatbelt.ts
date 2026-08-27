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
import { writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createPrivateTemporaryRoot, type PrivateTemporaryRoot } from '../runtime/private-temporary.js'
import {
  authSourceRoots,
  copyAuthIntoJail,
  removeAuthCopies,
  removeStaleAuthCopies,
} from './auth-preserve.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { ignoreJailRoot, jailEnv, peerIsolationRoot, prepareJailHome, resolveJailChild, resolveJailRoot } from './types.js'
import {
  ensureDirectoryNoSymlinks,
  validateStablePath,
  validateStableTree,
  verifyStablePath,
  verifyStableTree,
  trustedTemporaryRoot,
  type StablePath,
} from './path-policy.js'

const SANDBOX_EXEC_BIN = 'sandbox-exec'
// Device nodes a normal process writes to (output redirection, RNG, tracing,
// the controlling tty). These are not filesystem locations a confined run can
// persist files to, so allowing them does not weaken the "writes confined to
// the jail root" guarantee. We deliberately do NOT allow the shared temp trees
// (/private/tmp, /private/var/folders): the CLI's temp writes are redirected to
// TMPDIR=<root>/.tmp (jailEnv), which sits inside the writable root.
const DEVICE_WRITABLE = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper', '/dev/tty']

export class MacosSeatbeltJail implements JailBackend {
  readonly name = 'seatbelt'

  isAvailable(): boolean {
    return process.platform === 'darwin' && onPath(SANDBOX_EXEC_BIN)
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const root = resolveJailRoot(spec.root, spec.projectDir)
    const temporaryRoot = trustedTemporaryRoot()
    // Create the redirected HOME/XDG dirs under the (canonical) root so the CLI
    // can write to them; they sit inside `root`, already in the writable set.
    await prepareJailHome(root)
    ignoreJailRoot(spec.projectDir, root)
    // macOS cannot bind-mount auth. Put each run's HOME and copied credentials in
    // a registered owner-only child, never directly in persistent .agent-home.
    // A SIGKILL leaves a manifest that the next bridge startup removes.
    let homeRoot: PrivateTemporaryRoot | null = null
    let profileRoot: PrivateTemporaryRoot | null = null
    const copiedRootAuth: string[] = []
    const copiedRootAuthOwnership = new Map<string, StablePath>()
    const identities: Array<{ identity: StablePath; label: string; tree?: boolean }> = []
    const writableAuthSources = (spec.authSources ?? []).filter(
      (source) => source.mode === 'copy-writable',
    )
    for (const source of writableAuthSources) {
      if (!source.envVar) {
        throw new Error('a copy-writable jail auth source requires envVar')
      }
    }
    try {
      identities.push(
        { identity: validateStablePath(root, { label: 'jail root', kind: 'directory' }), label: 'jail root' },
        { identity: validateStablePath(spec.projectDir, { label: 'jail project directory', kind: 'directory' }), label: 'jail project directory' },
      )
      // Freeze the source set at validation time. A path that was absent during
      // admission must not become a new credential input while the profile is
      // being assembled.
      const presentAuthSources = (spec.authSources ?? []).map((source) => {
        if (!existsSync(source.source)) throw new Error(`jail auth source disappeared before validation: ${source.source}`)
        return source
      })
      const authPaths = presentAuthSources.map((source) => source.source)
      const extraReadableRoots = readableRoots(spec, authPaths, temporaryRoot)
      const extraWritableRoots = writableRoots(spec, temporaryRoot)
      const authIdentities = presentAuthSources
        .map((source) => {
          const identity = validateStablePath(source.source, {
            label: 'jail auth source',
            kind: 'file-or-directory',
            projectDir: spec.projectDir,
            allowedRoots: authSourceRoots(),
          })
          rejectPeerPath(source.source, root, spec.projectDir, 'jail auth source')
          if (isWithinPath(spec.projectDir, source.source)) {
            throw new Error(`jail auth source is inside the project: ${source.source}`)
          }
          return {
            source: source.source,
            identity: identity.kind === 'directory'
              ? validateStableTree(source.source, {
                  label: 'jail auth source',
                  projectDir: spec.projectDir,
                  allowedRoots: authSourceRoots(),
                })
              : identity,
          }
        })
      identities.push(...authIdentities.map(({ source, identity }) => ({
        identity,
        label: `jail auth source ${source}`,
        tree: identity.kind === 'directory',
      })))
      for (const path of spec.extraReadablePaths ?? []) {
        const identity = validateStablePath(path, {
          label: 'jail extra readable path',
          projectDir: spec.projectDir,
          allowedRoots: extraReadableRoots,
        })
        rejectPeerPath(path, root, spec.projectDir, 'jail extra readable path')
        const stableIdentity = identity.kind === 'directory'
          ? validateStableTree(path, {
              label: 'jail extra readable path',
              projectDir: spec.projectDir,
              allowedRoots: extraReadableRoots,
            })
          : identity
        identities.push({
          identity: stableIdentity,
          label: `jail extra readable path ${path}`,
          tree: stableIdentity.kind === 'directory',
        })
      }
      await removeStaleAuthCopies(root)
      homeRoot = createPrivateTemporaryRoot(root, '.cli-bridge-jail-home-')
      await prepareJailHome(homeRoot.path)
      await copyAuthIntoJail(homeRoot.path, presentAuthSources.filter((source) => !source.envVar), {
        expectedSources: new Map(
          authIdentities
            .filter(({ source }) => presentAuthSources.find((candidate) => candidate.source === source && !candidate.envVar))
            .map(({ source, identity }) => [source, identity]),
        ),
      })
      for (const source of presentAuthSources.filter((candidate) => !candidate.envVar)) {
        const destination = resolveJailChild(homeRoot.path, source.jailRel)
        const identity = validateStablePath(destination, {
          label: 'jail auth destination',
          kind: 'file-or-directory',
        })
        const stableIdentity = identity.kind === 'directory'
          ? validateStableTree(destination, { label: 'jail auth destination' })
          : identity
        identities.push({
          identity: stableIdentity,
          label: `jail auth destination ${source.source}`,
          tree: stableIdentity.kind === 'directory',
        })
      }
      const rootAuthSources = presentAuthSources.filter((source) => source.envVar)
      copiedRootAuth.push(...await copyAuthIntoJail(root, rootAuthSources, {
        replace: false,
        expectedSources: new Map(
          authIdentities
            .filter(({ source }) => rootAuthSources.some((candidate) => candidate.source === source))
            .map(({ source, identity }) => [source, identity]),
        ),
        ownership: copiedRootAuthOwnership,
      }))
      for (const path of copiedRootAuth) {
        const identity = validateStablePath(path, { label: `copied jail auth ${path}`, kind: 'file-or-directory' })
        const stableIdentity = identity.kind === 'directory'
          ? validateStableTree(path, { label: `copied jail auth ${path}` })
          : identity
        identities.push({ identity: stableIdentity, label: `copied jail auth ${path}`, tree: stableIdentity.kind === 'directory' })
      }
      identities.push({
        identity: validateStableTree(homeRoot.path, { label: 'jail private home' }),
        label: 'jail private home',
        tree: true,
      })
      const writable = [root, homeRoot.path]
      for (const path of spec.extraWritablePaths ?? []) {
        rejectPeerPath(path, root, spec.projectDir, 'jail extra writable path')
        const candidate = existsSync(path)
          ? validateStablePath(path, {
              label: 'jail extra writable path',
              projectDir: spec.projectDir,
              allowedRoots: extraWritableRoots,
            })
          : (() => {
              ensureDirectoryNoSymlinks(path, 'jail extra writable path')
              return validateStablePath(path, {
                label: 'jail extra writable path',
                projectDir: spec.projectDir,
                allowedRoots: extraWritableRoots,
              })
            })()
        const stableCandidate = candidate.kind === 'directory'
          ? validateStableTree(candidate.path, {
            label: 'jail extra writable path',
            projectDir: spec.projectDir,
            allowedRoots: extraWritableRoots,
          })
          : candidate
        writable.push(stableCandidate.path)
        identities.push({
          identity: stableCandidate,
          label: `jail extra writable path ${path}`,
          tree: stableCandidate.kind === 'directory',
        })
      }

      // Point any backend env var (e.g. CODEX_HOME) at the in-jail copy. Done
      // here, where the jail truly applies, so non-jailed paths are untouched.
      const authEnv: Record<string, string> = {}
      for (const { source, jailRel, envVar } of presentAuthSources) {
        if (envVar && existsSync(source)) authEnv[envVar] = resolveJailChild(root, jailRel)
      }
      for (const target of spec.writableEnvironment ?? []) {
        const targetPath = resolveJailChild(root, target.jailRel)
        ensureDirectoryNoSymlinks(targetPath, `jail environment ${target.envVar}`)
        const identity = validateStableTree(targetPath, { label: `jail environment ${target.envVar}` })
        identities.push({ identity, label: `jail environment ${target.envVar}`, tree: true })
        authEnv[target.envVar] = targetPath
      }

      const peers = peerIsolationRoot(root, spec.projectDir)
      const profile = buildProfile(writable, peers ? [peers] : [])
      profileRoot = createPrivateTemporaryRoot(tmpdir(), 'cli-bridge-jail-')
      const profilePath = join(profileRoot.path, 'profile.sb')
      await writeFile(profilePath, profile, { mode: 0o600 })
      identities.push({ identity: validateStablePath(profilePath, { label: 'seatbelt profile', kind: 'file' }), label: 'seatbelt profile' })
      identities.push({ identity: validateStableTree(root, { label: 'jail root' }), label: 'jail root', tree: true })

      return {
        bin: SANDBOX_EXEC_BIN,
        args: ['-f', profilePath, '-D', `HOME=${homeRoot.path}`, '-D', `WORK=${spec.projectDir}`, bin, ...args],
        // sandbox-exec does NOT rewrite the child env; -D only parameterizes the
        // profile. Return the real env so HOME/XDG actually point into the jail.
        env: { ...(spec.environment ?? {}), ...jailEnv(homeRoot.path), ...authEnv },
        cleanup: async () => {
          await cleanupSeatbeltArtifacts(profileRoot, homeRoot, copiedRootAuth, copiedRootAuthOwnership)
        },
        verify: () => {
          for (const entry of identities) {
            if (entry.tree) verifyStableTree(entry.identity, entry.label)
            else verifyStablePath(entry.identity, entry.label)
          }
        },
      }
    } catch (err) {
      try {
        await cleanupSeatbeltArtifacts(profileRoot, homeRoot, copiedRootAuth, copiedRootAuthOwnership)
      } catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'failed to prepare and clean up macOS sandbox profile')
      }
      throw err
    }
  }
}

async function cleanupSeatbeltArtifacts(
  profileRoot: PrivateTemporaryRoot | null,
  homeRoot: PrivateTemporaryRoot | null,
  copiedRootAuth: readonly string[] = [],
  copiedRootAuthOwnership: ReadonlyMap<string, StablePath> = new Map(),
): Promise<void> {
  const failures: unknown[] = []
  try { profileRoot?.cleanup() } catch (error) { failures.push(error) }
  try { homeRoot?.cleanup() } catch (error) { failures.push(error) }
  try { await removeAuthCopies(copiedRootAuth, copiedRootAuthOwnership) } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'failed to remove macOS sandbox artifacts')
}

function buildProfile(writable: string[], hiddenReadRoots: string[] = []): string {
  const allowSubpaths = writable.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  const denyReadSubpaths = hiddenReadRoots.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  const allowReadSubpaths = writable.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  const allowDevices = DEVICE_WRITABLE.map((path) => `  (literal "${sbplEscape(path)}")`).join('\n')
  return [
    '(version 1)',
    '(allow default)',
    ...(hiddenReadRoots.length > 0
      ? [
          '(deny file-read*',
          denyReadSubpaths,
          ')',
          '(allow file-read*',
          allowReadSubpaths,
          ')',
        ]
      : []),
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
  ].join('\n')
}

function rejectPeerPath(path: string, root: string, projectDir: string, label: string): void {
  const peers = peerIsolationRoot(root, projectDir)
  if (!peers) return
  const candidate = resolve(path)
  const ownRoot = resolve(root)
  if (isWithinPath(peers, candidate) && !isWithinPath(ownRoot, candidate)) {
    throw new Error(`${label} would expose a sibling jail root: ${path}`)
  }
}

function readableRoots(spec: JailSpec, authSources: readonly string[], temporaryRoot: string): string[] {
  return existingRoots([spec.projectDir, temporaryRoot, ...authSources])
}

function writableRoots(spec: JailSpec, temporaryRoot: string): string[] {
  return existingRoots([spec.projectDir, temporaryRoot])
}

function existingRoots(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => existsSync(path)).map((path) => resolve(path)))]
}

function isWithinPath(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
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
