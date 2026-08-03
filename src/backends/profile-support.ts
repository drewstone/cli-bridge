import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentProfile,
  AgentProfileConfigValue,
  AgentProfileMcpServer,
} from '@tangle-network/agent-interface'
import type { ChatMessage, ChatRequest, McpServerSpec, ProfileMaterializationReceipt } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import {
  createPrivateTemporaryRoot,
  hardenPrivateTemporaryTree,
  processMatchesOwner,
  processStartIdentity,
  reapStalePrivateTemporaryRoots,
  type PrivateTemporaryRoot,
} from '../runtime/private-temporary.js'
import {
  applyWorkspacePlan,
  assertWorkspacePlanSupported,
  type HarnessId,
  materializeProfile,
  type WorkspacePlan,
  type WorkspacePlanArgument,
  type WorkspacePlanConfigValue,
  type WorkspacePlanReceipt,
} from '@tangle-network/agent-profile-materialize'

/**
 * The host directory request-scoped files are written into.
 *
 * `undefined` means the executor mounts NO host directory into the container, so
 * a profile or MCP file written here would land where the CLI cannot read it.
 * Refusing with the setting that fixes it is the only honest answer: writing it
 * anyway is the silent-corruption path where the caller's files are discarded
 * with no error at all.
 */
function requireMaterializationCwd(cwd: string | undefined, what: string): string {
  if (cwd !== undefined) return cwd
  throw new ExecutorConfigurationError(
    `${what} needs a host directory mounted into the container, and this executor mounts none. Set the backend's ` +
      `<NAME>_DOCKER_WORKSPACE_ROOT to an absolute host directory — the pool bind-mounts it into every container at ` +
      `the identical path — or send the request without an agent_profile/mcp block.`,
  )
}

/**
 * Read one applied-plan launch value as the public string a spawn needs.
 *
 * Interface 0.40 made a plan's env values and launch arguments either public bytes or an opaque
 * `AgentProfileSecretRef` that only a private executor's `AgentProfileSecretProvider` may resolve.
 * cli-bridge holds no such provider: it spawns the harness itself and applies plans through
 * `applyWorkspacePlan`, the public-only entry point, which already rejects a plan carrying any
 * reference before its first write. So a non-string reaching here means the value arrived by a
 * route that skipped that check, and the only safe answer is refusal.
 *
 * Refusal, not rendering. `JSON.stringify`-ing a reference into argv or an env value would hand the
 * harness a nonsense token — and argv is world-readable through `/proc/<pid>/cmdline` and sits
 * outside every redaction channel, so a value that later DID carry a secret would leak with no
 * recall path. This mirrors agent-runtime's `publicConfigString`
 * (`src/runtime/supervise/pi-mcp.ts`), which refuses for the same reason on the same no-provider
 * path.
 */
function requirePublicPlanValue(
  value: WorkspacePlanConfigValue | WorkspacePlanArgument,
  where: string,
  harness: HarnessId,
): string {
  if (typeof value === 'string') return value
  throw new BackendError(
    `AgentProfile ${harness} materialization produced ${where} requiring a secret provider, ` +
      'which this path does not have — declare a public value or resolve it before the request',
    'parse_error',
  )
}

/** Every env entry of an applied plan as public strings, refusing any secret reference. */
function requirePublicPlanEnv(
  env: Record<string, WorkspacePlanConfigValue>,
  harness: HarnessId,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      requirePublicPlanValue(value, `env ${name}`, harness),
    ]),
  )
}

/**
 * Provision an AgentProfile's CWD-NATIVE dimensions (skills, context, hooks, subagents,
 * commands) into the run workspace before the harness spawns — the shared Phase-2 host
 * wiring. MCP is SKIPPED here so cli-bridge's existing per-harness MCP path (config-dir +
 * env) stays the source of truth (additive, can't regress MCP). Purely writes files into
 * `cwd`; returns env/flags (empty for the non-MCP dimensions, which are all cwd-native)
 * for the caller to apply if present. No-op only when there is no profile.
 */
export function provisionProfileWorkspace(
  req: ChatRequest,
  session: SessionRecord | null,
  harness: HarnessId,
  cwd: string | undefined,
): {
  env: Record<string, string>
  flags: string[]
  written: string[]
  unsupported?: unknown[]
  workspacePlanDigest?: string
  receipt?: ProfileMaterializationReceipt
} {
  delete req.profile_materialization_receipt
  const profile = resolveAgentProfile(req, session)
  if (!profile) return { env: {}, flags: [], written: [] }
  const workspaceCwd = requireMaterializationCwd(cwd, `${harness} AgentProfile materialization`)
  try {
    const plan = materializeProfile(profile, harness, { skip: ['mcp'] })
    assertWorkspacePlanSupported(plan)
    const applied = applyWorkspacePlan(plan, workspaceCwd)
    const receipt = retainProfileMaterializationReceipt(req, harness, plan, applied)
    return {
      env: requirePublicPlanEnv(applied.env, harness),
      flags: applied.flags.map((flag, index) =>
        requirePublicPlanValue(flag, `launch flag ${index}`, harness),
      ),
      written: applied.written,
      unsupported: applied.unsupported,
      workspacePlanDigest: applied.workspacePlanDigest,
      receipt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`AgentProfile workspace materialization failed: ${message}`, 'parse_error', error)
  }
}

export interface ProvisionedPiProfile {
  rootPath: string
  env: Record<string, string>
  flags: string[]
  written: string[]
  workspacePlanDigest: string
  receipt: ProfileMaterializationReceipt
  cleanup(): void
}

/**
 * Apply the canonical Pi profile plan without writing profile resources to the
 * task's conventional context, skill, or prompt-template paths.
 *
 * Pi has explicit per-process loaders for every native file this function
 * accepts. The files live in a unique directory under the resolved workspace
 * root so host and Docker executors see the same absolute path. Ambient context,
 * skills, and prompt templates are disabled whenever a profile is present; only
 * the exact plan files are opted back in. Generic workspace files fail closed:
 * moving one into the private directory would make its declared path invisible
 * to the agent, while writing it into the shared task directory reintroduces the
 * cross-run collision this path exists to remove.
 *
 * MCP and `extensions.pi` are handled by PiBackend's native controls, so they
 * are skipped here only after that caller has validated and prepared them.
 */
export function provisionPiProfile(
  req: ChatRequest,
  session: SessionRecord | null,
  cwd: string | undefined,
): ProvisionedPiProfile | null {
  delete req.profile_materialization_receipt
  const profile = resolveAgentProfile(req, session)
  if (!profile) return null
  const workspaceCwd = requireMaterializationCwd(cwd, 'pi AgentProfile materialization')

  let profileRoot: PrivateTemporaryRoot | null = null
  try {
    const genericFiles = profile.resources?.files?.map((file) => file.path) ?? []
    if (genericFiles.length > 0) {
      throw new Error(
        `no request-scoped Pi loader exists for generic workspace file(s): ${genericFiles.join(', ')}`,
      )
    }
    const plan = materializeProfile(profile, 'pi', { skip: ['mcp', 'extensions'] })
    assertWorkspacePlanSupported(plan)
    const nativeLoaders = assertPiPlanHasNativeLoaders(plan)

    profileRoot = createPrivateTemporaryRoot(workspaceCwd, '.cli-bridge-pi-profile-')
    const applied = applyWorkspacePlan(plan, profileRoot.path, { existingFiles: 'reject' })
    const flags = piProfileFlags(plan, applied, profileRoot.path, nativeLoaders)
    hardenPrivateTemporaryTree(profileRoot.path)
    const receipt = retainProfileMaterializationReceipt(req, 'pi', plan, applied, profileRoot.path)

    let cleaned = false
    return {
      rootPath: profileRoot.path,
      env: requirePublicPlanEnv(applied.env, 'pi'),
      flags,
      written: applied.written,
      workspacePlanDigest: applied.workspacePlanDigest,
      receipt,
      cleanup: () => {
        if (cleaned) return
        profileRoot!.cleanup()
        cleaned = true
      },
    }
  } catch (error) {
    profileRoot?.cleanup()
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`AgentProfile workspace materialization failed: ${message}`, 'parse_error', error)
  }
}

