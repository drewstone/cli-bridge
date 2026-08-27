import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { assertDockerNetworkName } from '../executors/docker-network.js'
import { defaultDockerNamePrefix, dockerResourceOwner } from '../executors/docker-resource-owner.js'

export interface BackendExecutorConfig {
  name: string
  kind: 'host' | 'docker'
  image?: string
  poolSize?: number
  oauthMode?: 'share' | 'per-slot'
  namePrefix?: string
  resourceOwner?: string
  hostConfigDir?: string
  containerConfigDir?: string
  containerUser?: string
  containerHome?: string
  extraMounts?: Array<{ host: string; container: string }>
  credentialFile?: string
  workspaceRoot?: string
  network?: string
}

const SHARED_RUNTIME_IMAGE = 'cli-bridge-cli-runtime:latest'
const DEFAULT_CONTAINER_HOME = '/root'
interface BackendExecutorDefaults { image: string; configRel: string; extraRels?: string[]; credentialFile?: string }
const BACKEND_EXECUTOR_DEFAULTS: Record<string, BackendExecutorDefaults> = {
  claude: { image: SHARED_RUNTIME_IMAGE, configRel: '.claude', credentialFile: '.claude/.credentials.json' },
  kimi: { image: SHARED_RUNTIME_IMAGE, configRel: '.kimi', credentialFile: '.kimi/credentials' },
  gemini: { image: SHARED_RUNTIME_IMAGE, configRel: '.gemini' },
  codex: { image: SHARED_RUNTIME_IMAGE, configRel: '.codex', credentialFile: '.codex/auth.json' },
  opencode: { image: SHARED_RUNTIME_IMAGE, configRel: '.config/opencode', extraRels: ['.local/share/opencode'], credentialFile: '.local/share/opencode/auth.json' },
  pi: { image: SHARED_RUNTIME_IMAGE, configRel: '.pi/agent', credentialFile: '.pi/agent/auth.json' },
}
const SUPPORTED_EXECUTOR_BACKENDS = Object.keys(BACKEND_EXECUTOR_DEFAULTS)
const KNOWN_DOCKER_SUFFIXES = ['IMAGE', 'POOL_SIZE', 'OAUTH_MOUNT', 'NAME_PREFIX', 'HOST_HOME', 'HOST_CONFIG_DIR', 'CONTAINER_CONFIG_DIR', 'WORKSPACE_ROOT', 'NETWORK', 'USER', 'HOME'] as const

