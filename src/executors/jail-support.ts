/**
 * Spawner-side jail application — the single point where a resolved
 * JailSpec turns into a wrapped command.
 *
 * Given the raw `(bin, args, opts)`, if `opts.jail` is present this wraps
 * the command in the OS write-jail (bwrap on Linux, sandbox-exec on
 * macOS, no-op elsewhere) and returns the wrapped argv, merged env, and a
 * one-shot `cleanup` the spawner runs in `release()`. With no jail spec
 * this is a pure pass-through: the returned `(bin, args, env)` are
 * byte-identical to the inputs, so the unjailed spawn path is unchanged.
 *
 * Both the host and scoped-host spawners call this so the wrap logic lives
 * in exactly one place.
 */

import { selectJailBackend } from '../jail/index.js'
import type { JailBackend } from '../jail/index.js'
import type { SpawnOpts } from './types.js'

export interface JailedCommand {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
  /** Tear-down for backend-owned jail temp state; run once in release(). */
  cleanup?: () => Promise<void> | void
}

const ENABLE_HINT =
  'On Linux, enable unprivileged user namespaces once: ' +
  '`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist in /etc/sysctl.d) ' +
  'or `sudo chmod u+s /usr/bin/bwrap`.'
let warnedFallback = false

export async function applyJail(
  bin: string,
  args: string[],
  opts: SpawnOpts,
  backend: JailBackend = selectJailBackend(),
): Promise<JailedCommand> {
  if (!opts.jail) return { bin, args, env: opts.env }

  if (!(await backend.isAvailable())) {
    // A write-jail was REQUESTED but cannot be enforced on this host. Running
    // unconfined would be a silent security downgrade, so fail closed by
    // default. Operators who knowingly accept unconfined execution can opt out
    // with BRIDGE_JAIL_FALLBACK=warn.
    if (process.env.BRIDGE_JAIL_FALLBACK === 'warn') {
      if (!warnedFallback) {
        warnedFallback = true
        console.warn(
          `[cli-bridge] write-jail requested but '${backend.name}' unavailable — running ` +
          `UNCONFINED (BRIDGE_JAIL_FALLBACK=warn). ${ENABLE_HINT}`,
        )
      }
      return { bin, args, env: opts.env }
    }
    throw new Error(
      `write-jail requested but '${backend.name}' cannot run on this host, refusing to run ` +
      `unconfined. ${ENABLE_HINT} Or set BRIDGE_JAIL_FALLBACK=warn to run without confinement.`,
    )
  }

  const wrap = await backend.wrap(bin, args, opts.jail)
  // Merge any jail-supplied env onto the child env. The merged result
  // still flows through sanitizeHostEnv at the spawn site, so the host
  // env allowlist continues to apply.
  const env = wrap.env ? { ...(opts.env ?? {}), ...wrap.env } : opts.env
  return { bin: wrap.bin, args: wrap.args, env, cleanup: wrap.cleanup }
}
