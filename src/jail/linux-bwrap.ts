/**
 * Linux write-jail via bubblewrap (bwrap).
 *
 * The host root is mounted read-only, `/dev` and a fresh `/tmp` tmpfs are
 * provided, networking is shared (so API calls resolve DNS and connect),
 * and exactly one subtree — the jail root — is bind-mounted writable and
 * exported as HOME. The CLI is chdir'd into the read-only project dir.
 * Writes anywhere except the jail root (and any extraWritablePaths) hit a
 * read-only filesystem and fail.
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
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { jailEnv, prepareJailHome, resolveJailRoot } from './types.js'

const BWRAP_BIN = 'bwrap'

export class LinuxBwrapJail implements JailBackend {
  readonly name = 'bwrap'

  isAvailable(): boolean {
    if (process.platform !== 'linux' || !onPath(BWRAP_BIN)) return false
    return canRunUnprivileged()
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const root = resolveJailRoot(spec.root, spec.projectDir)
    await prepareJailHome(root)

    const bwrapArgs = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--share-net',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--ro-bind', spec.projectDir, spec.projectDir,
    ]

    for (const path of spec.extraReadablePaths ?? []) {
      bwrapArgs.push('--ro-bind', path, path)
    }
    for (const path of spec.extraWritablePaths ?? []) {
      bwrapArgs.push('--bind', path, path)
    }
    // Writable root last so it wins over any read-only mount above it.
    bwrapArgs.push('--bind', root, root)

    // Redirect HOME + XDG dirs into the jail so stateful CLIs write inside it.
    for (const [key, value] of Object.entries(jailEnv(root))) {
      bwrapArgs.push('--setenv', key, value)
    }

    bwrapArgs.push(
      '--chdir', spec.projectDir,
      '--die-with-parent',
      bin, ...args,
    )

    return { bin: BWRAP_BIN, args: bwrapArgs }
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