export function parseAllExecutors(env: NodeJS.ProcessEnv, dataDir: string): Record<string, BackendExecutorConfig> {
  const defaultKind = parseExecutor('BRIDGE_DEFAULT_EXECUTOR', env.BRIDGE_DEFAULT_EXECUTOR, 'host')
  const out: Record<string, BackendExecutorConfig> = {}
  for (const name of SUPPORTED_EXECUTOR_BACKENDS) {
    const defaults = BACKEND_EXECUTOR_DEFAULTS[name]!
    const upper = name.toUpperCase()
    const kind = parseExecutor(`${upper}_EXECUTOR`, env[`${upper}_EXECUTOR`], defaultKind)
    assertNoUnknownDockerKeys(env, upper)
    const workspaceRootKey = `${upper}_DOCKER_WORKSPACE_ROOT`
    const rawWorkspaceRoot = env[workspaceRootKey]?.trim()
    const networkKey = `${upper}_DOCKER_NETWORK`
    const rawNetwork = env[networkKey]
    const containerUserKey = `${upper}_DOCKER_USER`
    const containerHomeKey = `${upper}_DOCKER_HOME`
    const rawContainerUser = env[containerUserKey]?.trim()
    const rawContainerHome = env[containerHomeKey]?.trim()
    const configuredDockerOnlyKey = KNOWN_DOCKER_SUFFIXES.map(suffix => `${upper}_DOCKER_${suffix}`).find(key => (env[key]?.trim() ?? '') !== '')
    if (configuredDockerOnlyKey && kind !== 'docker') throw new Error(`${configuredDockerOnlyKey} is set but ${upper}_EXECUTOR is ${kind} — the setting would be ignored. Set ${upper}_EXECUTOR=docker, or remove ${configuredDockerOnlyKey}.`)
    const cfg: BackendExecutorConfig = { name, kind }
    if (kind === 'docker') {
      cfg.image = env[`${upper}_DOCKER_IMAGE`] ?? defaults.image
      cfg.poolSize = parsePositiveInt(env[`${upper}_DOCKER_POOL_SIZE`], 4)
      cfg.oauthMode = parseOauthMode(`${upper}_DOCKER_OAUTH_MOUNT`, env[`${upper}_DOCKER_OAUTH_MOUNT`], 'share')
      cfg.resourceOwner = dockerResourceOwner(dataDir)
      cfg.namePrefix = env[`${upper}_DOCKER_NAME_PREFIX`] ?? defaultDockerNamePrefix(name, cfg.resourceOwner)
      const rawHostHome = env[`${upper}_DOCKER_HOST_HOME`]?.trim()
      if (rawHostHome && !isAbsolute(rawHostHome)) throw new Error(`${upper}_DOCKER_HOST_HOME must be an absolute host path`)
      const hostBase = rawHostHome || env.HOME || DEFAULT_CONTAINER_HOME
      const configuredPiAgentDir = name === 'pi' ? env.PI_CODING_AGENT_DIR?.trim() : undefined
      const piAgentHostPath = configuredPiAgentDir ? configuredPiAgentDir.startsWith('~/') ? join(hostBase, configuredPiAgentDir.slice(2)) : configuredPiAgentDir : undefined
      cfg.hostConfigDir = resolve(env[`${upper}_DOCKER_HOST_CONFIG_DIR`] ?? piAgentHostPath ?? `${hostBase}/${defaults.configRel}`)
      if (rawNetwork) cfg.network = assertDockerNetworkName(rawNetwork, networkKey)
      if (Boolean(rawContainerUser) !== Boolean(rawContainerHome)) throw new Error(`${containerUserKey} and ${containerHomeKey} must be configured together`)
      if (rawContainerUser && rawContainerHome) {
        cfg.containerUser = parseDockerUser(containerUserKey, rawContainerUser)
        cfg.containerHome = parseDockerHome(containerHomeKey, rawContainerHome)
      }
      const containerHome = cfg.containerHome ?? DEFAULT_CONTAINER_HOME
      cfg.containerConfigDir = env[`${upper}_DOCKER_CONTAINER_CONFIG_DIR`] ?? `${containerHome}/${defaults.configRel}`
      if (cfg.containerUser) {
        const rel = relative(containerHome, resolve(cfg.containerConfigDir))
        if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${upper}_DOCKER_CONTAINER_CONFIG_DIR=${resolve(cfg.containerConfigDir)} is outside ${containerHomeKey}=${containerHome}`)
      }
      const extraMounts = (defaults.extraRels ?? []).map(rel => ({ host: resolve(`${hostBase}/${rel}`), container: `${containerHome}/${rel}` }))
      if (extraMounts.length > 0) cfg.extraMounts = extraMounts
      if (defaults.credentialFile) cfg.credentialFile = defaults.credentialFile
      cfg.workspaceRoot = rawWorkspaceRoot ? parseDockerWorkspaceRoot(workspaceRootKey, rawWorkspaceRoot) : join(dataDir, 'workspace', name)
      assertDockerMountsDoNotOverlap(workspaceRootKey, cfg.workspaceRoot, cfg.hostConfigDir, cfg.containerConfigDir)
    }
    out[name] = cfg
  }
  return out
}

function assertNoUnknownDockerKeys(env: NodeJS.ProcessEnv, upper: string): void {
  const prefix = `${upper}_DOCKER_`; const known = new Set<string>(KNOWN_DOCKER_SUFFIXES)
  for (const key of Object.keys(env)) if (key.startsWith(prefix) && !known.has(key.slice(prefix.length))) throw new Error(`unknown setting ${key} — cli-bridge does not read it`)
}
function parseDockerUser(key: string, value: string): string {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/u.exec(value); const uid = Number(match?.[1]); const gid = Number(match?.[2])
  if (!match || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid > 2_147_483_647 || gid > 2_147_483_647) throw new Error(`invalid ${key}: expected positive numeric uid:gid`)
  return `${uid}:${gid}`
}
function parseDockerHome(key: string, value: string): string {
  if (!isAbsolute(value) || value === '/' || value.includes(',')) throw new Error(`invalid ${key}: expected an absolute non-root path without commas`)
  return resolve(value)
}
function canonicalOrResolvedPath(value: string): string { try { return realpathSync(value) } catch { return resolve(value) } }
function pathsOverlap(left: string, right: string): boolean {
  const rel = relative(left, right); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
function assertDockerMountsDoNotOverlap(key: string, workspace: string, hostConfig: string, containerConfig: string): void {
  const canonical = canonicalOrResolvedPath(hostConfig)
  if (pathsOverlap(workspace, canonical) || pathsOverlap(canonical, workspace)) throw new Error(`invalid ${key}: workspace and host OAuth/config directories must not overlap`)
  if (!isAbsolute(containerConfig)) throw new Error(`invalid ${key}: Docker config mount target must be absolute`)
  const target = resolve(containerConfig)
  if (pathsOverlap(workspace, target) || pathsOverlap(target, workspace)) throw new Error(`invalid ${key}: workspace and container OAuth/config directories must not overlap`)
}
function parseDockerWorkspaceRoot(key: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`invalid ${key}: expected an absolute path, got ${value}`)
  if (value.includes(',')) throw new Error(`invalid ${key}: commas are not supported in Docker bind paths`)
  let canonical: string; try { canonical = realpathSync(value) } catch { throw new Error(`invalid ${key}: path does not exist: ${value}`) }
  if (!statSync(canonical).isDirectory()) throw new Error(`invalid ${key}: path is not a directory: ${value}`)
  if (canonical === parse(canonical).root) throw new Error(`invalid ${key}: refusing to expose filesystem root ${canonical}`)
  return canonical
}
function parseExecutor(key: string, value: string | undefined, fallback: 'host' | 'docker'): 'host' | 'docker' {
  if (value === 'host' || value === 'docker') return value
  if (value === undefined || value === '') return fallback
  throw new Error(`invalid ${key}: ${value} — expected host|docker`)
}
function parseOauthMode(key: string, value: string | undefined, fallback: 'share' | 'per-slot'): 'share' | 'per-slot' {
  if (value === 'share' || value === 'per-slot') return value
  if (value === undefined || value === '') return fallback
  throw new Error(`invalid ${key}: ${value} — expected share|per-slot`)
}
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid positive integer: ${value}`)
  return parsed
}
