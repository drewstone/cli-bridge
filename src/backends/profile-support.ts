import { workspaceProfile } from '../hub-mcp.js'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, posix, resolve } from 'node:path'
import type {
  AgentProfile,
  AgentProfileModelHints,
  ContextTransferRequest,
  ReasoningEffort,
} from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  snapshotAgentProfile,
} from '@tangle-network/agent-interface'
import type { ChatRequest, ProfileMaterializationReceipt, NativeSubscriptionInvocation } from './types.js'
import { BackendError } from './types.js'
import type { SessionProfileBinding, SessionRecord } from '../sessions/store.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import {
  applyWorkspacePlan,
  assertWorkspacePlanSupported,
  codexDeveloperInstructionArgs,
  hashWorkspacePlan,
  type HarnessId,
  materializeProfile,
  modelIdsMatch,
  type PlanFile,
  qualifyModelId,
  unqualifyModelId,
  type WorkspacePlan,
  type WorkspacePlanArgument,
  type WorkspacePlanConfigValue,
  type WorkspacePlanReceipt,
} from '@tangle-network/agent-profile-materialize'
import { exceedsHostEnvValueLimit, MAX_ENV_VALUE_BYTES, sanitizeHostEnv } from '../executors/host.js'

export interface ProfileExecutionIdentity {
  provider: string | null
  model: string
  reasoningEffort: {
    requested: ReasoningEffort | null
    applied: string | null
  }
}

/** Materialization requires a host directory visible at the same path inside the executor. */
export function requireMaterializationCwd(cwd: string | undefined, what: string): string {
  if (cwd !== undefined) return cwd
  throw new ExecutorConfigurationError(
    `${what} needs a host directory mounted into the container, and this executor mounts none. Set the backend's ` +
      `<NAME>_DOCKER_WORKSPACE_ROOT to an absolute host directory — the pool bind-mounts it into every container at ` +
      `the identical path — or send the request without an agent_profile/mcp block.`,
  )
}

/** A public-only plan must not render a secret reference into argv, files, or the child environment. */
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

/** Enforce subscription policy on final native inputs, then seal the values passed to the existing spawner. */
export async function admitNativeSubscription(req: ChatRequest, invocation: NativeSubscriptionInvocation): Promise<void> {
  if (!req.subscriptionAdmission) return
  await req.subscriptionAdmission.check({ ...invocation, env: sanitizeHostEnv(invocation.env, invocation.cwd, invocation.envPassthroughKeys) ?? invocation.env })
  Object.freeze(invocation.env)
  if (invocation.args) Object.freeze(invocation.args)
}

