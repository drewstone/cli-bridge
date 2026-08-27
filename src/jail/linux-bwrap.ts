/**
 * Linux write-jail via bubblewrap (bwrap).
 *
 * The host root is mounted read-only, `/dev` is provided, networking is
 * shared (so API calls resolve DNS and connect), and exactly one subtree —
 * the jail root — is bind-mounted writable and exported as HOME. The CLI is
 * chdir'd into the read-only project dir. Writes anywhere except the jail
 * root (and any extraWritablePaths) hit a read-only filesystem and fail. We
 * deliberately do NOT tmpfs /tmp (the bridge materializes runtime config
 * there before spawn); the CLI's temp writes go to TMPDIR=<root>/.tmp.
 *
 * Runs UNPRIVILEGED: `--unshare-user` creates a user namespace mapping the
 * caller's uid to itself, so files in the jail are owned by the real user
 * and no `sudo`/`chmod` is needed. This requires the host to permit
 * unprivileged user namespaces. Modern Ubuntu restricts that by default
 * (`kernel.apparmor_restrict_unprivileged_userns=1`) AND ships a
 * non-setuid bwrap, so on such hosts `isAvailable()` returns false and the
 * caller falls back to no-jail WITH A WARNING (see executors/jail-support).
 * Enable it once with either:
 *   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   (persist in /etc/sysctl.d)
 *   sudo chmod u+s /usr/bin/bwrap                                    (setuid bwrap)
 *
 * Bind order matters: bwrap applies mounts left-to-right, last wins. The
 * project dir is bound read-only BEFORE the writable jail root, so a root
 * nested inside the project still ends up writable.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync } from 'node:fs'
import { delimiter } from 'node:path'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  authSourceRoots,
  copyAuthIntoJail,
  removeAuthCopies,
  removeStaleAuthCopies,
} from './auth-preserve.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { ignoreJailRoot, jailEnv, peerIsolationRoot, prepareJailHome, resolveJailChild, resolveJailRoot } from './types.js'
import {
  JAIL_STATE_ENV_VARS,
  assertNoSymlinkComponents,
  ensureDirectoryNoSymlinks,
  expandUserPath,
  validateStablePath,
  validateStableTree,
  verifyStablePath,
  verifyStableTree,
  trustedTemporaryRoot,
  type StablePath,
} from './path-policy.js'
import { toolchainReadPaths } from './linux-bwrap-toolchain.js'

export { toolchainReadPaths } from './linux-bwrap-toolchain.js'

const BWRAP_BIN = 'bwrap'

/**
 * Minimal read-only system paths bound into an fs-jail (readConfine) so the
 * CLI, a shell, and the C/Python runtimes resolve. Each is bound with
 * `--ro-bind-try` so a path absent on this host is skipped, not fatal.
 *
 *   - /usr holds the bulk of binaries + shared libs + the Python stdlib.
 *   - /bin /sbin /lib* are real dirs on split-usr systems and symlinks into
 *     /usr on merged-usr systems; `--ro-bind-try` binds either shape (it
 *     follows the symlink to the target dir), so `#!/bin/sh` shebangs and
 *     PATH lookups work without assuming a layout.
 *   - /etc supplies resolv.conf, TLS trust (ssl/ca-certificates), passwd/nss.
 *   - /run/systemd/resolve is the stub-resolv.conf target on systemd-resolved
 *     hosts (where /etc/resolv.conf is a symlink into it), needed for DNS.
 *
 * Deliberately absent: /home, /root, /tmp, /var, /mnt, /media — the host repo
 * (task defs / grader keys) and sibling run scratch dirs live under those and
 * must stay invisible. The workspace and the language toolchain are added
 * explicitly (see wrap() / {@link toolchainReadPaths}).
 */
const SYSTEM_RO_PATHS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/libx32',
  '/etc',
  '/run/systemd/resolve',
]

export class LinuxBwrapJail implements JailBackend {
  readonly name = 'bwrap'