interface PiPlanNativeLoaders {
  extensionPaths: ReadonlySet<string>
}

function assertPiPlanHasNativeLoaders(plan: WorkspacePlan): PiPlanNativeLoaders {
  const extensionPaths = new Set<string>()
  for (let index = 0; index < plan.flags.length; index += 1) {
    const flag = plan.flags[index]
    const value = plan.flags[index + 1]
    if (typeof flag !== 'string' || typeof value !== 'string') {
      throw new Error('Pi materializer emitted a non-public or incomplete launch flag')
    }
    if (flag === '--extension') {
      const extension = plan.files.find((file) => file.relPath === value)
      if (extension?.source !== 'generated') {
        throw new Error(`Pi materializer extension flag does not reference a generated plan file: ${value}`)
      }
      extensionPaths.add(value)
      index += 1
      continue
    }
    if (flag === '--exclude-tools') {
      if (!value || value.startsWith('--')) {
        throw new Error('Pi materializer emitted an invalid --exclude-tools value')
      }
      index += 1
      continue
    }
    throw new Error(`Pi materializer emitted unsupported launch flag: ${flag}`)
  }
  const unsupportedPaths = plan.files
    .map((file) => file.relPath)
    .filter((path) => piProfileFileFlag(path) === null && !extensionPaths.has(path))
  if (unsupportedPaths.length > 0) {
    throw new Error(
      `no request-scoped Pi loader exists for workspace file(s): ${unsupportedPaths.join(', ')}`,
    )
  }
  return { extensionPaths }
}

function piProfileFlags(
  plan: WorkspacePlan,
  applied: WorkspacePlanReceipt,
  profileRoot: string,
  nativeLoaders: PiPlanNativeLoaders,
): string[] {
  const flags = ['--no-context-files', '--no-skills', '--no-prompt-templates']

  if (plan.systemPrompt !== undefined) {
    const systemPromptDir = join(profileRoot, '.cli-bridge')
    const systemPromptPath = join(systemPromptDir, 'system-prompt.md')
    mkdirSync(systemPromptDir, { recursive: true })
    writeFileSync(systemPromptPath, plan.systemPrompt, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    flags.push('--system-prompt', systemPromptPath)
  }

  for (let index = 0; index < applied.flags.length; index += 1) {
    const flag = applied.flags[index]
    const value = applied.flags[index + 1]
    if (typeof flag !== 'string' || typeof value !== 'string') {
      throw new Error('Pi materializer emitted a non-public or incomplete launch flag')
    }
    flags.push(flag, flag === '--extension' ? join(profileRoot, value) : value)
    index += 1
  }

  for (const path of applied.written) {
    if (nativeLoaders.extensionPaths.has(path)) continue
    const flag = piProfileFileFlag(path)
    if (flag) flags.push(flag, join(profileRoot, path))
  }
  return flags
}

function piProfileFileFlag(path: string): '--append-system-prompt' | '--skill' | '--prompt-template' | null {
  if (path === 'AGENTS.md') return '--append-system-prompt'
  if (/^\.pi\/skills\/.+\/SKILL\.md$/u.test(path)) return '--skill'
  if (/^\.pi\/prompts\/.+\.md$/u.test(path)) return '--prompt-template'
  return null
}

function retainProfileMaterializationReceipt(
  req: ChatRequest,
  harness: HarnessId,
  plan: WorkspacePlan,
  applied: WorkspacePlanReceipt,
  actualRoot?: string,
): ProfileMaterializationReceipt {
  const modes = new Map(plan.files.map((file) => [file.relPath, file.mode ?? 0o644]))
  const receipt: ProfileMaterializationReceipt = {
    schema: 'cli-bridge.profile-materialization.v1',
    harness,
    workspacePlanDigest: applied.workspacePlanDigest,
    files: applied.written.map((path) => ({
      path,
      mode: actualRoot ? statSync(join(actualRoot, path)).mode & 0o777 : modes.get(path) ?? 0o644,
    })),
    unsupported: applied.unsupported,
  }
  req.profile_materialization_receipt = receipt
  console.info(`[cli-bridge] profile materialization receipt ${JSON.stringify(receipt)}`)
  return receipt
}

export function resolveAgentProfile(req: ChatRequest, _session: SessionRecord | null): AgentProfile | null {
  if (req.agent_profile && typeof req.agent_profile === 'object') return req.agent_profile
  return null
}

/**
 * Merge request-body `mcp.mcpServers` and `agent_profile.mcp` into a
 * single normalized map keyed by server name. Request-body wins on
 * name collisions — caller's per-turn intent overrides profile
 * defaults.
 *
 * Returns `null` when neither source supplies any entries. Callers
 * that need a non-null result (e.g. opencode, which always writes a
 * config file) should default to `{}` after this returns null.
 *
 * The returned spec is the canonical `McpServerSpec` shape; backends
 * pick the fields they support and ignore the rest.
 */
export function resolveMcpServers(
  req: ChatRequest,
  session: SessionRecord | null,
): Record<string, McpServerSpec> | null {
  const merged: Record<string, McpServerSpec> = {}

  const profile = resolveAgentProfile(req, session)
  if (profile && typeof profile === 'object') {
    const profileMcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (profileMcp && typeof profileMcp === 'object') {
      const overriddenByRequest = new Set(Object.keys(req.mcp?.mcpServers ?? {}))
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        // An entry the request replaces below, and an entry explicitly disabled, are both dropped
        // before anything reads them. Converting them anyway would let a value nobody uses turn a
        // working request into a hard 400 — the validation must follow the value into use, not
        // stand in front of entries that never get there.
        if (overriddenByRequest.has(name)) continue
        if ((raw as { enabled?: unknown }).enabled === false) continue
        merged[name] = profileMcpToSpec(raw, name)
      }
    }
  }

  const requestMcp = req.mcp?.mcpServers
  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normalizeMcpServerSpec(raw, name)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Read one `AgentProfileMcpServer` configuration value as the plain string an MCP config file or a
 * server spawn needs.
 *
 * Interface 0.40 retyped `args`/`env`/`headers` from `string` to `AgentProfileConfigValue` — public
 * bytes (`{kind:'public', value}`) or an opaque `{kind:'secret-ref', key}` a private executor
 * resolves. cli-bridge is not that executor: every one of these values ends up in an on-disk MCP
 * config the harness reads (`writeMcpConfigFile`, `materializeMcpServersForPi`,
 * `materializeMcpServersForOpencode`, …), and cli-bridge has no `AgentProfileSecretProvider` to
 * resolve a reference with. So a reference is REFUSED here rather than resolved or rendered:
 * writing the reference object is nonsense to the harness, and writing a placeholder turns an auth
 * failure into what looks like a broken tool. The refusal names the reference KEY, never a value.
 *
 * `args` is refused for a second, stronger reason: those strings become the MCP server's argv,
 * which is readable by every process on the host (`/proc/<pid>/cmdline`) and lies outside every
 * redaction channel. agent-runtime's `resolveMcpServerLaunch` refuses a secret-ref in argv even
 * when it DOES hold a provider; a secret belongs in `env`, never in a command line.
 *
 * Plain `string`/`number`/`boolean` are accepted, matching agent-runtime's `publicConfigString`
 * (`src/runtime/supervise/pi-mcp.ts`): hand-written JSON profiles authored before 0.40 commonly
 * carry those where the type now says `{kind:'public'}`, and rejecting them would break every
 * caller mid-migration for no safety gain.
 */
function publicMcpConfigString(value: unknown, where: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const config = value as AgentProfileConfigValue
    if (config.kind === 'public' && typeof config.value === 'string') return config.value
    if (config.kind === 'secret-ref') {
      throw new BackendError(
        `AgentProfile ${where} is a secret-ref (${JSON.stringify(config.key)}) and cli-bridge has ` +
          'no secret provider — resolve it before the request, or declare a public value',
        'parse_error',
      )
    }
  }
  throw new BackendError(
    `AgentProfile ${where} is not a public configuration value`,
    'parse_error',
  )
}

