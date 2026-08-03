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
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { copyAuthIntoJail, removeAuthCopies } from './auth-preserve.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { ignoreJailRoot, jailEnv, prepareJailHome, resolveJailRoot } from './types.js'

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
  '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32',
  '/etc',
  '/opt',
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
    await prepareJailHome(root)
    ignoreJailRoot(spec.projectDir, root)
    const availableAuthSources = (spec.authSources ?? []).filter((source) =>
      existsSync(source.source),
    )
    const writableAuthSources = availableAuthSources.filter(
      (source) => source.mode === 'copy-writable',
    )
    for (const source of availableAuthSources) {
      if (source.mode === 'read-only') resolveJailRoot(source.jailRel, root)
    }
    for (const source of writableAuthSources) {
      if (!source.envVar) {
        throw new Error('a copy-writable jail auth source requires envVar')
      }
    }
    const authCopyParent = join(root, '.auth-copies')
    let authCopyRoot: string | null = null
    if (writableAuthSources.length > 0) {
      await mkdir(authCopyParent, { recursive: true })
      authCopyRoot = await mkdtemp(join(authCopyParent, 'run-'))
      try {
        await copyAuthIntoJail(authCopyRoot, writableAuthSources)
      } catch (error) {
        await removeAuthCopies([authCopyRoot])
        throw error
      }
    }
    const resolvedAuthSources = availableAuthSources.map((source) => ({
      source,
      destination: resolveJailRoot(
        source.jailRel,
        source.mode === 'copy-writable' ? authCopyRoot! : root,
      ),
    }))

    const bwrapArgs = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--share-net',
    ]

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
      bwrapArgs.push(
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--ro-bind', spec.projectDir, spec.projectDir,
      )
    }

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

    // Redirect HOME + XDG dirs into the jail so stateful CLIs write inside it.
    for (const [key, value] of Object.entries(jailEnv(root))) {
      bwrapArgs.push('--setenv', key, value)
    }

    bwrapArgs.push(
      '--chdir', spec.projectDir,
      '--die-with-parent',
      bin, ...args,
    )

    return {
      bin: BWRAP_BIN,
      args: bwrapArgs,
      ...(authCopyRoot
        ? { cleanup: () => removeAuthCopies([authCopyRoot]) }
        : {}),
    }
  }
}

/**
 * Read-only paths for the language + CLI toolchain that must be visible inside
 * an fs-jail, derived at wrap time so no host layout is hard-coded:
 *
 *   - the Node install prefix (from the bridge's own interpreter), covering
 *     node/npm/pnpm and any globally-installed CLI under its lib/node_modules;
 *   - the wrapped CLI's own location — both its on-PATH entry dir (so a bare
 *     `bin` name resolves) and its realpath install root (so a bundled runtime
 *     a level up, e.g. `~/.opencode`, is readable);
 *   - the operator's `~/.cache` (tokenizer / model caches some CLIs read);
 *   - any extra dirs an operator lists in `BRIDGE_JAIL_RO_PATHS` (a PATH-style
 *     list) for a runtime whose location auto-derivation misses.
 *
 * Every candidate passes through {@link isSafeReadPath}: `/`, `/home`, the
 * operator HOME itself, and any ANCESTOR of the workspace are refused, so a
 * mis-derivation can never re-open the whole home tree or the sibling run
 * scratch dirs the jail exists to hide.
 */
export function toolchainReadPaths(bin: string, projectDir: string): string[] {
  const home = homedir()
  const candidates: string[] = []

  // Node install prefix: <prefix>/bin/node → <prefix>. Also covers npm/pnpm and
  // globally npm-installed CLIs (which live under <prefix>/lib/node_modules).
  const nodeReal = tryRealpath(process.execPath)
  if (nodeReal) candidates.push(dirname(dirname(nodeReal)))

  // The wrapped CLI itself: its on-PATH entry dir (resolves a bare name and a
  // symlink such as ~/.local/bin/opencode) plus its realpath install root.
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

  for (const p of (process.env.BRIDGE_JAIL_RO_PATHS ?? '').split(delimiter)) {
    if (p.trim()) candidates.push(resolve(p.trim()))
  }

  const base = resolve(projectDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const p = resolve(c)
    if (seen.has(p)) continue
    seen.add(p)
    if (isSafeReadPath(p, home, base)) out.push(p)
  }
  return out
}

/**
 * Reject a toolchain read-bind that would defeat the jail: the filesystem root,
 * the shared `/home`, the operator HOME itself, or any path that is the
 * workspace or an ANCESTOR of it. The ancestor check is the load-bearing one —
 * binding an ancestor read-only (e.g. `/tmp` when the workspace is a
 * `/tmp/vb-live-<id>/ws` scratch dir) would re-expose the workspace's siblings,
 * which is exactly the leak the fs-jail closes.
 */
function isSafeReadPath(p: string, home: string, base: string): boolean {
  if (!isAbsolute(p) || p === '/' || p === '/home' || p === home) return false
  const relToBase = relative(p, base)
  const isBaseOrAncestor = relToBase === '' || (!relToBase.startsWith(`..${sep}`) && relToBase !== '..' && !isAbsolute(relToBase))
  return !isBaseOrAncestor
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