  isAvailable(): boolean {
    if (process.platform !== 'linux' || !onPath(BWRAP_BIN)) return false
    return canRunUnprivileged()
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const root = resolveJailRoot(spec.root, spec.projectDir)
    const temporaryRoot = trustedTemporaryRoot()
    await prepareJailHome(root)
    ignoreJailRoot(spec.projectDir, root)
    const identities: Array<{ identity: StablePath; label: string; tree?: boolean }> = []
    const copiedWritableAuth: string[] = []
    const copiedWritableAuthOwnership = new Map<string, StablePath>()
    const missingToolchainReadPaths = new Set<string>()
    try {
      const rootIdentity = validateStablePath(root, { label: 'jail root', kind: 'directory' })
      const projectIdentity = validateStablePath(spec.projectDir, { label: 'jail project directory', kind: 'directory' })
      identities.push(
        { identity: rootIdentity, label: 'jail root' },
        { identity: projectIdentity, label: 'jail project directory' },
      )
      const availableAuthSources = (spec.authSources ?? []).map((source) => {
        if (!existsSync(source.source)) throw new Error(`jail auth source disappeared before validation: ${source.source}`)
        return source
      })
      const writableAuthSources = availableAuthSources.filter((source) => source.mode === 'copy-writable')
      const resolvedAuthSources = availableAuthSources.map((source) => {
        const sourceIdentity = validateExistingAuthSource(source.source, spec.projectDir, root)
        identities.push({ identity: sourceIdentity, label: `jail auth source ${source.source}`, tree: sourceIdentity.kind === 'directory' })
        if (source.mode === 'copy-writable' && !source.envVar) {
          throw new Error('a copy-writable jail auth source requires envVar')
        }
        const destination = resolveJailChild(root, source.jailRel)
        return { source, destination, sourceIdentity }
      })
      const extraReadableRoots = readableRoots(spec, resolvedAuthSources.map(({ source }) => source.source), temporaryRoot)
      const extraWritableRoots = writableRoots(spec, temporaryRoot)
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
        identities.push({ identity: stableIdentity, label: `jail extra readable path ${path}`, tree: stableIdentity.kind === 'directory' })
      }
      for (const path of spec.extraWritablePaths ?? []) {
        const identity = validateStablePath(path, {
          label: 'jail extra writable path',
          projectDir: spec.projectDir,
          allowedRoots: extraWritableRoots,
        })
        rejectPeerPath(path, root, spec.projectDir, 'jail extra writable path')
        const stableIdentity = identity.kind === 'directory'
          ? validateStableTree(path, {
              label: 'jail extra writable path',
              projectDir: spec.projectDir,
              allowedRoots: extraWritableRoots,
            })
          : identity
        identities.push({ identity: stableIdentity, label: `jail extra writable path ${path}`, tree: stableIdentity.kind === 'directory' })
      }
      await removeStaleAuthCopies(root)
      const expectedAuthSources = new Map(resolvedAuthSources.map(({ source, sourceIdentity }) => [source.source, sourceIdentity]))
      const copied = await copyAuthIntoJail(root, writableAuthSources, {
        replace: false,
        expectedSources: expectedAuthSources,
        ownership: copiedWritableAuthOwnership,
      })
      copiedWritableAuth.push(...copied)
      for (const path of copied) {
        const identity = validateStablePath(path, { label: `copied jail auth ${path}`, kind: 'file-or-directory' })
        const stableIdentity = identity.kind === 'directory'
          ? validateStableTree(path, { label: `copied jail auth ${path}` })
          : identity
        identities.push({ identity: stableIdentity, label: `copied jail auth ${path}`, tree: stableIdentity.kind === 'directory' })
      }
      for (const { source, destination, sourceIdentity } of resolvedAuthSources) {
        if (source.mode !== 'read-only') continue
        const identity = prepareReadOnlyAuthDestination(destination, sourceIdentity)
        identities.push({
          identity,
          label: `jail auth destination ${source.source}`,
          tree: identity.kind === 'directory',
        })
      }
      for (const target of spec.writableEnvironment ?? []) {
        const destination = resolveJailChild(root, target.jailRel)
        ensureDirectoryNoSymlinks(destination, `jail environment ${target.envVar}`)
        const identity = validateStableTree(destination, { label: `jail environment ${target.envVar}` })
        identities.push({ identity, label: `jail environment ${target.envVar}` })
      }

      const bwrapArgs = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net']
      for (const variable of JAIL_STATE_ENV_VARS) bwrapArgs.push('--unsetenv', variable)
      for (const [name, value] of Object.entries(spec.environment ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes('\u0000')) {
          throw new Error(`invalid jail environment variable ${name}`)
        }
        bwrapArgs.push('--setenv', name, value)
      }

      if (spec.readConfine) {
      // fs-jail: ALLOWLIST reads. Bind only the minimal system + toolchain
      // paths the CLI and its runtimes need; the host repo, sibling run
      // scratch dirs, and the host /tmp are simply never mounted, so a jailed
      // shell cannot read benchmark task definitions or grader answer keys.
      // /tmp is a FRESH empty tmpfs (writable, ephemeral) — the host /tmp
      // (twins, other runs' materialized config) is invisible. The workspace
      // is re-exposed READ-WRITE below (it commonly lives under /tmp), after
      // the tmpfs, so a coding agent can still build its solution.
      for (const path of SYSTEM_RO_PATHS) bwrapArgs.push('--ro-bind-try', path, path)
      bwrapArgs.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
      for (const path of toolchainReadPaths(bin, spec.projectDir)) {
        if (SYSTEM_RO_PATHS.includes(path)) continue
        if (!existsSync(path)) {
          assertNoSymlinkComponents(path, 'jail toolchain read path', true)
          missingToolchainReadPaths.add(path)
          bwrapArgs.push('--ro-bind-try', path, path)
          continue
        }
        const identity = validateStablePath(path, {
          label: 'jail toolchain read path',
          kind: 'file-or-directory',
          projectDir: spec.projectDir,
        })
        identities.push({
          identity,
          label: `jail toolchain read path ${path}`,
        })
        bwrapArgs.push('--ro-bind-try', path, path)
      }
      bwrapArgs.push('--bind', spec.projectDir, spec.projectDir)
    } else {
      // write-jail: reads stay OPEN (whole host read-only), only writes are
      // confined to the jail root. Note we do NOT tmpfs /tmp: the bridge
      // materializes runtime config (MCP config, kimi config.toml,
      // OPENCODE_CONFIG) under the host tmpdir before spawn, and the CLI must
      // still read those paths. /tmp stays readable (read-only) via this bind;
      // the CLI's own temp WRITES are redirected to TMPDIR=<root>/.tmp (jailEnv).
      bwrapArgs.push('--ro-bind', '/', '/', '--dev', '/dev', '--ro-bind', spec.projectDir, spec.projectDir)
    }
      const peers = peerIsolationRoot(root, spec.projectDir)
      if (peers) bwrapArgs.push('--tmpfs', peers)

      for (const path of spec.extraReadablePaths ?? []) {
      // In an fs-jail these carry the materialized runtime config the backend
      // wrote under the host /tmp (now hidden by the tmpfs above); `-try` keeps
      // a since-removed path non-fatal. Bound after the tmpfs so they win.
      bwrapArgs.push('--ro-bind-try', path, path)
    }
      for (const path of spec.extraWritablePaths ?? []) {
        bwrapArgs.push('--bind', path, path)
      }
      // Writable root last so it wins over any read-only mount above it.
      bwrapArgs.push('--bind', root, root)

    // Make backend config available at its stable path inside the jail.
    // Read-only sources are bound after the writable root so they stay
    // read-only. Sources whose CLI takes settings locks were copied into the
    // writable root above and therefore need only their env redirect here.
      for (const { source: authSource, destination } of resolvedAuthSources) {
        const { source, envVar, mode } = authSource
        if (mode === 'read-only') bwrapArgs.push('--ro-bind', source, destination)
      // Point the backend's env var (e.g. CODEX_HOME) at the in-jail copy. Done
      // here, where the jail truly applies, so non-jailed paths are untouched.
        if (envVar) bwrapArgs.push('--setenv', envVar, destination)
      }
      for (const target of spec.writableEnvironment ?? []) {
        bwrapArgs.push('--setenv', target.envVar, resolveJailChild(root, target.jailRel))
      }
    // Redirect HOME + XDG dirs into the jail so stateful CLIs write inside it.
      for (const [key, value] of Object.entries(jailEnv(root))) {
        bwrapArgs.push('--setenv', key, value)
      }

      bwrapArgs.push('--chdir', spec.projectDir, '--die-with-parent', bin, ...args)
      identities.push({ identity: validateStableTree(root, { label: 'jail root' }), label: 'jail root', tree: true })

      return {
        bin: BWRAP_BIN,
        args: bwrapArgs,
        ...(copiedWritableAuth.length > 0
          ? { cleanup: () => removeAuthCopies(copiedWritableAuth, copiedWritableAuthOwnership) }
          : {}),
        verify: () => {
          for (const path of missingToolchainReadPaths) {
            if (existsSync(path)) throw new Error(`jail toolchain read path appeared after validation: ${path}`)
            assertNoSymlinkComponents(path, 'jail toolchain read path', true)
          }
          for (const entry of identities) {
            if (entry.tree) verifyStableTree(entry.identity, entry.label)
            else verifyStablePath(entry.identity, entry.label)
          }
        },
      }
    } catch (error) {
      if (copiedWritableAuth.length > 0) {
        try {
          await removeAuthCopies(copiedWritableAuth, copiedWritableAuthOwnership)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'jail preparation and auth rollback failed')
        }
      }
      throw error
    }
  }
}