/** Apply cwd-native resources and return env/flags; existing backend MCP controls remain authoritative. */
export function provisionProfileWorkspace(
  req: ChatRequest,
  session: SessionRecord | null,
  harness: HarnessId,
  cwd: string | undefined,
  executionIdentity: ProfileExecutionIdentity = profileExecutionIdentity(req, session, harness, null),
): {
  env: Record<string, string>
  flags: string[]
  written: string[]
  unsupported?: unknown[]
  workspacePlanDigest?: string
  receipt?: ProfileMaterializationReceipt
  /**
   * Prompt intents the plan carries as launch arguments rather than files.
   *
   * Returned separately from `flags` because only the caller knows its
   * harness's flag names, and because the two must never be swapped: binding
   * `systemPrompt` to an additive flag leaves the harness's own prompt running.
   */
  systemPrompt?: string
  appendSystemPrompt?: string
  /**
   * Release the request-scoped files this provisioning wrote outside the plan.
   *
   * Only the opencode path returns one today. The caller MUST invoke it after
   * the harness process exits — the profile's instruction bytes stay readable
   * in the shared task directory until it runs.
   */
  cleanup?: () => void
} {
  delete req.profile_materialization_receipt
  const profile = resolveAgentProfile(req, session)
  if (!profile) return { env: {}, flags: [], written: [] }
  const workspaceCwd = requireMaterializationCwd(cwd, `${harness} AgentProfile materialization`)
  let scoped: OpencodeProfileScope | undefined
  try {
    const plan = materializeProfile(workspaceProfile(req, profile), harness, { skip: ['mcp'], binds: harness === 'codex' ? ['codex.developer-instructions'] : [] })
    // Bind generated --settings to this exact profile. A resumed session retains its already-applied plan.
    if (harness === 'claude-code' && sessionAppliedPlanDigest(session, workspaceCwd).appliedPlanDigest !== hashWorkspacePlan(plan)) {
      const settingsPath = '.tangle/claude-settings.json'
      const settings = plan.files.find((file) => file.relPath === settingsPath && file.source === 'generated')
      if (settings) {
        const scopedPath = `.tangle/claude-settings/${canonicalAgentProfileDigest(profile).slice('sha256:'.length)}.json`
        settings.relPath = scopedPath
        plan.flags = plan.flags.map((flag, index) =>
          index > 0 && plan.flags[index - 1] === '--settings' && flag === settingsPath ? scopedPath : flag,
        )
      }
    }
    assertWorkspacePlanSupported(plan)
    // Freeze the complete identity before moving native resources; receipts and resumes use this digest.
    const planDigest = hashWorkspacePlan(plan)
    const resumesSamePlan = sessionAppliedPlanDigest(session, workspaceCwd).appliedPlanDigest === planDigest
    if (harness === 'opencode') {
      scoped = scopeOpencodeProfileConfig(plan, workspaceCwd)
      plan.files = scoped.workspaceFiles
    }
    const applied = applyWorkspacePlan(
      plan,
      workspaceCwd,
      resumesSamePlan ? { appliedPlanDigest: hashWorkspacePlan(plan) } : {},
    )
    // The opencode-native files leave this plan, so the receipt names them here.
    const written = scoped ? [...applied.written, ...scoped.written] : applied.written
    const receipt = retainProfileMaterializationReceipt(
      req,
      profile,
      harness,
      executionIdentity,
      plan,
      { ...applied, written, workspacePlanDigest: planDigest },
    )
    const flags = applied.flags.map((flag, index) => requirePublicPlanValue(flag, `launch flag ${index}`, harness))
    if (harness === 'codex') flags.push(...codexDeveloperInstructionArgs(applied.appendSystemPrompt, flags))
    return {
      ...applied,
      env: { ...requirePublicPlanEnv(applied.env, harness), ...(scoped?.env ?? {}) },
      flags,
      written,
      workspacePlanDigest: planDigest,
      receipt,
      ...(scoped ? { cleanup: scoped.cleanup } : {}),
    }
  } catch (error) {
    scoped?.cleanup()
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`AgentProfile workspace materialization failed: ${message}`, 'parse_error', error)
  }
}

/** The environment variable opencode merges as its final local config layer. */
const OPENCODE_PROFILE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

/** Disable cwd opencode config/context, agents, skills, commands and tools while preserving global config.
 * Qualified through opencode debug config/agent; external skill directories have a separate control.
 */
const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = 'OPENCODE_DISABLE_PROJECT_CONFIG'

/** Add an isolated profile config/resource directory beside the operator's global directory. */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_CONFIG_DIR'

/** The cwd-relative directory the shared materializer writes opencode-native files into. */
const OPENCODE_NATIVE_DIR = '.opencode'

/** The project config file opencode reads from its cwd. */
const OPENCODE_PROJECT_CONFIG_FILE = 'opencode.json'

/** Prefix of the private per-turn directory this bridge materializes a profile into. */
const OPENCODE_PROFILE_ROOT_PREFIX = '.cli-bridge-opencode-profile-'
/** The private directory's name in a materialization receipt, the same on every turn. */
const OPENCODE_PROFILE_RECEIPT_ROOT = '.cli-bridge-opencode-profile'

interface OpencodeProfileScope {
  /** Env this turn adds on top of the plan's own launch env. */
  env: Record<string, string>
  /** Workspace-relative paths written under the private root, for the receipt. */
  written: string[]
  /** The plan files that still belong in the shared task directory. */
  workspaceFiles: PlanFile[]
  /** Idempotent; removes the private root. Run it after the process exits. */
  cleanup(): void
}

