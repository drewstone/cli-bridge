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
import { copyAuthIntoJail } from './auth-preserve.js'
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
    ignoreJailRoot(spec.projectDir, root)
    // sandbox-exec cannot bind-mount, so copy the backend's host auth into the
    // jail HOME (writable, under root) — the CLI authenticates as the operator.
    // The copies are removed in cleanup() so credentials never linger in the
    // project-local jail root.
    const copiedAuth = await copyAuthIntoJail(root, spec.authSources)
    const removeCopiedAuth = async (): Promise<void> => {
      for (const copied of copiedAuth) {
        await rm(copied, { recursive: true, force: true })
      }
    }
    // From here on, any failure must remove the copied credentials — otherwise a
    // throw before `cleanup` is returned leaves real auth under the repo jail root.
    try {
      const writable = [root]
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
          await removeCopiedAuth()
        },
      }
    } catch (err) {
      await removeCopiedAuth()
      throw err
    }
  }
}

function buildProfile(writable: string[]): string {
  const allowSubpaths = writable.map((path) => `  (subpath "${sbplEscape(path)}")`).join('\n')
  const allowDevices = DEVICE_WRITABLE.map((path) => `  (literal "${sbplEscape(path)}")`).join('\n')
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
