import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import type {
  AgentProfile,
  AgentProfileConfigValue,
  AgentProfileMcpServer,
  AgentProfileModelHints,
  ReasoningEffort,
} from '@tangle-network/agent-interface'
import {
  canonicalAgentProfileDigest,
  snapshotAgentProfile,
} from '@tangle-network/agent-interface'
import type { ChatMessage, ChatRequest, McpServerSpec, ProfileMaterializationReceipt } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import {
  applyWorkspacePlan,
  assertWorkspacePlanSupported,
  hashWorkspacePlan,
  type HarnessId,
  materializeProfile,
  type PlanFile,
  type WorkspacePlan,
  type WorkspacePlanArgument,
  type WorkspacePlanConfigValue,
  type WorkspacePlanReceipt,
} from '@tangle-network/agent-profile-materialize'
import { exceedsHostEnvValueLimit, MAX_ENV_VALUE_BYTES } from '../executors/host.js'

export interface ProfileExecutionIdentity {
  provider: string | null
  model: string
  reasoningEffort: {
    requested: ReasoningEffort | null
    applied: string | null
  }
}

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
    const plan = materializeProfile(profile, harness, { skip: ['mcp'] })
    // Claude loads this generated file through --settings, so its path need not
    // occupy the shared task workspace's one conventional settings name.
    // Bind it to the exact profile; resumed sessions retain the same plan path.
    // A persisted session keeps its already-applied plan so an upgrade cannot
    // change the materialization identity halfway through a conversation.
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
    // The materialization identity of the WHOLE plan, fixed before opencode
    // moves its harness-native half out of the shared directory. It is what the
    // receipt reports and what a resumed session compares against, so where the
    // bridge puts the bytes cannot change the identity of what it applied.
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
    return {
      env: { ...requirePublicPlanEnv(applied.env, harness), ...(scoped?.env ?? {}) },
      flags: applied.flags.map((flag, index) =>
        requirePublicPlanValue(flag, `launch flag ${index}`, harness),
      ),
      written,
      unsupported: applied.unsupported,
      workspacePlanDigest: planDigest,
      receipt,
      ...(applied.systemPrompt === undefined ? {} : { systemPrompt: applied.systemPrompt }),
      ...(applied.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: applied.appendSystemPrompt }),
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

/**
 * Stops opencode from reading the project layer of the directory it runs in:
 * `<cwd>/opencode.json`, `<cwd>/.opencode/opencode.json`, every agent, skill,
 * command and custom tool under `<cwd>/.opencode`, and the project context
 * files `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md`.
 *
 * Measured against opencode 1.18.30 with `opencode debug config` and
 * `opencode debug agent`: with this set, a planted `<cwd>/opencode.json` no
 * longer contributes `instructions` or `agent.<name>.prompt`, a planted
 * `<cwd>/.opencode/agents/<name>.md` no longer defines that subagent, and a
 * planted `<cwd>/.opencode/tools/<name>.js` no longer appears in the tool list.
 * The operator's own global config still loads, so provider, model and plugin
 * wiring is untouched.
 */
const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = 'OPENCODE_DISABLE_PROJECT_CONFIG'

/**
 * One more directory opencode reads config, agents, skills, commands and tools
 * from. Additive, measured the same way: the operator's global directory keeps
 * loading beside it.
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_CONFIG_DIR'

/** The cwd-relative directory the shared materializer writes opencode-native files into. */
const OPENCODE_NATIVE_DIR = '.opencode'

/** The project config file opencode reads from its cwd. */
const OPENCODE_PROJECT_CONFIG_FILE = 'opencode.json'

/** Prefix of the private per-turn directory this bridge materializes a profile into. */
const OPENCODE_PROFILE_ROOT_PREFIX = '.cli-bridge-opencode-profile-'

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