/** Isolate each profile from the shared task directory.
 * Config travels in OPENCODE_CONFIG_CONTENT; OPENCODE_CONFIG remains the MCP credential channel.
 * Disable the whole project layer, including AGENTS.md/CLAUDE.md/CONTEXT.md. Apply profile resources
 * into a fresh OPENCODE_CONFIG_DIR per turn, with absolute instruction paths, and remove it on close.
 * The materialization plan retains relative paths for stable digests. No workspace files are deleted.
 * External .claude/.agents skill directories require OPENCODE_DISABLE_EXTERNAL_SKILLS separately.
 * Same-user co-residents can still write a running process's private directory.
 */
function scopeOpencodeProfileConfig(
  plan: WorkspacePlan,
  workspaceCwd: string,
): OpencodeProfileScope {
  const isWorkspaceFile = (file: PlanFile): boolean => (file.root ?? 'workspace') === 'workspace'
  const generated = plan.files.filter((file) =>
    file.relPath === OPENCODE_PROJECT_CONFIG_FILE && file.source === 'generated' && isWorkspaceFile(file))
  const [configFile, ...extra] = generated
  if (extra.length > 0) throw new Error('opencode materializer emitted more than one opencode.json')
  if (configFile?.secretSlots?.length) {
    throw new Error('opencode materializer emitted a generated opencode.json that requires a secret provider')
  }
  for (const name of [OPENCODE_PROFILE_CONFIG_ENV, OPENCODE_CONFIG_DIR_ENV, OPENCODE_DISABLE_PROJECT_CONFIG_ENV]) {
    if (plan.env[name] !== undefined) throw new Error(`opencode materializer already set ${name}`)
  }

  const nativeFiles = plan.files.filter((file) =>
    file !== configFile && isWorkspaceFile(file) && file.relPath.startsWith(`${OPENCODE_NATIVE_DIR}/`))
  const nativePaths = new Set(nativeFiles)
  const workspaceFiles = plan.files.filter((file) => file !== configFile && !nativePaths.has(file))

  // Empty profiles still require isolated config; returning early would expose the shared project layer.
  const config = (configFile === undefined ? {} : JSON.parse(configFile.content)) as Record<string, unknown>
  const instructions = config.instructions
  if (instructions !== undefined) {
    if (!Array.isArray(instructions) || !instructions.every((entry) => typeof entry === 'string')) {
      throw new Error('opencode materializer emitted non-string instructions')
    }
    for (const entry of instructions as string[]) {
      if (nativeFiles.some((file) => file.relPath === entry)) continue
      // An unrelocated entry would resolve against the config directory and
      // silently name nothing, leaving the profiled agent with no instructions.
      throw new Error(
        `opencode materializer named instruction file ${JSON.stringify(entry)}, which is not one of the ` +
          `${OPENCODE_NATIVE_DIR}/ files this plan generates, so the bridge cannot bind it to this process`,
      )
    }
  }

  let profileRoot: string | null = null
  try {
    // Under the cwd so a Docker executor sees the identical absolute path: its
    // pool bind-mounts the workspace root and nothing else. Traversable and
    // world-readable because the container may run opencode under a different
    // uid, and a mode it cannot read would drop the profile's instructions with
    // nothing reported.
    profileRoot = mkdtempSync(join(workspaceCwd, OPENCODE_PROFILE_ROOT_PREFIX))
    chmodSync(profileRoot, 0o755)
    const applied = applyWorkspacePlan(
      { harness: plan.harness, files: nativeFiles, env: {}, flags: [], unsupported: [] },
      profileRoot,
      { existingFiles: 'reject' },
    )
    const configDir = join(profileRoot, OPENCODE_NATIVE_DIR)
    // A profile with no native files still needs the directory to exist, so the
    // config directory opencode reads is this empty private one and never a
    // populated ambient default.
    mkdirSync(configDir, { recursive: true, mode: 0o755 })
    chmodSync(configDir, 0o755)

    const spawnConfig = instructions === undefined
      ? config
      : { ...config, instructions: (instructions as string[]).map((entry) => join(profileRoot!, entry)) }
    const root = profileRoot
    let cleaned = false
    return {
      env: {
        [OPENCODE_PROFILE_CONFIG_ENV]: opencodeProcessConfigValue(spawnConfig),
        [OPENCODE_DISABLE_PROJECT_CONFIG_ENV]: '1',
        [OPENCODE_CONFIG_DIR_ENV]: configDir,
      },
      // The receipt names what was applied, under one stable name: the private directory is fresh
      // on every turn, and a resumed session's receipt must equal its first turn's, or Runtime
      // refuses the turn ("profile materialization changed across session turns").
      written: applied.written.map((relPath) => posix.join(OPENCODE_PROFILE_RECEIPT_ROOT, relPath)),
      workspaceFiles,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
    throw error
  }
}

/** Merge profile config over the operator's OPENCODE_CONFIG_CONTENT without losing unrelated provider keys.
 * Reject values the host sanitizer would discard; an oversize config must never silently remove grants.
 */
function opencodeProcessConfigValue(config: Record<string, unknown>): string {
  const ambient = process.env[OPENCODE_PROFILE_CONFIG_ENV]
  let merged = config
  if (ambient !== undefined && ambient.length > 0) {
    let base: unknown
    try {
      base = JSON.parse(ambient)
    } catch {
      throw new Error(
        `the ${OPENCODE_PROFILE_CONFIG_ENV} already present in this process is not valid JSON, so the profile's ` +
          'config cannot be merged under it; correct or unset it before running an opencode AgentProfile',
      )
    }
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      throw new Error(
        `the ${OPENCODE_PROFILE_CONFIG_ENV} already present in this process is not a JSON object`,
      )
    }
    merged = { ...(base as Record<string, unknown>), ...config }
  }
  const value = JSON.stringify(merged)
  if (exceedsHostEnvValueLimit(value)) {
    throw new Error(
      `the opencode config for this turn is ${value.length} characters and this bridge carries at most ` +
        `${MAX_ENV_VALUE_BYTES} in one environment value, so it would not reach the process on the host executor; ` +
        'reduce agent_profile.permissions, tools or mcp, or split the profile',
    )
  }
  return value
}