/** Every entry of an MCP `env`/`headers` map as public strings. */
function publicMcpConfigRecord(
  record: Record<string, AgentProfileConfigValue> | undefined,
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!record || typeof record !== 'object') return out
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    out[key] = publicMcpConfigString(value, `${where}[${JSON.stringify(key)}]`)
  }
  return out
}

function profileMcpToSpec(raw: AgentProfileMcpServer, name: string): McpServerSpec {
  // AgentProfileMcpServer uses `transport`; McpServerSpec uses `type`.
  // Rename and forward only the fields we model.
  const where = `mcp[${JSON.stringify(name)}]`
  const out: McpServerSpec = {}
  if (raw.transport) out.type = raw.transport
  if (typeof raw.command === 'string') out.command = raw.command
  if (Array.isArray(raw.args)) {
    out.args = raw.args.map((arg, index) => publicMcpConfigString(arg, `${where}.args[${index}]`))
  }
  if (raw.env && typeof raw.env === 'object') {
    out.env = publicMcpConfigRecord(raw.env, `${where}.env`)
  }
  if (typeof raw.url === 'string') out.url = raw.url
  if (raw.headers && typeof raw.headers === 'object') {
    out.headers = publicMcpConfigRecord(raw.headers, `${where}.headers`)
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  const timeoutRaw = (raw as { timeout?: unknown }).timeout
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    out.timeout = timeoutRaw
  }
  return out
}

function normalizeMcpServerSpec(
  raw: McpServerSpec | Record<string, unknown>,
  name: string,
): McpServerSpec {
  // Defensive copy — drop any unknown fields, coerce types loosely.
  const r = raw as Record<string, unknown>
  const out: McpServerSpec = {}
  if (r.type === 'stdio' || r.type === 'http' || r.type === 'sse') out.type = r.type
  if (typeof r.command === 'string') out.command = r.command
  // A request-body server WINS over a profile server of the same name, so this path decides the
  // bytes that reach argv and the on-disk MCP config. It used to drop every non-string silently,
  // which turned a secret-ref in `args` into a SHORTER command line and a server that spawned
  // wrong for a reason nothing reported. Same refusal as the profile path, same reason.
  const where = `mcp.mcpServers[${JSON.stringify(name)}]`
  if (Array.isArray(r.args)) {
    out.args = (r.args as unknown[]).map((a, i) => publicMcpConfigString(a, `${where}.args[${i}]`))
  }
  if (r.env && typeof r.env === 'object') {
    out.env = publicMcpConfigRecord(r.env as Record<string, AgentProfileConfigValue>, `${where}.env`)
  }
  if (typeof r.url === 'string') out.url = r.url
  if (r.headers && typeof r.headers === 'object') {
    out.headers = publicMcpConfigRecord(
      r.headers as Record<string, AgentProfileConfigValue>,
      `${where}.headers`,
    )
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.timeout === 'number' && Number.isFinite(r.timeout) && r.timeout > 0) {
    out.timeout = r.timeout
  }
  return out
}

/**
 * True when this spec describes a local stdio MCP server. cli-bridge's
 * MCP-enabled CLI backends load stdio MCP via their config-file
 * loaders; remote http/sse MCP needs a per-backend registration path
 * that we don't model in the unified materializers.
 */
export function isStdioMcpSpec(spec: McpServerSpec): boolean {
  if (spec.enabled === false) return false
  if (spec.type === 'stdio') return Boolean(spec.command)
  if (spec.type === 'http' || spec.type === 'sse') return false
  return Boolean(spec.command)
}

/**
 * Materialize an `AgentProfile.mcp` map into a temp JSON file in the
 * standard mcp-config.json shape (any CLI taking --mcp-config-file):
 *
 *   { "mcpServers": { name: {command, args, env}, ... } }
 *
 * Returns `null` when the profile has no enabled MCP servers — backends
 * should skip the `--mcp-config` flag in that case rather than passing
 * an empty config.
 *
 * Caller MUST invoke `cleanup()` after the subprocess exits (typically
 * in a `finally` block) so the temp dir doesn't leak.
 *
 * Honours `AgentProfileMcpServer.enabled` — entries explicitly disabled
 * are dropped. Entries without a `command` (e.g., remote http/sse
 * transports) are also dropped here because the local CLIs only support
 * stdio MCP servers via `--mcp-config`. Remote MCP servers would need a
 * separate registration path (claude has `claude mcp add --transport
 * http`) which we don't model in this materializer.
 */
export interface MaterializedMcpConfig {
  configPath: string
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig | null {
  if (!profile || typeof profile !== 'object') return null
  const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
  if (!mcp || typeof mcp !== 'object') return null
  const specs: Record<string, McpServerSpec> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    if (!name || !raw || typeof raw !== 'object') continue
    specs[name] = profileMcpToSpec(raw, name)
  }
  return writeMcpConfigFile(specs)
}

/**
 * Write the canonical claude/kimi `mcp-config.json` shape from a
 * normalized `McpServerSpec` map. Filters out disabled entries.
 *
 * Both stdio and remote (http/sse) transports are emitted: Claude Code's
 * `--mcp-config` JSON natively accepts `{type:'http'|'sse', url, headers}`
 * entries alongside stdio `{command, args, env}` ones (mcp-config.json
 * schema), so a remote MCP server (e.g. an HTTP tool host the caller runs)
 * is forwarded as-is rather than silently dropped. (Earlier this path was
 * stdio-only on the mistaken assumption that claude couldn't load remote
 * servers from the config file — it can.)
 *
 * `timeout` (ms) is the per-MCP-server tool-call timeout. Claude Code
 * honors this in mcp-config.json — its default is 300_000ms which
 * kills long-running tool calls (e.g. coordinators that block while a
 * subagent audit runs). Forward when supplied so callers don't need
 * to set MCP_TIMEOUT globally (which has known-silently-ignored bugs
 * upstream).
 *
 * Returns null when no usable entries remain — backends should skip
 * the `--mcp-config` flag in that case rather than passing an empty
 * config.
 */
