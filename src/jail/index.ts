/**
 * Jail module entry point — pick the OS-appropriate write-jail backend
 * and wrap a CLI invocation in it.
 *
 *   selectJailBackend(platform) → JailBackend   (linux→bwrap, darwin→seatbelt, else noop)
 *   wrapInJail(bin, args, spec) → JailWrap       (falls back to noop if unavailable)
 *
 * The bridge is NOT wired to this yet; that is a separate step.
 */

import { LinuxBwrapJail } from './linux-bwrap.js'
import { MacosSeatbeltJail } from './macos-seatbelt.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'

export type { JailBackend, JailSpec, JailWrap } from './types.js'
export { resolveJailRoot } from './types.js'
export { LinuxBwrapJail } from './linux-bwrap.js'
export { MacosSeatbeltJail } from './macos-seatbelt.js'

/** Pass-through backend: no sandbox, argv returned unchanged. Used on
 * platforms with no supported jail, or as the fallback when the selected
 * backend is unavailable on this host. */
export class NoopJail implements JailBackend {
  readonly name = 'noop'

  /**
   * Reports UNAVAILABLE: the no-op backend cannot confine anything, so a
   * caller asking "can this host enforce a write-jail?" must hear "no". This
   * is what lets applyJail() fail closed on unsupported platforms (where
   * selectJailBackend returns NoopJail) instead of silently running
   * unconfined. wrapInJail still uses it as the explicit pass-through
   * fallback, which does not consult this flag.
   */
  isAvailable(): boolean {
    return false
  }

  wrap(bin: string, args: string[], _spec: JailSpec): JailWrap {
    return { bin, args }
  }
}

export const noopJail = new NoopJail()

/**
 * Expose extra host paths read-only inside an fs-jail. An fs-jail mounts a
 * FRESH tmpfs over `/tmp`, which hides a backend's runtime config (MCP config,
 * OPENCODE_CONFIG, kimi config.toml) that was materialized under the host
 * `/tmp` before spawn. Backends call this with those config paths so the
 * confined CLI can still read them; the linux backend binds them read-only
 * AFTER the tmpfs, so they reappear.
 *
 * No-op unless `spec` is a read-confined (fs-jail) spec: a write-jail keeps the
 * whole host readable, so nothing needs re-binding, and an absent spec means no
 * jail at all. Safe to call unconditionally from a backend.
 */
export function registerJailReadable(spec: JailSpec | null | undefined, ...paths: string[]): void {
  if (!spec?.readConfine) return
  const merged = new Set(spec.extraReadablePaths ?? [])
  for (const p of paths) if (p) merged.add(p)
  spec.extraReadablePaths = [...merged]
}

/**
 * Register one exact argv translation that applies only when a jail really
 * wraps the command. This keeps the ordinary host/Docker argv valid when a
 * requested jail is unavailable and the operator explicitly permits fallback.
 */
export function registerJailArgumentRewrite(
  spec: JailSpec | null | undefined,
  from: string,
  to: string,
  precededBy?: string,
  backends?: readonly string[],
): void {
  if (!spec || from === to) return
  const existing = spec.argumentRewrites?.find(
    (entry) => entry.from === from && entry.precededBy === precededBy && sameBackends(entry.backends, backends),
  )
  if (existing) {
    if (existing.to !== to) {
      throw new Error(`conflicting jail argument rewrite for ${from}`)
    }
    return
  }
  spec.argumentRewrites = [
    ...(spec.argumentRewrites ?? []),
    { from, to, ...(precededBy ? { precededBy } : {}), ...(backends ? { backends } : {}) },
  ]
}

function sameBackends(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((name, index) => name === right[index])
}

export function selectJailBackend(platform: NodeJS.Platform = process.platform): JailBackend {
  if (platform === 'linux') return new LinuxBwrapJail()
  if (platform === 'darwin') return new MacosSeatbeltJail()
  return noopJail
}

/**
 * Wrap `bin`/`args` in the given (or auto-selected) jail backend. If the
 * backend cannot run on this host, fall back to the no-op pass-through so
 * callers always get a usable JailWrap rather than an error.
 */
export async function wrapInJail(
  bin: string,
  args: string[],
  spec: JailSpec,
  backend: JailBackend = selectJailBackend(),
): Promise<JailWrap> {
  const active = (await backend.isAvailable()) ? backend : noopJail
  return active.wrap(bin, args, spec)
}