function rejectPeerPath(path: string, root: string, projectDir: string, label: string): void {
  const peers = peerIsolationRoot(root, projectDir)
  if (!peers) return
  const candidate = resolve(path)
  const ownRoot = resolve(root)
  if (relative(peers, candidate) === '' || (isWithinPath(peers, candidate) && !isWithinPath(ownRoot, candidate))) {
    throw new Error(`${label} would expose a sibling jail root: ${path}`)
  }
}

function isWithinPath(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function validateExistingAuthSource(path: string, projectDir: string, root: string): StablePath {
  const stat = validateStablePath(path, {
    label: 'jail auth source',
    kind: 'file-or-directory',
    projectDir,
    allowedRoots: authSourceRoots(),
  })
  rejectPeerPath(path, root, projectDir, 'jail auth source')
  if (isWithinPath(projectDir, path)) throw new Error(`jail auth source is inside the project: ${path}`)
  if (stat.kind === 'directory') {
    return validateStableTree(path, { label: 'jail auth source', projectDir, allowedRoots: authSourceRoots() })
  }
  return stat
}

function prepareReadOnlyAuthDestination(destination: string, source: StablePath): StablePath {
  if (source.kind === 'directory') {
    ensureDirectoryNoSymlinks(destination, 'jail auth destination')
    return validateStableTree(destination, { label: 'jail auth destination' })
  }
  ensureDirectoryNoSymlinks(dirname(destination), 'jail auth destination parent')
  try {
    const stat = lstatSync(destination)
    if (stat.isSymbolicLink()) throw new Error(`jail auth destination is a symlink: ${destination}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    closeSync(fd)
  }
  return validateStablePath(destination, { label: 'jail auth destination', kind: 'file' })
}

function readableRoots(spec: JailSpec, authSources: readonly string[], temporaryRoot: string): string[] {
  return existingRoots([
    spec.projectDir,
    temporaryRoot,
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    dirname(process.execPath),
    ...authSources,
  ])
}

function writableRoots(spec: JailSpec, temporaryRoot: string): string[] {
  return existingRoots([spec.projectDir, temporaryRoot])
}

function existingRoots(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => existsSync(path)).map((path) => resolve(path)))]
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
/**
 * Whether bwrap can actually create its namespaces on this host. Probed
 * once (a ~tens-of-ms `bwrap ... true`) and cached, because the answer is
 * a host property, not per-request — and the failure mode (restricted
 * unprivileged userns, non-setuid bwrap) is a static host config.
 */
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
