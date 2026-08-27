/** Filesystem policy shared by jail preparation, bind construction, and spawn checks. */

import { homedir, tmpdir, userInfo } from 'node:os'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** Host variables that can name a persistent state tree. They never cross a jail boundary unchanged. */
export const JAIL_STATE_ENV_VARS = [
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_BIN_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_CONFIG_DIR',
  'PI_SESSION_DIR',
  'PI_CONFIG_FILE',
  'PI_EXTENSIONS_DIR',
  'CODEX_HOME',
  'CODEX_CONFIG_DIR',
  'CODEX_CONFIG_FILE',
  'CODEX_SESSION_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_FILE',
  'OPENCODE_DATA_DIR',
  'OPENCODE_CACHE_DIR',
  'KIMI_CONFIG_FILE',
  'KIMI_CONFIG_PATH',
  'KIMI_SESSION_DIR',
  'KIMI_HOME',
  'KIMI_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_HOME',
  'GEMINI_HOME',
  'GEMINI_CLI_HOME',
  'GEMINI_CONFIG_DIR',
  'GEMINI_CONFIG_FILE',
  'GEMINI_SESSION_DIR',
  'GEMINI_SYSTEM_MD',
  'NVM_DIR',
  'PNPM_HOME',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AZURE_CONFIG_DIR',
  'DOCKER_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_SDK_CONFIG',
  'KUBECONFIG',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_CACHE',
  'PIP_CACHE_DIR',
  'PIP_CONFIG_FILE',
  'PIP_PREFIX',
  'PYTHONUSERBASE',
  'PYTHONPATH',
  'RUSTUP_HOME',
  'CARGO_HOME',
  'GOPATH',
  'GRADLE_USER_HOME',
  'BUN_INSTALL',
  'UV_CACHE_DIR',
  'JAVA_HOME',
  'M2_HOME',
  'MAVEN_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'DOTNET_ROOT',
  'BUNDLE_PATH',
  'BUNDLE_USER_HOME',
  'COMPOSER_HOME',
  'VOLTA_HOME',
  'ASDF_DATA_DIR',
  'DENO_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const

export interface StablePathComponent {
  path: string
  device: string
  inode: string
}

export interface StableTreeEntry {
  path: string
  device: string
  inode: string
  kind: 'file' | 'directory'
}

export interface StablePath {
  path: string
  realPath: string
  kind: 'file' | 'directory'
  components: readonly StablePathComponent[]
  treeEntries?: readonly StableTreeEntry[]
}

export interface StablePathOptions {
  label?: string
  kind?: 'file' | 'directory' | 'file-or-directory'
  /** Reject a directory that is the project itself or one of its ancestors. */
  projectDir?: string
  /** Roots the canonical path must remain below. */
  allowedRoots?: readonly string[]
  /** User-supplied state paths may be absent; their child value must still be scrubbed. */
  allowMissing?: boolean
  /** A missing leaf may be created securely by the caller. */
  allowMissingLeaf?: boolean
  /** Permit a broad directory only when an internal caller has proved its purpose. */
  allowBroadDirectory?: boolean
}

/** Expand `~` and resolve a path without allowing a relative value to depend on cwd. */
export function expandUserPath(value: string, home = trustedSystemHome()): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('filesystem path must be non-empty')
  if (trimmed === '~') return resolve(home)
  if (trimmed.startsWith('~/')) return resolve(home, trimmed.slice(2))
  if (!isAbsolute(trimmed)) throw new Error(`filesystem path must be absolute or start with ~: ${trimmed}`)
  return resolve(trimmed)
}

/** Check every existing component and allow only a missing tail. */
export function assertNoSymlinkComponents(path: string, label = 'filesystem path', allowMissing = true): void {
  captureComponents(expandUserPath(path), label, allowMissing)
}

/** Return a copy of an environment with host state roots removed. */
export function scrubJailStateEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return env
  const result: NodeJS.ProcessEnv = { ...env }
  for (const key of JAIL_STATE_ENV_VARS) delete result[key]
  return result
}

/** Resolve the host temporary root without trusting an arbitrary TMPDIR tree. */
export function trustedTemporaryRoot(): string {
  const candidate = expandUserPath(tmpdir())
  assertNoSymlinkComponents(candidate, 'temporary root', false)
  const standardRoots = ['/tmp', '/private/tmp', '/var/tmp', '/run/user', '/var/folders', '/private/var/folders']
  const isStandard = standardRoots.some((root) => isWithin(root, candidate))
  if (!isStandard && !isWithin(trustedSystemHome(), candidate)) {
    throw new Error(`temporary root is outside trusted temporary or home roots: ${candidate}`)
  }
  validateStablePath(candidate, {
    label: 'temporary root',
    kind: 'directory',
    allowBroadDirectory: isStandard,
  })
  return candidate
}

/** Create a private directory one component at a time, rejecting symlinked parents. */
export function ensureDirectoryNoSymlinks(path: string, label = 'directory'): string {
  const absolute = expandUserPath(path)
  const root = parse(absolute).root
  let current = root
  const tail = absolute.slice(root.length).split(sep).filter(Boolean)
  for (const name of tail) {
    current = join(current, name)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${label} has a non-directory or symlinked component: ${current}`)
      }
      continue
    }
    mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} was replaced while being created: ${current}`)
    }
  }
  return absolute
}