/**
 * Give one opencode process its own configuration, and close the shared task
 * directory as a channel into it.
 *
 * Runtime gives a root and every manager it spawns one cwd. opencode reads the
 * project layer of that cwd on every model request, so profiles sharing a
 * directory ran under each other's instructions, subagents and tool grants, and
 * an agent that wrote `opencode.json` or `.opencode/agents/<name>.md` into its
 * own workspace changed the next profile's turn — measured end to end, with the
 * later director quoting the earlier one's file, while each receipt still named
 * its own profile.
 *
 * Three moves, each measured against opencode 1.18.30 rather than inferred:
 *
 *   1. The generated `opencode.json` never enters the workspace. It reaches this
 *      process through `OPENCODE_CONFIG_CONTENT`; `OPENCODE_CONFIG` already
 *      carries the request's MCP file, which may hold credentials.
 *   2. `OPENCODE_DISABLE_PROJECT_CONFIG` closes the project layer, so no file in
 *      the shared directory — this bridge's own earlier output, a repository's
 *      config, or one an agent wrote mid-run — reaches the process at all. No
 *      file is deleted to achieve that: a user's config is indistinguishable
 *      from a stale generated one, and it is now harmless either way.
 *   3. The profile's own `.opencode/**` files are applied into a private
 *      per-turn directory under the cwd, named by `OPENCODE_CONFIG_DIR`. The
 *      directory is fresh on every turn, so an edited or re-rendered file can
 *      never refuse a later session, and it is removed when the turn ends.
 *
 * Instruction paths are made absolute in the value handed to the spawn, because
 * with the project layer closed a relative one resolves from the config
 * directory rather than the cwd. The plan keeps the materializer's relative
 * form, so the plan digest stays independent of where the workspace sits.
 *
 * The project context files — `<cwd>/AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` —
 * are gated behind the same flag, so they are closed too.
 *
 * What this does NOT close, and what the README says plainly: skills under
 * `<cwd>/.claude/skills` and `<cwd>/.agents/skills`, which opencode gates on a
 * separate `OPENCODE_DISABLE_EXTERNAL_SKILLS`; and a co-resident agent WRITING
 * into a running turn's private directory, which no mode can prevent while both
 * run as the same user.
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

  // A profile with no instructions, no prompt addition, no tools and no
  // permissions generates no config at all — a manager whose only declared
  // tools were coordination tools arrives exactly like that, because the caller
  // strips those before sending. Returning early for it would hand that turn
  // the whole open project layer: its own subagent in the shared
  // `.opencode/agents/`, and the directory's instructions, `agent.<name>.prompt`,
  // custom tools and skills resolved into its process. An empty config is still
  // a config, and the isolation is a property of the turn, not of the profile's
  // contents.
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
      written: applied.written.map((relPath) => posix.join(basename(root), relPath)),
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

/**
 * Serialize the config this process receives, merged under the operator's own.
 *
 * The spawn merges provisioned env over `process.env`, so an operator who set
 * `OPENCODE_CONFIG_CONTENT` for the daemon — a custom provider, a base URL —
 * had it replaced by the profile's config with nothing reported. That value
 * reached the child untouched before the bridge used this variable, so it
 * becomes the BASE here and every key the profile declares replaces it. The
 * profile stays the authority for `instructions`, `tools`, `permission` and
 * `mcp`; the operator's unrelated keys survive.
 *
 * The result is refused when the host executor's sanitizer would drop it. That
 * sanitizer discards an oversize value silently, which leaves opencode running
 * on the headless defaults — no instructions, no tool restrictions, bash
 * allowed — while the receipt still commits to the profile. `buildDockerExecArgs`
 * applies no such ceiling, so refusing here is also what makes one profile mean
 * the same thing on both executors.
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
    const plan = materializeProfile(profile, 'pi', { skip: ['mcp', 'extensions'] })
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
  console.info(`[cli-bridge] profile materialization receipt ${JSON.stringify(receipt)}`)
  return receipt
}

/**
 * The `workspacePlanDigest` this session already applied into its own cwd,
 * shaped as `applyWorkspacePlan` options.
 *
 * A resumed session's workspace is the running agent's live state — claude-code
 * stores session memory in CLAUDE.md — so re-application must key on what the
 * session proved it applied, not on the current file bytes. The digest is
 * passed only when the materialization target IS the session's recorded cwd; a
 * caller that reuses a session id against a different directory gets a full
 * materialization there.
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

/**
 * Enforce the Pi limits that have a proven native lowering.
 *
 * Pi's catalog exposes one completion cap that includes hidden reasoning.
 * Visible-only and reasoning-only ceilings have no independent Pi control.
 */
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