export interface ProvisionedPiProfile {
  env: Record<string, string>
  flags: string[]
  written: string[]
  workspacePlanDigest: string
  receipt: ProfileMaterializationReceipt
  cleanup(): void
}

/** Apply Pi's exact profile through private per-process loaders under the workspace.
 * Disable ambient context/skills/templates; reject generic files whose declared workspace paths would change.
 * The caller validates and mounts MCP/extensions.pi separately. Host and Docker use identical paths.
 */
export function provisionPiProfile(
  req: ChatRequest,
  session: SessionRecord | null,
  cwd: string | undefined,
  executionIdentity: ProfileExecutionIdentity = profileExecutionIdentity(req, session, 'pi', null),
  inference?: NonNullable<ProfileMaterializationReceipt['inference']>,
): ProvisionedPiProfile | null {
  delete req.profile_materialization_receipt
  const profile = resolveAgentProfile(req, session)
  if (!profile) return null
  const workspaceCwd = requireMaterializationCwd(cwd, 'pi AgentProfile materialization')

  let profileRoot: string | null = null
  try {
    const genericFiles = profile.resources?.files?.map((file) => file.path) ?? []
    if (genericFiles.length > 0) {
      throw new Error(
        `no request-scoped Pi loader exists for generic workspace file(s): ${genericFiles.join(', ')}`,
      )
    }
    const plan = materializeProfile(workspaceProfile(req, profile), 'pi', { skip: ['mcp', 'extensions'] })
    assertWorkspacePlanSupported(plan)
    const nativeLoaders = assertPiPlanHasNativeLoaders(plan)

    profileRoot = mkdtempSync(join(workspaceCwd, '.cli-bridge-pi-profile-'))
    // Docker executors may run Pi under a uid different from the bridge. The
    // workspace bind is already the trust boundary; keep the directory
    // traversable and the files read-only to non-owners.
    chmodSync(profileRoot, 0o755)
    const applied = applyWorkspacePlan(plan, profileRoot, { existingFiles: 'reject' })
    const flags = piProfileFlags(plan, applied, profileRoot, nativeLoaders)
    const receipt = retainProfileMaterializationReceipt(
      req,
      profile,
      'pi',
      executionIdentity,
      plan,
      applied,
      inference,
    )

    let cleaned = false
    return {
      env: requirePublicPlanEnv(applied.env, 'pi'),
      flags,
      written: applied.written,
      workspacePlanDigest: applied.workspacePlanDigest,
      receipt,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        rmSync(profileRoot!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
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
  // Exact profiles load request-scoped resources from unique paths under the
  // workspace. Grant project-file trust for this process so Pi neither prompts
  // nor persists approval into its read-only global settings. Ambient context,
  // skills, and prompt templates remain disabled by the flags below; callers
  // control ambient extensions separately through extensions.pi.load.
  const flags = ['--approve', '--no-context-files', '--no-skills', '--no-prompt-templates']

  // Both intents go through files rather than argv text: Pi accepts a path for
  // either flag (verified — it inlines the file's bytes and the literal path
  // never reaches the request), and a path has no MAX_ARG_STRLEN ceiling, so a
  // large prompt cannot turn into a spawn failure.
  //
  // `--system-prompt` REPLACES Pi's own prompt and `--append-system-prompt`
  // ADDS to it; they are separate files under separate names so a reader of the
  // spawn can tell which intent produced which bytes.
  const writePromptFile = (name: string, content: string): string => {
    const promptDir = join(profileRoot, '.cli-bridge')
    const promptPath = join(promptDir, name)
    mkdirSync(promptDir, { recursive: true })
    writeFileSync(promptPath, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    return promptPath
  }

  if (plan.systemPrompt !== undefined) {
    flags.push('--system-prompt', writePromptFile('system-prompt.md', plan.systemPrompt))
  }

  // Emitted BEFORE the context-file loaders below, which reuse this same flag
  // for AGENTS.md. Pi composes repeated `--append-system-prompt` values in
  // argv order, so the profile's explicit addition leads and the lower-privilege
  // project instructions follow it — a fixed order rather than whichever the
  // plan's file list happened to produce.
  if (plan.appendSystemPrompt !== undefined) {
    flags.push(
      '--append-system-prompt',
      writePromptFile('append-system-prompt.md', plan.appendSystemPrompt),
    )
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
  profile: AgentProfile,
  harness: HarnessId,
  executionIdentity: ProfileExecutionIdentity,
  plan: WorkspacePlan,
  applied: WorkspacePlanReceipt,
  inference?: NonNullable<ProfileMaterializationReceipt['inference']>,
): ProfileMaterializationReceipt {
  const modes = new Map(plan.files.map((file) => [file.relPath, file.mode ?? 0o644]))
  const receipt: ProfileMaterializationReceipt = {
    schema: 'cli-bridge.profile-materialization.v2',
    effectiveProfileDigest: canonicalAgentProfileDigest(profile),
    harness,
    provider: executionIdentity.provider,
    model: executionIdentity.model,
    reasoningEffort: executionIdentity.reasoningEffort,
    workspacePlanDigest: applied.workspacePlanDigest,
    files: applied.written.map((path) => ({ path, mode: modes.get(path) ?? 0o644 })),
    unsupported: applied.unsupported,
    ...(inference ? { inference } : {}),
  }
  req.profile_materialization_receipt = receipt
  return receipt
}

/** Reuse a session's proved plan digest only when applying into its recorded cwd.
 * Live session memory is not a materialization digest; a different cwd always receives the full plan.
 */
function sessionAppliedPlanDigest(
  session: SessionRecord | null,
  workspaceCwd: string,
): { appliedPlanDigest?: string } {
  if (!session || session.cwd !== workspaceCwd) return {}
  const receipt = session.metadata?.profile_materialization
  if (!receipt || typeof receipt !== 'object') return {}
  const digest = (receipt as { workspacePlanDigest?: unknown }).workspacePlanDigest
  return typeof digest === 'string' && digest.length > 0 ? { appliedPlanDigest: digest } : {}
}

const profileSnapshots = new WeakMap<ChatRequest, AgentProfile | null>()

export function resolveAgentProfile(req: ChatRequest, session: SessionRecord | null): AgentProfile | null {
  if (profileSnapshots.has(req)) return profileSnapshots.get(req) ?? null
  const raw = req.agent_profile && typeof req.agent_profile === 'object'
    ? req.agent_profile
    : session?.metadata?.agent_profile
  let profile: AgentProfile | null = null
  if (raw && typeof raw === 'object') {
    try {
      profile = snapshotAgentProfile(raw)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new BackendError(`invalid agent_profile: ${message}`, 'parse_error', error)
    }
  }
  profileSnapshots.set(req, profile)
  if (profile) {
    req.agent_profile = profile
  }
  return profile
}

/** Reject any second behavioral authority beside an exact AgentProfile. */
export function assertProfileRequestAuthority(
  req: ChatRequest,
  session: SessionRecord | null,
): AgentProfile | null {
  const profile = resolveAgentProfile(req, session)
  if (!profile) return null
  if (Object.keys(req.mcp?.mcpServers ?? {}).length > 0) {
    throw new BackendError(
      'request mcp cannot accompany agent_profile; declare the exact MCP servers in agent_profile.mcp',
      'parse_error',
    )
  }
  if (req.messages.some((message) => message.role === 'system')) {
    throw new BackendError(
      'system-role messages cannot accompany agent_profile; declare standing instructions in agent_profile.prompt',
      'parse_error',
    )
  }
  resolveRequestedReasoningEffort(req, session)
  return profile
}

/** Pi can lower its total completion cap; independent visible/reasoning ceilings are unsupported. */
export function assertPiOutputTokenRequest(
  req: ChatRequest,
  profile: AgentProfile | null,
): void {
  const model = profile?.model
  assertPiModelMetadataCompatibility(model)
  if (model?.maxVisibleOutputTokens !== undefined) {
    throw new BackendError(
      'backend pi cannot enforce agent_profile.model.maxVisibleOutputTokens; Pi exposes only a total completion cap',
      'not_configured',
    )
  }
  if (model?.maxReasoningTokens !== undefined) {
    throw new BackendError(
      'backend pi cannot enforce agent_profile.model.maxReasoningTokens; reasoningEffort is not a numeric token cap',
      'not_configured',
    )
  }
  const requested = req.max_tokens
  if (requested === undefined) return
  if (!profile) {
    throw new BackendError(
      'backend pi cannot apply request max_tokens without an AgentProfile.model.maxTotalOutputTokens authority',
      'not_configured',
    )
  }

  const profileMaxTokens = profile.model?.maxTotalOutputTokens
  if (profileMaxTokens === undefined) {
    throw new BackendError(
      'backend pi cannot apply request max_tokens because agent_profile.model.maxTotalOutputTokens is absent',
      'not_configured',
    )
  }
  if (requested !== profileMaxTokens) {
    throw new BackendError(
      `request max_tokens ${String(requested)} conflicts with agent_profile.model.maxTotalOutputTokens ${String(profileMaxTokens)}`,
      'parse_error',
    )
  }
}

/** Legacy maxTokens is redundant only: require the same canonical total cap and no other metadata key. */
export function assertPiModelMetadataCompatibility(
  model: AgentProfileModelHints | undefined,
): void {
  const metadata = model?.metadata
  if (metadata === undefined) return
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model.metadata because it is not an object',
      'parse_error',
    )
  }
  const keys = Reflect.ownKeys(metadata)
  if (keys.length !== 1 || keys[0] !== 'maxTokens') {
    throw new BackendError(
      `backend pi cannot enforce agent_profile.model metadata field(s): ${keys.map(String).sort().join(', ') || '<empty>'}`,
      'not_configured',
    )
  }
  const legacy = metadata.maxTokens
  const canonical = model?.maxTotalOutputTokens
  if (!Number.isSafeInteger(legacy) || Number(legacy) <= 0) {
    throw new BackendError(
      'backend pi agent_profile.model.metadata.maxTokens must be a positive safe integer',
      'parse_error',
    )
  }
  if (canonical === undefined) {
    throw new BackendError(
      'backend pi does not accept agent_profile.model.metadata.maxTokens without maxTotalOutputTokens',
      'not_configured',
    )
  }
  if (legacy !== canonical) {
    throw new BackendError(
      `agent_profile.model.metadata.maxTokens ${String(legacy)} conflicts with maxTotalOutputTokens ${String(canonical)}`,
      'parse_error',
    )
  }
}

/** Resolve one canonical reasoning request; an out-of-profile override is a hard conflict. */
export function resolveRequestedReasoningEffort(
  req: ChatRequest,
  session: SessionRecord | null,
): ReasoningEffort | null {
  const profileEffort = resolveAgentProfile(req, session)?.model?.reasoningEffort
  if (profileEffort && req.effort && profileEffort !== req.effort) {
    throw new BackendError(
      `request effort ${JSON.stringify(req.effort)} conflicts with agent_profile.model.reasoningEffort ${JSON.stringify(profileEffort)}`,
      'parse_error',
    )
  }
  return profileEffort ?? req.effort ?? null
}

/**
 * The Bridge route the first turn of an accepted transfer names.
 *
 * `agent-provider-cli-bridge` attaches the accepted environment with the
 * destination model, else the profile default, qualified by the profile
 * provider when the model names none. Native import, the session binding, and
 * the first-turn check use this same route so the attached turn is admitted.
 */
export function contextTransferRoute(request: ContextTransferRequest): string {
  const { runner } = request.plan.destination
  const model = request.plan.destination.model ?? request.profile?.model?.default
  const provider = request.profile?.model?.provider
  if (!model || model === runner) return runner
  if (model.startsWith(`${runner}/`)) return model
  if (model.includes('/')) return `${runner}/${model}`
  return provider ? `${runner}/${provider}/${model}` : `${runner}/${model}`
}

/** One profile binding shared by native import and the first resumed turn. */
export function exactSessionProfileBinding(
  req: ChatRequest,
  session: SessionRecord | null,
): SessionProfileBinding | null {
  const profile = resolveAgentProfile(req, session)
  if (!profile) return null
  const parts = req.model.split('/')
  const provider = parts.length >= 3 && parts[1]
    ? parts[1]
    : profile.model?.provider ?? null
  return {
    schema: 'cli-bridge.session-agent-profile.v1',
    effectiveProfileDigest: canonicalAgentProfileDigest(profile),
    provider,
    model: req.model,
    requestedReasoningEffort: resolveRequestedReasoningEffort(req, session),
  }
}

/** Bind a receipt to the actual transport model/provider and native reasoning control. */
export function profileExecutionIdentity(
  req: ChatRequest,
  session: SessionRecord | null,
  harness: HarnessId,
  appliedReasoningEffort: string | null,
): ProfileExecutionIdentity {
  const profile = assertProfileRequestAuthority(req, session)
  if (profile) assertExactProfileRequest(req, profile, harness)
  const wireModel = modelWithinHarness(req.model, harness)
  const slash = wireModel.indexOf('/')
  const wireProvider = slash > 0 ? wireModel.slice(0, slash) : undefined
  return {
    provider: wireProvider ?? profile?.model?.provider ?? null,
    model: req.model,
    reasoningEffort: {
      requested: resolveRequestedReasoningEffort(req, session),
      applied: appliedReasoningEffort,
    },
  }
}

/**
 * A materialization receipt can acknowledge one AgentProfile only when no
 * second behavioral channel changes it. Limits and execution mode may still
 * constrain the run; model, prompt, MCP, and reasoning must agree with the
 * profile before any harness process starts.
 *
 * Model agreement is decided by `modelIdsMatch`, the one canonicalization of a
 * model id (`@tangle-network/agent-profile-materialize`). Both sides are first
 * made harness-relative, because the harness prefix is the one qualification
 * that package does not own: the request carries it and the profile does not.
 * A second independent copy of the qualification rule is what issue #212 was —
 * a stripped request compared against an unstripped profile id refused an
 * exactly matching pair and printed two identical-looking strings as the
 * conflict (`request model "kimi-code/kimi-for-coding" conflicts with
 * agent_profile.model "kimi-code/kimi-for-coding"`).
 *
 * Cross-run against agent-runtime's own `profileBridgeWireModel` over 14 profile
 * shapes, this accepts 13 of the ids it composes. Both exceptions are profiles
 * whose model is absent, and `assertExecutableAgentProfile` refuses those before
 * execution: a harness-native `model.default` (the sentinel resolves to no model
 * and the composer sends the bare harness id, which selects no model here), and
 * a profile that declares only `model.provider`. In the second case the composer
 * has nothing to qualify, so the provider never reaches the wire and this check
 * cannot confirm the run will honour it — unless the provider IS the harness,
 * which the wire id's prefix does state.
 */
export function assertExactProfileRequest(
  req: ChatRequest,
  profile: AgentProfile,
  harness: HarnessId,
): void {
  if (profile.harness !== undefined && profile.harness !== harness) {
    throw new BackendError(
      `agent_profile.harness ${JSON.stringify(profile.harness)} conflicts with selected harness ${JSON.stringify(harness)}`,
      'parse_error',
    )
  }

  const wireModel = modelWithinHarness(req.model, harness)
  const requestedModel = profile.model?.default
  const requestedProvider = profile.model?.provider
  if (requestedModel !== undefined) {
    // The profile's id made harness-relative, so both operands are at the same level before
    // `modelIdsMatch` qualifies them by the declared provider. A profile that spells its own
    // harness into `model.default` composes the same wire id, which is why one prefix comes off.
    const declaredModel = unqualifyModelId(harness, requestedModel)
    if (!modelIdsMatch(wireModel, declaredModel, requestedProvider)) {
      throw new BackendError(
        `request model ${JSON.stringify(req.model)} selects ${JSON.stringify(wireModel)} within harness `
        + `${JSON.stringify(harness)}, which conflicts with agent_profile.model `
        + `${JSON.stringify(qualifyModelId(requestedProvider, declaredModel))}`,
        'parse_error',
      )
    }
  } else if (requestedProvider !== undefined) {
    const slash = wireModel.indexOf('/')
    const wireProvider = slash > 0 ? wireModel.slice(0, slash) : null
    // A provider equal to the harness is spent as the wire id's single harness prefix, so the
    // remainder usually carries no provider segment of its own. A caller that states it twice
    // anyway still names the same provider, and the harness name is kept out of the CLI's own
    // provider argument by the backend that builds the argv (#161), not by this comparison —
    // which never sees an unprofiled request and so could never enforce it for every route.
    const selected = wireProvider === requestedProvider
      || (requestedProvider === harness && wireProvider === null)
    if (!selected) {
      throw new BackendError(
        `request model ${JSON.stringify(req.model)} selects provider ${JSON.stringify(wireProvider)} within harness `
        + `${JSON.stringify(harness)}, not agent_profile.model.provider ${JSON.stringify(requestedProvider)}`,
        'parse_error',
      )
    }
  }

}

function modelWithinHarness(model: string, harness: HarnessId): string {
  for (const prefix of harnessModelPrefixes(harness)) {
    if (model === prefix) return ''
    if (model.startsWith(`${prefix}/`)) return model.slice(prefix.length + 1)
  }
  throw new BackendError(
    `request model ${JSON.stringify(model)} does not select harness ${JSON.stringify(harness)}`,
    'parse_error',
  )
}

/**
 * Every prefix that selects this harness on the wire.
 *
 * A backend's registered name and the `HarnessId` it passes to this file are
 * independent: `ClaudeBackend` claims `<its own name>/` and states `claude-code`
 * here, so a deployment that registers it under its default `claude` name routes
 * `claude/opus` into a `claude-code` check. Dropping the alias makes that
 * configuration refuse every request (measured: it fails
 * tests/docker-executor.test.ts with `request model "claude/opus" does not
 * select harness "claude-code"`).
 */
function harnessModelPrefixes(harness: HarnessId): readonly string[] {
  return harness === 'claude-code'
    ? ['claude-code', 'claude']
    : harness === 'kimi-code'
      ? ['kimi-code', 'kimi']
      : [harness]
}

/**
 * Normalize the one authoritative MCP source. A request without an
 * AgentProfile may use body/header `mcp.mcpServers`; an exact profile must put
 * every server in `agent_profile.mcp`, and a second channel is refused.
 *
 * Returns `null` when neither source supplies any entries. Callers
 * that need a non-null result (e.g. opencode, which always writes a
 * config file) should default to `{}` after this returns null.
 *
 * The returned spec is the canonical `McpServerSpec` shape; backends
 * pick the fields they support and ignore the rest.
 */
