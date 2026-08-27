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
import { existsSync } from 'node:fs'
import { BackendError } from '../backends/types.js'
import type { SpawnOpts } from './types.js'
import {
  assertNoSymlinkComponents,
  expandUserPath,
  isWithin,
  JAIL_STATE_ENV_VARS,
  scrubJailStateEnvironment,
  validateStablePath,
} from '../jail/path-policy.js'
import { resolveJailRoot } from '../jail/types.js'

export interface JailedCommand {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
  /** Tear-down for backend-owned jail temp state; run once in release(). */
  cleanup?: () => Promise<void> | void
  /** Recheck all path identities immediately before the OS spawn. */
  verify?: () => void
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
    // Typed BackendError (not a plain Error) so the chat wrapper surfaces it as a
    // real config error (5xx / typed SSE), not an opaque finish_reason:'error'.
    throw new BackendError(
      `write-jail requested but '${backend.name}' cannot run on this host, refusing to run ` +
        `unconfined. ${ENABLE_HINT} Or set BRIDGE_JAIL_FALLBACK=warn to run without confinement.`,
      'not_configured',
    )
  }

  // Only the executor knows that the jail will actually run. Apply backend-
  // declared path translations here, after availability is proven; the
  // explicit warn fallback above must preserve the normal host/Docker argv.
  validateJailEnvironment(opts.jail)
  const rewrittenArgs = rewriteJailArguments(args, opts.jail.argumentRewrites, backend.name)
  const wrap = await backend.wrap(bin, rewrittenArgs, opts.jail)
  // Merge any jail-supplied env onto the child env. The merged result
  // still flows through sanitizeHostEnv at the spawn site, so the host
  // env allowlist continues to apply.
  const jailOverrides = { ...(opts.jail.environment ?? {}), ...(wrap.env ?? {}) }
  // An omitted `env` means the normal child would inherit process.env. Make
  // that inheritance explicit for an active jail so host state roots cannot
  // survive merely because a backend supplied no override for one of them.
  const env = {
    ...(scrubJailStateEnvironment(opts.env ?? process.env) ?? {}),
    ...jailOverrides,
  }
  return {
    bin: wrap.bin,
    args: wrap.args,
    env,
    cleanup: wrap.cleanup,
    verify: () => {
      // The environment was admitted before wrap construction. Recheck it at
      // the final spawn boundary as well, so a replacement or symlink planted
      // during materialization cannot change the state path the child sees.
      validateJailEnvironment(opts.jail!)
      wrap.verify?.()
    },
  }
}

/**
 * State-path overrides are trusted only when they point at this run's jail or
 * at one exact path the backend registered for read-only exposure.
 *
 * The ordinary child environment is scrubbed below, but an internal caller can
 * also provide `jail.environment` (retained Pi does). Rejecting a host path at
 * this boundary prevents that control-plane value from undoing the scrub.
 */
function validateJailEnvironment(spec: NonNullable<SpawnOpts['jail']>): void {
  const root = resolveJailRoot(spec.root, spec.projectDir)
  const readableFiles = new Set((spec.extraReadablePaths ?? []).map((path) => expandUserPath(path)))
  for (const [name, rawValue] of Object.entries(spec.environment ?? {})) {
    if (!JAIL_STATE_ENV_VARS.includes(name as (typeof JAIL_STATE_ENV_VARS)[number])) continue
    const value = expandUserPath(rawValue)
    if (value !== rawValue) spec.environment![name] = value
    const insideJail = isWithin(root, value)
    const explicitlyReadable = readableFiles.has(value)
    if (!insideJail && !explicitlyReadable) {
      throw new BackendError(`jail environment ${name} points outside the run jail: ${rawValue}`, 'not_configured')
    }
    if (insideJail) {
      if (existsSync(value)) validateStablePath(value, { label: `jail environment ${name}`, projectDir: spec.projectDir })
      else assertNoSymlinkComponents(value, `jail environment ${name}`, true)
    } else {
      validateStablePath(value, { label: `jail environment ${name}`, kind: 'file-or-directory' })
    }
  }
}

export function rewriteJailArguments(
  args: string[],
  rewrites:
    | ReadonlyArray<{
        from: string
        to: string
        precededBy?: string
        backends?: readonly string[]
      }>
    | undefined,
  backendName?: string,
): string[] {
  if (!rewrites?.length) return args
  return args.map((arg, index) => {
    const rewrite = rewrites.find(
      (entry) =>
        entry.from === arg &&
        (entry.precededBy === undefined || args[index - 1] === entry.precededBy) &&
        (entry.backends === undefined || (backendName !== undefined && entry.backends.includes(backendName))),
    )
    return rewrite?.to ?? arg
  })
}