/**
 * Accept one redundant legacy cap only when the canonical field already owns it.
 *
 * Some older profile authors emitted both fields. The legacy value never becomes
 * authority: a missing canonical value, a conflict, or any extra key still fails.
 */
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
 * Model agreement is decided between two harness-RELATIVE ids. The request's id
 * was already stripped of its harness prefix; the profile's id is composed into
 * the wire form its author would have sent and stripped the same way. Comparing
 * a stripped request against an unstripped profile id refused an exactly
 * matching pair and printed two identical-looking strings as the conflict
 * (issue #212: `request model "kimi-code/kimi-for-coding" conflicts with
 * agent_profile.model "kimi-code/kimi-for-coding"`).
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
    const profileModel = modelWithinHarness(profileWireModel(requestedModel, requestedProvider, harness), harness)
    if (wireModel !== profileModel) {
      throw new BackendError(
        `request model ${JSON.stringify(req.model)} selects ${JSON.stringify(wireModel)} within harness `
        + `${JSON.stringify(harness)}, which conflicts with agent_profile.model ${JSON.stringify(profileModel)}`,
        'parse_error',
      )
    }
  } else if (requestedProvider !== undefined) {
    const slash = wireModel.indexOf('/')
    const wireProvider = slash > 0 ? wireModel.slice(0, slash) : null
    // A provider equal to the harness is spent as the wire id's single harness prefix, so the
    // remainder carries no provider segment of its own — the same composition rule as above.
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

/**
 * The `harness/provider/model` id a profile declares, composed exactly as the
 * caller composes it (agent-runtime `profileBridgeWireModel`): one harness
 * prefix, and a provider segment only where the model does not already carry it.
 * A provider that IS the harness therefore collapses into the harness prefix
 * instead of appearing twice.
 */
function profileWireModel(
  model: string,
  provider: string | undefined,
  harness: HarnessId,
): string {
  const modelWithoutHarness = model.startsWith(`${harness}/`)
    ? model.slice(harness.length + 1)
    : model
  const qualified = provider && !modelWithoutHarness.startsWith(`${provider}/`)
    ? `${provider}/${modelWithoutHarness}`
    : modelWithoutHarness
  return qualified.startsWith(`${harness}/`) ? qualified : `${harness}/${qualified}`
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
export function resolveMcpServers(
  req: ChatRequest,
  session: SessionRecord | null,
): Record<string, McpServerSpec> | null {
  const merged: Record<string, McpServerSpec> = {}

  const profile = resolveAgentProfile(req, session)
  const requestMcp = req.mcp?.mcpServers
  if (profile && Object.keys(requestMcp ?? {}).length > 0) {
    throw new BackendError(
      'request mcp cannot accompany agent_profile; declare the exact MCP servers in agent_profile.mcp',
      'parse_error',
    )
  }
  if (profile && typeof profile === 'object') {
    const profileMcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (profileMcp && typeof profileMcp === 'object') {
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        if ((raw as { enabled?: unknown }).enabled === false) continue
        merged[name] = profileMcpToSpec(raw, name)
      }
    }
  }

  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normalizeMcpServerSpec(raw, name)
    }
  }

  // Runtime attachments mount platform endpoints beside the authored
  // sources without entering any identity digest. A collision would let an
  // attachment shadow an authored server (or the reverse) invisibly to the
  // session binding, so it is refused instead of resolved by precedence.
  const attachments = req.runtime_attachments?.mcp
  if (attachments && typeof attachments === 'object') {
    for (const [name, raw] of Object.entries(attachments)) {
      if (!name || !raw || typeof raw !== 'object') {
        throw new BackendError(
          `runtime_attachments.mcp[${JSON.stringify(name)}] is not an MCP server object`,
          'parse_error',
        )
      }
      if (merged[name] !== undefined) {
        throw new BackendError(
          `runtime attachment ${JSON.stringify(name)} collides with an MCP server declared by the ` +
            `${profile ? 'agent_profile' : 'request mcp channel'}; attachments must use a reserved alias`,
          'parse_error',
        )
      }
      if ((raw as { enabled?: unknown }).enabled === false) {
        throw new BackendError(
          `runtime attachment ${JSON.stringify(name)} is disabled; an attachment mounts by presence — omit the entry instead`,
          'parse_error',
        )
      }
      merged[name] = profileMcpToSpec(raw, name, `runtime_attachments.mcp[${JSON.stringify(name)}]`)
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

function profileMcpToSpec(
  raw: AgentProfileMcpServer,
  name: string,
  where = `mcp[${JSON.stringify(name)}]`,
): McpServerSpec {
  // AgentProfileMcpServer uses `transport`; McpServerSpec uses `type`.
  // Rename and forward only the fields we model.
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
  // A profile-less request owns these bytes all the way to argv/on-disk MCP config. This path used
  // to drop every non-string silently,
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
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildCanonicalMcpServers(specs)
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp] materialized servers: ${serverNames.length ? serverNames.join(", ") : "(none)"} from specs: ${Object.keys(specs).join(", ") || "(empty)"}`)
  }
  if (serverNames.length === 0) return null

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/** True when a process id still names a live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another user — still very much alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Write a cwd-native config without following a planted final-component symlink. */
function writeFileNoFollow(path: string, bytes: string): void {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

export function materializeMcpServersForPi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
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
  let dir: string | null = null
  try {
    // pi-mcp-adapter has exposed the per-process `--mcp-config` flag since its first public
    // release. Keep the config under the mounted workspace so host and Docker Pi see the same
    // absolute path, but never mutate the project's own `.pi/mcp.json`.
    dir = mkdtempSync(join(workspaceCwd, '.cli-bridge-pi-mcp-'))
    chmodSync(dir, 0o755)
    const configPath = join(dir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { flag: 'wx', mode: 0o644 })
    let cleaned = false
    return {
      configPath,
      serverNames,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        rmSync(dir!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`backend pi failed to prepare MCP config: ${message}`, 'not_configured', error)
  }
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
  const writeLockAtomic = (payload: { pid: number; originalBytes: string | null }): void => {
    const tmpPath = `${lockPath}.${process.pid}.tmp`
    // `wx` refuses a pre-planted symlink at the tmp path; rename replaces
    // the lock atomically without following links.
    rmSync(tmpPath, { force: true })
    writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx' })
    renameSync(tmpPath, lockPath)
  }

  // Guarded read of a workspace-controlled path. A plain `readFileSync`
  // would follow symlinks and BLOCK FOREVER on a planted FIFO (host-side
  // DoS before any timeout starts). Open no-follow + non-blocking, fstat
  // the fd (no swap race), reject non-regular files and oversized bytes.
  const MAX_WORKSPACE_READ = 1024 * 1024
  const readWorkspaceFileMaybe = (path: string): string | null => {
    let fd: number
    try {
      fd = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      return fail(`${path} is not readable as a regular file (${code ?? 'unknown error'})`)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) fail(`${path} is not a regular file (workspace planted a special file)`)
      if (st.size > MAX_WORKSPACE_READ) fail(`${path} exceeds the ${MAX_WORKSPACE_READ}-byte cap`)
      return readFileSync(fd, 'utf-8')
    } finally {
      closeSync(fd)
    }
  }

  const tryAcquire = (): boolean => {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, originalBytes: readWorkspaceFileMaybe(configPath) }),
        { flag: 'wx' },
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

  if (!tryAcquire()) {
    let stale: { pid?: number; originalBytes?: string | null } | null = null
    try {
      stale = JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { pid?: number; originalBytes?: string | null }
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
    if (holderPid === null || pidAlive(holderPid)) {
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: another run${holderPid !== null ? ` (pid ${holderPid})` : ''} holds the `
        + `mount for this cwd; ${backendName} supports one MCP-mounted run per workspace — use distinct cwds`,
        'not_configured',
      )
    }
    // Stale lock from a dead/crashed run: roll the config back to the
    // dead run's recorded pre-mount state (or remove it when unknown —
    // leaked request-scoped servers must not persist), then steal.
    try {
      if (stale && typeof stale.originalBytes === 'string') {
        writeFileNoFollow(configPath, stale.originalBytes)
      } else {
        // unlink removes a symlink itself, never its target — safe.
        rmSync(configPath, { force: true })
      }
      rmSync(lockPath, { force: true })
      if (!tryAcquire()) {
        fail('lost race stealing stale lock: another run acquired it first')
      }
    } catch (retryErr) {
      if (retryErr instanceof BackendError) throw retryErr
      fail(`lost race stealing stale lock: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
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
  const originalBytes = readWorkspaceFileMaybe(configPath)
  try {
    let recorded: string | null | undefined
    try {
      recorded = (JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { originalBytes?: string | null }).originalBytes
    } catch {
      recorded = undefined
    }
    if (recorded !== originalBytes) {
      writeLockAtomic({ pid: process.pid, originalBytes })
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
  try {
    writeFileNoFollow(configPath, JSON.stringify(merged, null, 2))
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }

  let cleaned = false
  return {
    configPath,
    serverNames,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try {
        if (originalBytes !== null) {
          // No-follow: the workspace may have swapped the config for a
          // symlink mid-run; never restore THROUGH it from the host.
          writeFileNoFollow(configPath, originalBytes)
        } else {
          rmSync(configPath, { force: true })
        }
      } catch (err) {
        // FAIL-CLOSED: restore failed (e.g. symlink planted mid-run).
        // Keep the lock — its recorded originalBytes let a later mount's
        // stale-lock recovery retry the rollback once this pid exits;
        // releasing it now would let the tampered config masquerade as
        // workspace-original state.
        if (process.env.CLI_BRIDGE_DEBUG_MCP) {
          console.error(`[cli-bridge mcp ${backendName}] cleanup restore failed for ${configPath}; keeping lock: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      releaseLock()
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
 * Materialize MCP servers for Kimi Code's project-local loader.
 *
 * Kimi Code 0.36 reads `<cwd>/.kimi-code/mcp.json` and has no
 * per-invocation `--mcp-config-file` option. Reuse the locked mount
 * so request servers never leak into the next run or overwrite the
 * user's project config after cleanup.
 */
export function materializeMcpServersForKimi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const target = requireMaterializationCwd(cwd, 'kimi MCP passthrough')
  return mountCwdNativeMcp(target, {
    subdir: '.kimi-code',
    filename: 'mcp.json',
    backendName: 'kimi-code',
    mcpServers: buildCanonicalMcpServers(specs),
  })
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
  return materializeMcpServersForOpencode(specs, permissions)
}

/**
 * Write opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * from a normalized `McpServerSpec` map. Layered on top of the user's
 * global `~/.config/opencode/opencode.json` via `OPENCODE_CONFIG`.
 *
 * Always returns a non-null result — opencode needs a config file
 * even when no MCP servers are declared (so the headless permission
 * map below can disable interactive prompts).
 *
 * Schema source: https://opencode.ai/config.json
 *   (`properties.mcp.additionalProperties`).
 */
export function materializeMcpServersForOpencode(
  specs: Record<string, McpServerSpec> | null,
  callerPermissions?: Record<string, unknown> | null,
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

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'))
  const configPath = join(dir, 'opencode.json')
  // Headless benchmark and automation runs must never block on an
  // interactive permission prompt, so every tool defaults to `allow`.
  const headlessPermission: Record<string, 'allow' | 'ask' | 'deny'> = {
    external_directory: 'allow',
    bash: 'allow',
    edit: 'allow',
    read: 'allow',
    write: 'allow',
    webfetch: 'allow',
    task: 'allow',
    plan_enter: 'allow',
    plan_exit: 'allow',
    question: 'allow',
  }
  // The caller's agent_profile.permissions override the headless defaults —
  // an explicit `deny` is load-bearing (the search benchmark's no-web arm
  // sets webfetch:'deny' to remove native web). Without this, the hardcoded
  // `allow` above silently kept webfetch on and the "offline" arm still
  // fetched. Only known permission verbs are honored, per-key.
  if (callerPermissions && typeof callerPermissions === 'object') {
    for (const [key, value] of Object.entries(callerPermissions)) {
      if (value === 'allow' || value === 'ask' || value === 'deny') {
        headlessPermission[key] = value
      }
    }
  }
  writeFileSync(configPath, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: headlessPermission,
    mcp: opencodeMcp,
  }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

export function materializeEmptyMcpConfig(): MaterializedMcpConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
  return {
    configPath,
    serverNames: [],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
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
 * A supplied sessionHome retains native state under the bridge data directory.
 * Cleanup removes only this turn's config and auth; one-shot homes are removed entirely.
 * Returns null when no usable servers remain and no session home was supplied.
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
  sessionHome?: string,
): MaterializedCodexHome | null {
  if (!specs && !sessionHome) return null

  const lines: string[] = []
  const serverNames: string[] = []
  for (const [name, spec] of Object.entries(specs ?? {})) {
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
  if (serverNames.length === 0 && !sessionHome) return null

  // Codex aborts if CODEX_HOME is under the system tmpdir on some
  // platforms — use the user's HOME/.cache as a stable parent.
  const baseDir = sessionHome ?? mkdtempSync(join(stableTmpRoot(), 'cli-bridge-codex-'))
  // A session keeps native rollouts and indexes, never the previous turn's credentials.
  for (const name of ['config.toml', 'auth.json']) rmSync(join(baseDir, name), { force: true })
  writeFileSync(join(baseDir, 'config.toml'), lines.join('\n\n') + '\n')

  if (authSourcePath) {
    try {
      const auth = readFileMaybe(authSourcePath)
      if (auth !== null) writeFileSync(join(baseDir, 'auth.json'), auth)
    } catch {
      // Best-effort: codex without auth.json will fail to call the
      // model. Surface that as an upstream error from the backend
      // rather than silently swallowing it here.
    }
  }

  return {
    homePath: baseDir,
    serverNames,
    cleanup: () => {
      try {
        if (sessionHome) {
          for (const name of ['config.toml', 'auth.json']) rmSync(join(baseDir, name), { force: true })
        } else {
          rmSync(baseDir, { recursive: true, force: true })
        }
      } catch {
        // best-effort
      }
    },
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
      // Don't mkdir — cli-bridge runs on hosts that always have
      // ~/.cache (we don't ship a polyfill for first-boot Linux).
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

/**
 * The native control each backend uses per prompt intent, or `null` where it
 * has none.
 *
 * Measured against the installed CLIs, not inferred from their docs — every
 * non-null entry was confirmed by reading the request the CLI actually sends:
 *
 *  - claude-code 2.1.222: `--system-prompt` drops the 27,673-byte built-in
 *    prompt from the wire; `--append-system-prompt` leaves it in place and adds
 *    the caller's text after it.
 *  - pi 0.83.0: same split, `--system-prompt` (text or file path) replaces the
 *    2,565-byte built-in prompt, `--append-system-prompt` keeps it.
 *  - codex 0.146.0: `model_instructions_file` becomes the request's entire
 *    `instructions` field. There is NO additive control — codex's AGENTS.md
 *    lands in a developer/user message, not the system channel.
 *  - gemini 0.26.0: `.gemini/system.md` with `GEMINI_SYSTEM_MD=1` replaces the
 *    base prompt. Its only additive path is GEMINI.md memory, which is the
 *    `instructions` surface.
 *
 * Everything else is `null` on both intents, INCLUDING the backends whose
 * prompt path is a `role: 'system'` message. That message is flattened into
 * the user turn before the CLI ever sees it, so it is not a system-prompt
 * channel at all: honoring either intent through it would mean the caller's
 * text arrives as ordinary user content while the harness's own prompt runs
 * unchanged. Unknown backend names fall through to the same refusal, so a new
 * backend cannot inherit a capability by omission.
 */
const HARNESS_PROMPT_CONTROLS: Record<string, { replace: string | null; append: string | null }> = {
  'claude-code': { replace: '--system-prompt', append: '--append-system-prompt' },
  claude: { replace: '--system-prompt', append: '--append-system-prompt' },
  pi: { replace: '--system-prompt', append: '--append-system-prompt' },
  prime: { replace: '--system-prompt', append: '--append-system-prompt' },
  codex: { replace: '-c model_instructions_file=<file>', append: null },
  gemini: { replace: '.gemini/system.md', append: null },
  // opencode composes its `instructions[]` files into the same system message
  // as its built-in prompt, which stays in place — a real additive channel. Its
  // replacement control (`agent.<name>.prompt`) binds to one agent chosen at
  // launch, which a workspace plan cannot guarantee, so replacement is refused.
  opencode: { replace: null, append: 'opencode.json instructions[]' },
}

const NO_PROMPT_CONTROLS = { replace: null, append: null } as const

/**
 * Refuse a prompt intent the backend cannot execute, before anything spawns.
 *
 * The materializer already fails closed for backends that run a profile plan,
 * but several backends (acp, factory, nanoclaw) never materialize one and would
 * otherwise drop the intent in silence. This is the single seam every prompt
 * path passes through, so the refusal fires for all of them.
 */
export function assertProfilePromptIntentsSupported(
  profile: AgentProfile | null,
  backend: string,
): void {
  if (!profile || typeof profile !== 'object') return
  const prompt = (profile as { prompt?: { systemPrompt?: unknown; appendSystemPrompt?: unknown } }).prompt
  if (!prompt || typeof prompt !== 'object') return
  const controls = HARNESS_PROMPT_CONTROLS[backend] ?? NO_PROMPT_CONTROLS

  if (typeof prompt.systemPrompt === 'string' && controls.replace === null) {
    throw new BackendError(
      `backend ${backend} cannot replace its harness's system prompt: agent_profile.prompt.systemPrompt `
      + 'deletes the harness\'s own prompt, and this backend has no control that does that. '
      + 'Use agent_profile.prompt.instructions for additive context, or run a backend that does '
      + `(${Object.entries(HARNESS_PROMPT_CONTROLS)
        .filter(([, c]) => c.replace !== null)
        .map(([name]) => name)
        .join(', ')}).`,
      'not_configured',
    )
  }
  if (typeof prompt.appendSystemPrompt === 'string' && controls.append === null) {
    throw new BackendError(
      `backend ${backend} cannot add to its harness's system prompt: agent_profile.prompt.appendSystemPrompt `
      + 'must reach the same privileged position as the system prompt, and this backend has no control '
      + 'that puts it there. Use agent_profile.prompt.instructions for the project-instruction surface, '
      + `or run a backend that does (${Object.entries(HARNESS_PROMPT_CONTROLS)
        .filter(([, c]) => c.append !== null)
        .map(([name]) => name)
        .join(', ')}).`,
      'not_configured',
    )
  }
}

export function resolvePromptMessages(
  req: ChatRequest,
  session: SessionRecord | null,
  backend: string,
): ChatMessage[] {
  const profile = resolveAgentProfile(req, session)
  assertProfilePromptIntentsSupported(profile, backend)
  const preamble = renderLocalHarnessProfilePreamble(profile)
  if (!preamble) return req.messages
  return [{ role: 'system', content: preamble }, ...req.messages]
}

/**
 * Summarize the profile's declared surfaces for the model.
 *
 * Deliberately carries NO prompt text. `prompt.systemPrompt` used to be folded
 * in here, which made every backend that renders this preamble an additive
 * channel for a field that means replacement — the harness's own prompt stayed
 * in force and nothing in the result said so. Both prompt intents now travel
 * through the harness's own control (see {@link HARNESS_PROMPT_CONTROLS}) or
 * are refused; this preamble is only the informational summary that remains.
 */
export function renderLocalHarnessProfilePreamble(profile: AgentProfile | null): string | null {
  if (!profile || typeof profile !== 'object') return null
  const sections: string[] = []

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