/** Validate one path before it is copied or bind-mounted. */
export function validateStablePath(path: string, options: StablePathOptions = {}): StablePath {
  const label = options.label ?? 'filesystem path'
  const absolute = expandUserPath(path)
  const components = captureComponents(absolute, label, options.allowMissing || options.allowMissingLeaf)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink: ${absolute}`)
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null
  if (!kind) throw new Error(`${label} is not a regular file or directory: ${absolute}`)
  if (options.kind && options.kind !== 'file-or-directory' && options.kind !== kind) {
    throw new Error(`${label} must be a ${options.kind}: ${absolute}`)
  }
  if (!options.allowBroadDirectory && kind === 'directory' && isBroadDirectory(absolute)) {
    throw new Error(`${label} is too broad to expose: ${absolute}`)
  }
  const realPath = realpathSync(absolute)
  if (!options.allowBroadDirectory && kind === 'directory' && options.projectDir && isWithin(realPath, realpathSync(resolve(options.projectDir)))) {
    throw new Error(`${label} contains the project or is its ancestor: ${absolute}`)
  }
  if (options.allowedRoots && !options.allowedRoots.some((root) => isWithin(realpathSync(resolve(root)), realPath))) {
    throw new Error(`${label} is outside the allowed roots: ${absolute}`)
  }
  return { path: absolute, realPath, kind, components }
}

/** Walk a copied or bind-mounted tree and reject symlinks/special files. */
export function validateStableTree(path: string, options: Omit<StablePathOptions, 'kind'> = {}): StablePath {
  const identity = validateStablePath(path, { ...options, kind: 'directory' })
  return { ...identity, treeEntries: captureTree(identity.path, options.label ?? 'filesystem tree') }
}

/** Verify that every component and the leaf still names the same filesystem object. */
export function verifyStablePath(identity: StablePath, label = 'filesystem path'): void {
  const current = captureComponents(identity.path, label, false)
  if (current.length !== identity.components.length) throw new Error(`${label} components changed: ${identity.path}`)
  for (const [index, expected] of identity.components.entries()) {
    const observed = current[index]
    if (!observed || observed.path !== expected.path || observed.device !== expected.device || observed.inode !== expected.inode) {
      throw new Error(`${label} identity changed: ${identity.path}`)
    }
  }
  if (realpathSync(identity.path) !== identity.realPath) throw new Error(`${label} realpath changed: ${identity.path}`)
}

/** Verify a tree again immediately before spawn. */
export function verifyStableTree(identity: StablePath, label = 'filesystem tree'): void {
  verifyStablePath(identity, label)
  const expected = identity.treeEntries
  if (!expected) {
    captureTree(identity.path, label)
    return
  }
  const observed = captureTree(identity.path, label)
  if (
    observed.length !== expected.length ||
    observed.some((entry, index) => {
      const wanted = expected[index]
      return (
        !wanted ||
        entry.path !== wanted.path ||
        entry.device !== wanted.device ||
        entry.inode !== wanted.inode ||
        entry.kind !== wanted.kind
      )
    })
  ) {
    throw new Error(`${label} contents changed: ${identity.path}`)
  }
}

/** A path is broad when exposing it would reveal a host-wide state namespace. */
export function isBroadDirectory(path: string): boolean {
  const normalized = resolve(path)
  return new Set([
    '/',
    '/home',
    '/root',
    '/tmp',
    '/var',
    '/mnt',
    '/media',
    '/run',
    '/usr',
    '/etc',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/lib32',
    '/libx32',
    '/opt',
    '/dev',
    '/proc',
    '/sys',
    '/boot',
    '/srv',
    '/private/tmp',
    '/private/var',
    '/Users',
    '/Applications',
    '/System',
    '/Library',
    '/Volumes',
    resolve(trustedSystemHome()),
  ]).has(normalized)
}

function trustedSystemHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
}

/** Strict containment with canonical paths. */
export function isWithin(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function captureComponents(path: string, label: string, allowMissing: boolean | undefined): StablePathComponent[] {
  const absolute = resolve(path)
  const root = absolute.startsWith(sep) ? sep : absolute.slice(0, absolute.indexOf(sep) + 1)
  const components: StablePathComponent[] = []
  let current = root
  const names = absolute.slice(root.length).split(sep).filter(Boolean)
  for (const name of names) {
    current = join(current, name)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return components
      throw new Error(`${label} does not exist: ${current}`)
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`)
    components.push({ path: current, device: String(stat.dev), inode: String(stat.ino) })
  }
  return components
}

function captureTree(path: string, label: string): StableTreeEntry[] {
  const entries: StableTreeEntry[] = []
  const visit = (current: string): void => {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`)
    if (stat.isDirectory()) {
      entries.push({ path: current, device: String(stat.dev), inode: String(stat.ino), kind: 'directory' })
      for (const name of readdirSync(current).sort()) visit(join(current, name))
      return
    }
    if (!stat.isFile()) throw new Error(`${label} contains a special file: ${current}`)
    entries.push({ path: current, device: String(stat.dev), inode: String(stat.ino), kind: 'file' })
  }
  visit(path)
  return entries
}
