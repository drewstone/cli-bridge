import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { expandUserPath } from './path-policy.js'

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
    const value = p.trim()
    if (!value) continue
    candidates.push(value.startsWith('~') ? expandUserPath(value, home) : resolve(value))
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
  const isBaseOrAncestor =
    relToBase === '' || (!relToBase.startsWith(`..${sep}`) && relToBase !== '..' && !isAbsolute(relToBase))
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
