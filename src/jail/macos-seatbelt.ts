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

import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
import { jailEnv, prepareJailHome, resolveJailRoot } from './types.js'

const SANDBOX_EXEC_BIN = 'sandbox-exec'
const SYSTEM_WRITABLE = ['/private/tmp', '/private/var/folders']

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
    const writable = [root, ...SYSTEM_WRITABLE]
    for (const path of spec.extraWritablePaths ?? []) {
      writable.push(await canonicalize(path))
    }

    const profile = buildProfile(writable)
    const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-jail-'))
    const profilePath = join(dir, 'profile.sb')
    await writeFile(profilePath, profile, { mode: 0o600 })

    return {
      bin: SANDBOX_EXEC_BIN,
      args: ['-f', profilePath, '-D', `HOME=${root}`, '-D', `WORK=${spec.projectDir}`, bin, ...args],
      // sandbox-exec does NOT rewrite the child env; -D only parameterizes the
      // profile. Return the real env so HOME/XDG actually point into the jail.
      env: jailEnv(root),
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true })
      },
    }
  }
}

function buildProfile(writable: string[]): string {
  const allow = writable.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  return [
    '(version 1)',
    '(allow default)',
    '',
    '; Confine writes to the jail root and explicit writable paths.',
    '(deny file-write* (subpath "/"))',
    '(allow file-write*',
    allow,
    ')',
    '',
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