/**
 * Build the canonical `mcpServers` object from a normalized spec map:
 * stdio entries as `{command, args, env, timeout}`, remote http/sse
 * entries as `{type, url, headers, timeout}`. Disabled and malformed
 * entries are dropped. Shared by the claude/kimi temp-file materializer
 * and the pi workspace materializer (pi-mcp-adapter reads the same
 * `{mcpServers}` shape from `.mcp.json` / `.pi/mcp.json`).
 */
export function buildCanonicalMcpServers(
  specs: Record<string, McpServerSpec>,
): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      mcpServers[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      // Remote MCP server — Claude Code loads these from --mcp-config
      // natively. Forward type/url/headers/timeout verbatim.
      mcpServers[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    }
    // unknown transport / missing required fields → drop silently
  }
  return mcpServers
}

export function writeMcpConfigFile(
  specs: Record<string, McpServerSpec> | null,
  parent: string = tmpdir(),
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildCanonicalMcpServers(specs)
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp] materialized servers: ${serverNames.length ? serverNames.join(", ") : "(none)"} from specs: ${Object.keys(specs).join(", ") || "(empty)"}`)
  }
  if (serverNames.length === 0) return null

  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-mcp-')
  try {
    const configPath = join(root.path, 'mcp-config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600, flag: 'wx' })
    return { configPath, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

/** Write a cwd-native config without following a planted final-component symlink. */
function writeFileNoFollow(path: string, bytes: string, mode = 0o600): void {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    fchmodSync(fd, mode)
    ftruncateSync(fd, 0)
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

export function materializeMcpServersForPi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
  options: { isolateChildren?: boolean } = {},
): MaterializedMcpConfig | null {
  if (!specs) return null
  // `directTools` is pi-adapter-specific, so it is added HERE rather than in the shared canonical
  // builder that Claude and Kimi also read. It registers each server's tools as NATIVE pi tools
  // instead of leaving them behind the generic `mcp` tool, where an agent must connect to the
  // server and describe each verb before it can call one. A measured supervisor run spent turns
  // and hundreds of thousands of input tokens on that discovery before it could delegate once.
  const mcpServers = Object.fromEntries(
    Object.entries(buildCanonicalMcpServers(specs)).map(([name, server]) => [
      name,
      { ...server, directTools: true },
    ]),
  )
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp pi] materialized servers: ${serverNames.join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  if (serverNames.length === 0) return null
  const workspaceCwd = requireMaterializationCwd(cwd, 'pi MCP passthrough')
  let root: PrivateTemporaryRoot | null = null
  try {
    reapStalePiMcpConfigs()
    // pi-mcp-adapter has exposed the per-process `--mcp-config` flag since its first public
    // release. Keep the config under the mounted workspace so host and Docker Pi see the same
    // absolute path, but never mutate the project's own `.pi/mcp.json`.
    root = createPrivateTemporaryRoot(workspaceCwd, '.cli-bridge-pi-mcp-')
    const configPath = join(root.path, 'mcp.json')
    const isolatedMcpServers = options.isolateChildren ? isolatePiMcpServers(mcpServers, root.path) : mcpServers
    writeFileSync(configPath, JSON.stringify({ mcpServers: isolatedMcpServers }, null, 2), { flag: 'wx', mode: 0o600 })
    hardenPrivateTemporaryTree(root.path)
    let cleaned = false
    return {
      configPath,
      serverNames,
      cleanup: () => {
        if (cleaned) return
        root!.cleanup()
        cleaned = true
      },
    }
  } catch (error) {
    root?.cleanup()
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`backend pi failed to prepare MCP config: ${message}`, 'not_configured', error)
  }
}

/** Backward-compatible entry point; all private backend roots share one reaper. */
export function reapStalePiMcpConfigs(): number {
  return reapStalePrivateTemporaryRoots()
}

const PI_MCP_SECRET_KEY = /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|ENTICATION)?|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/iu
const PI_MCP_ISOLATION_KEY = /^(?:HOME|PATH|PWD|TMPDIR|TEMP|TMP|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_PACKAGE_DIR)$/u

/**
 * pi-mcp-adapter currently copies process.env for every stdio child.
 * Put a trusted `/usr/bin/env -i` boundary in the config so the adapter's
 * ambient environment never reaches an untrusted server, and give each server
 * a fresh HOME/XDG tree with no provider auth files.
 */
function isolatePiMcpServers(
  servers: Record<string, Record<string, unknown>>,
  root: string,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(servers).map(([name, server], index) => {
    if (typeof server.command !== 'string') return [name, server]
    const serverEnv = server.env && typeof server.env === 'object' ? server.env as Record<string, unknown> : {}
    const safeEntries: string[] = []
    for (const [key, value] of Object.entries(serverEnv)) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || PI_MCP_SECRET_KEY.test(key)) {
        throw new BackendError(`pi MCP server ${JSON.stringify(name)} declares a secret-shaped environment key ${JSON.stringify(key)}; resolve it in a private adapter instead`, 'parse_error')
      }
      if (PI_MCP_ISOLATION_KEY.test(key)) {
        throw new BackendError(`pi MCP server ${JSON.stringify(name)} cannot override isolated environment key ${JSON.stringify(key)}`, 'parse_error')
      }
      if (typeof value !== 'string' || value.includes('\u0000')) {
        throw new BackendError(`pi MCP server ${JSON.stringify(name)} has an invalid environment value for ${JSON.stringify(key)}`, 'parse_error')
      }
      safeEntries.push(`${key}=${value}`)
    }
    const home = join(root, `home-${index}`)
    const tmp = join(home, 'tmp')
    const config = join(home, '.config')
    const cache = join(home, '.cache')
    const data = join(home, '.local', 'share')
    const runtime = join(home, '.runtime')
    for (const directory of [tmp, config, cache, data, runtime]) mkdirSync(directory, { recursive: true, mode: 0o700 })
    const args = [
      '-i',
      `HOME=${home}`,
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      `TMPDIR=${tmp}`,
      `TEMP=${tmp}`,
      `TMP=${tmp}`,
      `XDG_CONFIG_HOME=${config}`,
      `XDG_CACHE_HOME=${cache}`,
      `XDG_DATA_HOME=${data}`,
      `XDG_RUNTIME_DIR=${runtime}`,
      ...safeEntries,
      '--',
      server.command,
      ...(Array.isArray(server.args) ? server.args as string[] : []),
    ]
    const { env: _discardedEnv, ...withoutEnv } = server
    return [name, { ...withoutEnv, command: '/usr/bin/env', args }]
  }))
}

/**
 * Mount a `{mcpServers}` object into a CWD-NATIVE config file
 * (`<cwd>/<subdir>/<filename>`) that a CLI discovers by working directory
 * rather than a per-invocation flag. Shared by the additive cwd-native MCP
 * backends — gemini (`.gemini/settings.json`) and droid/factory
 * (`.factory/mcp.json`). Only the schema of the `mcpServers` values differs,
 * and the caller has already transformed those.
 *
 * The file lives in the run workspace, not a temp dir, because the CLI
 * discovers config by cwd. When the file already exists (caller-
 * provisioned workspace, or the user's own project settings), the
 * requested servers are merged into its `mcpServers` map (request wins on
 * name collisions) and every other top-level key is preserved; the
 * mount's `cleanup()` restores the original bytes verbatim, otherwise it
 * removes the file and, when this mount created it, the `<subdir>`
 * directory. This is why the user's own `~/.factory/mcp.json` or
 * `~/.gemini/settings.json` is never touched — we only write the
 * project-scoped file the CLI layers on top.
 *
 * Concurrency: the CLI discovers config strictly by cwd, so two
 * overlapping runs in one workspace would either share request-scoped
 * server definitions (leaking one run's tools/secrets into the other) or
 * race on restore. Neither is acceptable — a `<filename>.lock` file
 * (O_EXCL, holds `{pid, originalBytes}`) enforces ONE active MCP mount
 * per cwd across processes. A second overlapping mount fails loud with
 * instructions to use distinct cwds; a lock whose pid is dead is stolen
 * (crashed run) after rolling the workspace back to its recorded
 * pre-mount state.
 *
 * Returns null when `mcpServers` is empty.
 */
function mountCwdNativeMcp(
  cwd: string,
  opts: { subdir: string; filename: string; backendName: string; mcpServers: Record<string, unknown> },
): MaterializedMcpConfig | null {
  const { subdir, filename, backendName, mcpServers } = opts
  const serverNames = Object.keys(mcpServers)
  if (serverNames.length === 0) return null

  const piDir = join(cwd, subdir)
  const configPath = join(piDir, filename)
  const lockPath = `${configPath}.lock`
  const recoveryPath = `${lockPath}.recovery`

  const fail = (detail: string): never => {
    throw new BackendError(
      `backend ${backendName} failed to prepare MCP config at ${configPath}: ${detail}`,
      'not_configured',
    )
  }

  let createdDir = false
  try {
    createdDir = !existsSync(piDir)
    mkdirSync(piDir, { recursive: true })
    // `writeFileNoFollow` only guards the FINAL path component; a
    // workspace that pre-created `.pi` as a symlink to a host directory
    // would still redirect every write under it. lstat does not follow —
    // require a real directory, not a link to one.
    if (!lstatSync(piDir).isDirectory()) {
      fail(`${piDir} exists but is not a real directory (symlink or file planted by the workspace)`)
    }
  } catch (err) {
    if (err instanceof BackendError) throw err
    fail(err instanceof Error ? err.message : String(err))
  }

  // Exclusive per-cwd lock (cross-process): `wx` refuses to overwrite.
  // The lock is written ONCE, atomically, with its full metadata — the
  // TRUE pre-mount state (`originalBytes`) — so a crashed run's
  // request-scoped config never outlives it: whoever steals a stale lock
  // rolls the workspace back to that recorded state instead of adopting
  // the dead run's mounted config as "original". There is deliberately
  // no in-place rewrite of a held lock (a truncate/write window would
  // let a concurrent EEXIST reader misparse a LIVE lock as stale); the
  // one post-acquire correction path goes through temp-file + rename,
  // which readers see atomically. An unreadable lock is FAIL-CLOSED
  // (contention error), never stolen.
  interface LockPayload {
    pid: number
    processStart: string | null
    originalBytes: string | null
    originalMode: number | null
    mountedDigest: string | null
    mountedDevice: string | null
    mountedInode: string | null
  }
  const writeLockAtomic = (payload: LockPayload): void => {
    const tmpPath = `${lockPath}.${process.pid}.tmp`
    // `wx` refuses a pre-planted symlink at the tmp path; rename replaces
    // the lock atomically without following links.
    rmSync(tmpPath, { force: true })
    writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
    renameSync(tmpPath, lockPath)
  }

  // Guarded read of a workspace-controlled path. A plain `readFileSync`
  // would follow symlinks and BLOCK FOREVER on a planted FIFO (host-side
  // DoS before any timeout starts). Open no-follow + non-blocking, fstat
  // the fd (no swap race), reject non-regular files and oversized bytes.
  const MAX_WORKSPACE_READ = 1024 * 1024
  const readWorkspaceFileState = (
    path: string,
    enforcePrivateMode = false,
  ): {
    bytes: string | null
    mode: number | null
    device: string | null
    inode: string | null
  } => {
    let fd: number
    try {
      fd = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { bytes: null, mode: null, device: null, inode: null }
      return fail(`${path} is not readable as a regular file (${code ?? 'unknown error'})`)
    }
    try {
      const st = fstatSync(fd, { bigint: true })
      if (!st.isFile()) fail(`${path} is not a regular file (workspace planted a special file)`)
      if (st.size > BigInt(MAX_WORKSPACE_READ)) fail(`${path} exceeds the ${MAX_WORKSPACE_READ}-byte cap`)
      if (enforcePrivateMode) fchmodSync(fd, 0o600)
      return {
        bytes: readFileSync(fd, 'utf-8'),
        mode: Number(st.mode & 0o777n),
        device: st.dev.toString(),
        inode: st.ino.toString(),
      }
    } finally {
      closeSync(fd)
    }
  }
  const readWorkspaceFileMaybe = (path: string, enforcePrivateMode = false): string | null =>
    readWorkspaceFileState(path, enforcePrivateMode).bytes
  const contentDigest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
  const matchesMountedFile = (
    state: ReturnType<typeof readWorkspaceFileState>,
    payload: Partial<LockPayload>,
  ): boolean => Boolean(
    state.bytes !== null
    && payload.mountedDigest
    && payload.mountedDevice
    && payload.mountedInode
    && state.device === payload.mountedDevice
    && state.inode === payload.mountedInode
    && contentDigest(state.bytes) === payload.mountedDigest,
  )
  const matchesOriginalFile = (
    state: ReturnType<typeof readWorkspaceFileState>,
    payload: Partial<LockPayload>,
  ): boolean => {
    if (payload.originalBytes === null) return state.bytes === null
    return typeof payload.originalBytes === 'string'
      && state.bytes === payload.originalBytes
      && state.mode === payload.originalMode
  }

  const tryAcquire = (): boolean => {
    try {
      const original = readWorkspaceFileState(configPath)
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          processStart: processStartIdentity(process.pid),
          originalBytes: original.bytes,
          originalMode: original.mode,
          mountedDigest: null,
          mountedDevice: null,
          mountedInode: null,
        } satisfies LockPayload),
        { flag: 'wx', mode: 0o600 },
      )
      return true
    } catch (err) {
      if (err instanceof BackendError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        fail(err instanceof Error ? err.message : String(err))
      }
      return false
    }
  }

  if (existsSync(recoveryPath)) {
    fail(`stale-lock recovery is already in progress at ${recoveryPath}`)
  }
  if (!tryAcquire()) {
    let stale: Partial<LockPayload> | null = null
    let staleLockBytes: string | null = null
    try {
      staleLockBytes = readWorkspaceFileMaybe(lockPath, true)
      stale = JSON.parse(staleLockBytes ?? '') as Partial<LockPayload>
    } catch {
      // Unreadable/corrupt lock: FAIL-CLOSED. Stealing here could kill a
      // live mount mid-run; a human (or a dead-pid check on a later
      // retry) resolves genuine corruption.
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: lock file ${lockPath} exists but is `
        + `unreadable; if no ${backendName} run is active in this cwd, remove it manually`,
        'not_configured',
      )
    }
    const holderPid = stale?.pid ?? null
    if (holderPid === null || processMatchesOwner(holderPid, stale?.processStart ?? null)) {
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: another run${holderPid !== null ? ` (pid ${holderPid})` : ''} holds the `
        + `mount for this cwd; ${backendName} supports one MCP-mounted run per workspace — use distinct cwds`,
        'not_configured',
      )
    }
    // Stale lock from a dead/crashed run: roll back only the exact inode and
    // content that the dead run wrote. A user may have replaced or edited the
    // file after the crash; preserving that file is safer than guessing.
    try {
      writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, processStart: processStartIdentity(process.pid) }), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (recoveryError) {
      fail(`another run is recovering a stale lock (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`)
    }
    try {
      const currentLockBytes = readWorkspaceFileMaybe(lockPath, true)
      if (currentLockBytes !== staleLockBytes) {
        fail('lock changed while stale-lock recovery was being claimed')
      }
      try {
        const current = readWorkspaceFileState(configPath)
        if (matchesMountedFile(current, stale ?? {})) {
          if (stale && typeof stale.originalBytes === 'string') {
            writeFileNoFollow(
              configPath,
              stale.originalBytes,
              typeof stale.originalMode === 'number' ? stale.originalMode : 0o600,
            )
          } else if (stale?.originalBytes === null) {
            // unlink removes a symlink itself, never its target — safe.
            rmSync(configPath, { force: true })
          } else {
            fail('stale lock has no valid original config state')
          }
        } else if (!matchesOriginalFile(current, stale ?? {})) {
          fail(`stale mounted config changed after its owner exited; preserving ${configPath} and keeping the lock`)
        }
        rmSync(lockPath, { force: true })
        if (!tryAcquire()) {
          fail('lost race stealing stale lock: another run acquired it first')
        }
      } catch (retryErr) {
        if (retryErr instanceof BackendError) throw retryErr
        fail(`lost race stealing stale lock: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
      }
    } finally {
      rmSync(recoveryPath, { force: true })
    }
  }

  const releaseLock = (): void => {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // best-effort
    }
  }

  // We hold the lock; re-read the config in case it changed between the
  // pre-acquire snapshot and acquisition, and correct the recorded
  // pre-mount state atomically if so.
  const original = readWorkspaceFileState(configPath)
  const originalBytes = original.bytes
  const originalMode = original.mode
  try {
    let recorded: string | null | undefined
    let recordedMode: number | null | undefined
    try {
      const payload = JSON.parse(readWorkspaceFileMaybe(lockPath, true) ?? '') as Partial<LockPayload>
      recorded = payload.originalBytes
      recordedMode = payload.originalMode
    } catch {
      recorded = undefined
      recordedMode = undefined
    }
    if (recorded !== originalBytes || recordedMode !== originalMode) {
      writeLockAtomic({
        pid: process.pid,
        processStart: processStartIdentity(process.pid),
        originalBytes,
        originalMode,
        mountedDigest: null,
        mountedDevice: null,
        mountedInode: null,
      })
    }
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }
  let merged: Record<string, unknown> = { mcpServers }
  if (originalBytes !== null) {
    try {
      const original = JSON.parse(originalBytes) as Record<string, unknown>
      const originalServers = (original.mcpServers ?? {}) as Record<string, unknown>
      merged = { ...original, mcpServers: { ...originalServers, ...mcpServers } }
    } catch {
      // Unparseable existing file — overwrite for the run; cleanup
      // restores the original bytes verbatim either way.
    }
  }
  const restoreOriginal = (): void => {
    if (originalBytes !== null) writeFileNoFollow(configPath, originalBytes, originalMode ?? 0o600)
    else rmSync(configPath, { force: true })
  }
  const mountedBytes = JSON.stringify(merged, null, 2)
  let mountedState: ReturnType<typeof readWorkspaceFileState> | null = null
  try {
    writeFileNoFollow(configPath, mountedBytes, 0o600)
    mountedState = readWorkspaceFileState(configPath)
    if (mountedState.bytes !== mountedBytes || !mountedState.device || !mountedState.inode) {
      fail(`could not prove the identity of the mounted config at ${configPath}`)
    }
    writeLockAtomic({
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      originalBytes,
      originalMode,
      mountedDigest: contentDigest(mountedBytes),
      mountedDevice: mountedState.device,
      mountedInode: mountedState.inode,
    })
  } catch (err) {
    try {
      const current = readWorkspaceFileState(configPath)
      if (mountedState && !matchesMountedFile(current, {
        mountedDigest: contentDigest(mountedBytes),
        mountedDevice: mountedState.device,
        mountedInode: mountedState.inode,
      })) throw new Error('mounted config identity changed before setup rollback')
      restoreOriginal()
      releaseLock()
    } catch {
      // Keep the lock and its original bytes for crash recovery.
    }
    fail(err instanceof Error ? err.message : String(err))
  }

  let cleaned = false
  return {
    configPath,
    serverNames,
    cleanup: () => {
      if (cleaned) return
      try {
        const current = readWorkspaceFileState(configPath)
        const mountedStillOwned = matchesMountedFile(current, {
          mountedDigest: contentDigest(mountedBytes),
          mountedDevice: mountedState?.device ?? null,
          mountedInode: mountedState?.inode ?? null,
        })
        if (!mountedStillOwned && !matchesOriginalFile(current, { originalBytes, originalMode })) {
          throw new Error(`mounted config changed during the run; preserving ${configPath}`)
        }
        if (mountedStillOwned && originalBytes !== null) {
          // No-follow: the workspace may have swapped the config for a
          // symlink mid-run; never restore THROUGH it from the host.
          writeFileNoFollow(configPath, originalBytes, originalMode ?? 0o600)
        } else if (mountedStillOwned) {
          rmSync(configPath, { force: true })
        }
      } catch (err) {
        // FAIL-CLOSED: restore failed (e.g. symlink planted mid-run).
        // Keep the lock — its recorded originalBytes let a later mount's
        // stale-lock recovery retry the rollback once this pid exits;
        // releasing it now would let the tampered config masquerade as
        // workspace-original state.
        throw new BackendError(
          `backend ${backendName} could not restore MCP config at ${configPath}; keeping lock: ${err instanceof Error ? err.message : String(err)}`,
          'upstream',
          err,
        )
      }
      try {
        rmSync(lockPath, { force: true })
      } catch (err) {
        throw new BackendError(
          `backend ${backendName} restored MCP config but could not remove lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
          'upstream',
          err,
        )
      }
      cleaned = true
      try {
        // Only remove `<subdir>` when this run created it AND nothing
        // else landed in it meanwhile (rmdirSync refuses non-empty dirs).
        if (originalBytes === null && createdDir) rmdirSync(piDir)
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Build the Gemini CLI `mcpServers` object from a normalized spec map.
 * Gemini's settings.json uses a DIFFERENT remote key than the canonical
 * shape: HTTP endpoints go under `httpUrl` (not `url`), SSE endpoints
 * under `url`; both take a `headers` object. `trust: true` is set so the
 * CLI does not block a headless run on a per-tool confirmation prompt.
 * stdio servers use `{command, args, env}`. Disabled/malformed entries
 * are dropped.
 */
function buildGeminiMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'http' && spec.url) {
      out[name] = {
        httpUrl: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'sse' && spec.url) {
      out[name] = {
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the gemini backend by merging them into the
 * project-scope `<cwd>/.gemini/settings.json`, which Gemini CLI layers on
 * top of the user's global `~/.gemini/settings.json`. cwd-native (no
 * per-invocation MCP flag), so it shares pi's lock + no-follow discipline
 * via `mountCwdNativeMcp`; every non-`mcpServers` settings key already in
 * the file is preserved. Returns null when no usable servers remain.
 */
export function materializeMcpServersForGemini(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const target = requireMaterializationCwd(cwd, 'gemini MCP passthrough')
  const mcpServers = buildGeminiMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp gemini] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  return mountCwdNativeMcp(target, { subdir: '.gemini', filename: 'settings.json', backendName: 'gemini', mcpServers })
}

/**
 * Build the droid (Factory) `mcpServers` object. droid's `mcp.json` is
 * nearly canonical — stdio entries carry an explicit `type:'stdio'` and
 * every entry an explicit `disabled:false`, both of which the canonical
 * shape omits. Remote entries are `{type:'http'|'sse', url, headers}`.
 */
function buildFactoryMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        type: 'stdio',
        command: spec.command,
        args: spec.args ?? [],
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        disabled: false,
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        disabled: false,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the droid/Factory backend by merging them
 * into the project-scope `<cwd>/.factory/mcp.json`, which `droid exec`
 * discovers by cwd (verified against the CLI: config candidates include
 * `join(cwd, '.factory', 'mcp.json')`). This never touches the user's
 * `~/.factory/mcp.json`. cwd-native, so it shares pi's lock + no-follow
 * discipline via `mountCwdNativeMcp`. Returns null when no usable servers
 * remain.
 */
export function materializeMcpServersForFactory(
  specs: Record<string, McpServerSpec> | null,
  cwd: string,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildFactoryMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp factory] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  return mountCwdNativeMcp(cwd, { subdir: '.factory', filename: 'mcp.json', backendName: 'factory', mcpServers })
}

/**
 * Build the ACP `session/new` `mcpServers` param array from a normalized
 * spec map. ACP takes MCP servers INLINE as a JSON-RPC param (no temp
 * file). The schema (verified live against `hermes acp`, protocol v1)
 * differs from the config-file shapes:
 *   - remote:  `{type:'http'|'sse', name, url, headers:[{name,value}]}`
 *   - stdio:   `{name, command, args, env:[{name,value}]}`
 * Note `headers`/`env` are LISTS of `{name,value}` pairs, not objects.
 * Disabled/malformed entries are dropped.
 */
export function buildAcpMcpServers(specs: Record<string, McpServerSpec> | null): Array<Record<string, unknown>> {
  if (!specs) return []
  const pairs = (map: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
    Object.entries(map ?? {}).map(([name, value]) => ({ name, value }))
  const out: Array<Record<string, unknown>> = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out.push({ name, command: spec.command, args: spec.args ?? [], env: pairs(spec.env) })
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out.push({ type: spec.type, name, url: spec.url, headers: pairs(spec.headers) })
    }
  }
  return out
}

/**
 * Same as `materializeMcpConfig` but writes opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * instead of claude/kimi's `{mcpServers: {<name>: {command, args, env}}}`.
 *
 * opencode-cli loads the file via the `OPENCODE_CONFIG` env var (which
 * cli-bridge's opencode backend sets when it spawns the CLI). The file
 * is layered on top of the user's global ~/.config/opencode/opencode.json,
 * so we only need to declare the MCP servers we want to add.
 *
 * Schema source: https://opencode.ai/config.json (`properties.mcp.additionalProperties`).
 */
export function materializeOpencodeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig {
  const specs: Record<string, McpServerSpec> = {}
  if (profile && typeof profile === 'object') {
    const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (mcp && typeof mcp === 'object') {
      for (const [name, raw] of Object.entries(mcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        specs[name] = profileMcpToSpec(raw, name)
      }
    }
  }
  const permissions = profile && typeof profile === 'object'
    ? (profile as { permissions?: Record<string, unknown> }).permissions
    : undefined
  const policy = profile?.metadata?.cliBridge as Record<string, unknown> | undefined
  const interactionPolicy = policy?.interactionPolicy === 'unattended-allow-v1'
    ? 'unattended-allow'
    : 'unattended-deny'
  return materializeMcpServersForOpencode(specs, permissions, interactionPolicy)
}

/**
 * Write opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * from a normalized `McpServerSpec` map. Layered on top of the user's
 * global `~/.config/opencode/opencode.json` via `OPENCODE_CONFIG`.
 *
 * Always returns a non-null result — opencode needs a config file even when
 * no MCP servers are declared so the permission posture is explicit.
 *
 * Schema source: https://opencode.ai/config.json
 *   (`properties.mcp.additionalProperties`).
 */
export function materializeMcpServersForOpencode(
  specs: Record<string, McpServerSpec> | null,
  callerPermissions?: Record<string, unknown> | null,
  interactionPolicy: 'interactive' | 'unattended-deny' | 'unattended-allow' = 'unattended-deny',
  parent: string = tmpdir(),
): MaterializedMcpConfig {
  const opencodeMcp: Record<string,
    | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number }
    | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean }
  > = {}
  if (specs) {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.enabled === false) continue
      if (isStdioMcpSpec(spec) && spec.command) {
        opencodeMcp[name] = {
          type: 'local',
          command: [spec.command, ...(spec.args ?? [])],
          ...(spec.env && Object.keys(spec.env).length ? { environment: spec.env } : {}),
          enabled: true,
          ...(spec.timeout ? { timeout: spec.timeout } : {}),
        }
      } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
        // opencode loads remote MCP via `{type:'remote', url, headers}`
        // (opencode.ai/config.json). Forward verbatim so an HTTP tool host
        // is reachable, mirroring the claude/kimi remote fix (cli-bridge#48).
        opencodeMcp[name] = {
          type: 'remote',
          url: spec.url,
          ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
          enabled: true,
        }
      }
      // unknown transport / missing required fields → drop
    }
  }
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp opencode] materialized: ${Object.keys(opencodeMcp).join(', ') || '(none)'}`)
  }
  const serverNames = Object.keys(opencodeMcp)

  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-opencode-')
  const configPath = join(root.path, 'opencode.json')
  // Interactive and unattended-deny paths remain explicit. The only path that
  // writes `allow` is an explicit named profile policy, which the chat route
  // has already converted into an interaction-policy receipt.
  const defaultPermission = interactionPolicy === 'unattended-allow'
    ? 'allow'
    : interactionPolicy === 'interactive'
      ? 'ask'
      : 'deny'
  const permission: Record<string, 'allow' | 'ask' | 'deny'> = {
    external_directory: defaultPermission,
    bash: defaultPermission,
    edit: defaultPermission,
    read: defaultPermission,
    write: defaultPermission,
    webfetch: defaultPermission,
    task: defaultPermission,
    plan_enter: defaultPermission,
    plan_exit: defaultPermission,
    question: defaultPermission,
  }
  // The profile may narrow the posture. It may not silently widen an
  // interactive request into unattended execution.
  if (callerPermissions && typeof callerPermissions === 'object') {
    for (const [key, value] of Object.entries(callerPermissions)) {
      if (value === 'allow' || value === 'ask' || value === 'deny') {
        if (interactionPolicy !== 'unattended-allow' && value === 'allow') continue
        permission[key] = value
      }
    }
  }
  try {
    writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission,
      mcp: opencodeMcp,
    }, null, 2), { mode: 0o600, flag: 'wx' })
    return { configPath, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

export function materializeEmptyMcpConfig(parent: string = tmpdir()): MaterializedMcpConfig {
  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-mcp-')
  try {
    const configPath = join(root.path, 'mcp-config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o600, flag: 'wx' })
    return { configPath, serverNames: [], cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

/**
 * Materialize a `McpServerSpec` map into a temp `CODEX_HOME` directory
 * containing a synthetic `config.toml`. Codex CLI accepts MCP servers
 * via the `[mcp_servers.<name>]` TOML stanza in `$CODEX_HOME/config.toml`
 * — there is no `--mcp-config` flag. We point codex at a temp HOME so
 * the passthrough is per-invocation and never mutates the user's real
 * `~/.codex/config.toml`.
 *
 * `authSourcePath` is the path to the user's persistent `auth.json`
 * (default `~/.codex/auth.json`). Codex looks up the session's bearer
 * token here. We copy it into the temp dir so the spawned codex still
 * authenticates as the operator. The copy is deleted at cleanup.
 *
 * stdio servers — written as `command = "..."` + optional `args`/`env`.
 * http servers (spec.type === 'http' with `url`) — written as
 * `url = "..."` + optional `headers`/`bearer_token_env_var`.
 *
 * Returns null when no usable servers remain.
 */
export interface MaterializedCodexHome {
  /** Directory to pass via `CODEX_HOME` env. */
  homePath: string
  /** Names actually written. */
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpServersForCodex(
  specs: Record<string, McpServerSpec> | null,
  authSourcePath?: string,
  parent: string = stableTmpRoot(),
): MaterializedCodexHome | null {
  if (!specs) return null

  const lines: string[] = []
  const serverNames: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      // Codex's TOML table key parser is strict; skip names that would
      // require quoting and could collide with other config keys.
      continue
    }
    const block: string[] = [`[mcp_servers.${name}]`]
    if (spec.type === 'http' || (spec.url && spec.type !== 'sse' && !spec.command)) {
      if (!spec.url) continue
      block.push(`url = ${tomlString(spec.url)}`)
      if (spec.headers && Object.keys(spec.headers).length) {
        block.push(`http_headers = ${tomlInlineTable(spec.headers)}`)
      }
      // codex tool-call timeout key — verified against `codex mcp get`
      // round-trip. Other names (`tool_timeout_ms`, `request_timeout_ms`)
      // are silently dropped by the parser.
      if (spec.timeout) block.push(`tool_timeout_sec = ${Math.max(1, Math.round(spec.timeout / 1000))}`)
    } else {
      if (!spec.command) continue
      block.push(`command = ${tomlString(spec.command)}`)
      if (spec.args && spec.args.length) {
        block.push(`args = ${tomlStringArray(spec.args)}`)
      }
      if (spec.env && Object.keys(spec.env).length) {
        block.push(`env = ${tomlInlineTable(spec.env)}`)
      }
      // codex stdio servers use `tool_timeout_sec` for per-call and
      // `startup_timeout_sec` for the launch handshake. We map a
      // single caller-provided `timeout` to BOTH so generous values
      // unblock long-running tools without separately requiring the
      // caller to fiddle with handshake timing.
      if (spec.timeout) {
        const secs = Math.max(1, Math.round(spec.timeout / 1000))
        block.push(`tool_timeout_sec = ${secs}`)
        block.push(`startup_timeout_sec = ${secs}`)
      }
    }
    lines.push(block.join('\n'))
    serverNames.push(name)
  }
  if (serverNames.length === 0) return null

  // Codex aborts if CODEX_HOME is under the system tmpdir on some
  // platforms — use the user's HOME/.cache as a stable parent.
  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-codex-')
  try {
    writeFileSync(join(root.path, 'config.toml'), lines.join('\n\n') + '\n', { mode: 0o600, flag: 'wx' })

    if (authSourcePath) {
      try {
        const auth = readFileMaybe(authSourcePath)
        if (auth !== null) writeFileSync(join(root.path, 'auth.json'), auth, { mode: 0o600, flag: 'wx' })
      } catch {
        // Codex will report missing auth through its normal upstream error.
      }
    }
    return { homePath: root.path, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

function stableTmpRoot(): string {
  // Prefer ~/.cache so codex's "not in /tmp" guard doesn't trip.
  // `tmpdir()` (typically /tmp) is the documented fallback. The
  // function is sync because the call sites are sync; HOME is always
  // set on supported platforms.
  const home = process.env.HOME
  if (home) {
    try {
      const cache = join(home, '.cache')
      mkdirSync(cache, { recursive: true, mode: 0o700 })
      const probe = mkdtempSync(join(cache, '.cli-bridge-write-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return cache
    } catch {
      // fallthrough
    }
  }
  return tmpdir()
}

function readFileMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function tomlString(s: string): string {
  // Use TOML's basic string with conservative escaping. Codex's TOML
  // parser handles `\"`, `\\`, `\n`, `\t` — escape the dangerous set
  // and trust UTF-8 for the rest.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function tomlStringArray(items: string[]): string {
  return `[${items.map(tomlString).join(', ')}]`
}

function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
    return `${key} = ${tomlString(v)}`
  })
  return `{ ${entries.join(', ')} }`
}

/**
 * Build the `--allowedTools` CSV that auto-allows every tool exposed by
 * the named MCP servers. Without this, claude's permission system will
 * prompt on first use of each MCP tool, which hangs in non-interactive
 * mode (`-p` print mode). Caller decides whether to actually pass the
 * resulting flag — hosted-safe mode usually wants to keep MCP tools
 * gated rather than auto-allow them.
 *
 * Format follows claude's tool spec: `mcp__<server>` allows ALL tools
 * exposed by that server. Per-tool grants would be `mcp__<server>__<tool>`.
 */
export function buildMcpAllowList(serverNames: string[]): string {
  return serverNames.map((n) => `mcp__${n}`).join(',')
}

export function resolvePromptMessages(req: ChatRequest, session: SessionRecord | null): ChatMessage[] {
  const preamble = renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session))
  if (!preamble) return req.messages
  return [{ role: 'system', content: preamble }, ...req.messages]
}

export function renderLocalHarnessProfilePreamble(profile: AgentProfile | null): string | null {
  if (!profile || typeof profile !== 'object') return null
  const sections: string[] = []

  const systemPrompt = pickString(
    (profile as Record<string, unknown>).systemPrompt,
    ((profile as Record<string, unknown>).prompt as Record<string, unknown> | undefined)?.systemPrompt,
  )
  if (systemPrompt) sections.push(systemPrompt)

  const skills = pickStringArray((profile as Record<string, unknown>).skills)
  if (skills.length) {
    sections.push(`Caller-declared skills for this session: ${skills.join(', ')}`)
  }

  const mcpServers = pickNamedEntries((profile as Record<string, unknown>).mcpServers)
  if (mcpServers.length) {
    sections.push(`Caller-declared MCP servers for this session: ${mcpServers.join(', ')}`)
  }

  const resources = pickNamedEntries((profile as Record<string, unknown>).resources)
  if (resources.length) {
    sections.push(`Caller-declared resources for this session: ${resources.join(', ')}`)
  }

  const permissionSummary = renderPermissions((profile as Record<string, unknown>).permissions)
  if (permissionSummary) {
    sections.push(`Requested permission posture: ${permissionSummary}`)
  }

  return sections.length ? sections.join('\n\n') : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function pickNamedEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item]
      if (item && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim()) return [name]
      }
      return []
    })
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).filter(Boolean)
  }
  return []
}

function renderPermissions(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}=${v}`)
  return entries.length ? entries.join(', ') : null
}
