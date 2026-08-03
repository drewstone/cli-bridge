import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileMaterializationReceipt } from './types.js'
import { BackendError } from './types.js'
import type { ChatRequest } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import {
  createPrivateTemporaryRoot,
  hardenPrivateTemporaryTree,
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
import { resolveAgentProfile } from './profile-core.js'

/**
 * The host directory request-scoped files are written into.
 *
 * `undefined` means the executor mounts NO host directory into the container, so
 * a profile or MCP file written here would land where the CLI cannot read it.
 * Refusing with the setting that fixes it is the only honest answer: writing it
 * anyway is the silent-corruption path where the caller's files are discarded
 * with no error at all.
 */
export function requireMaterializationCwd(cwd: string | undefined, what: string): string {
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
    Object.entries(env).map(([name, value]) => [name, requirePublicPlanValue(value, `env ${name}`, harness)]),
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
      flags: applied.flags.map((flag, index) => requirePublicPlanValue(flag, `launch flag ${index}`, harness)),
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
      throw new Error(`no request-scoped Pi loader exists for generic workspace file(s): ${genericFiles.join(', ')}`)
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
    throw new Error(`no request-scoped Pi loader exists for workspace file(s): ${unsupportedPaths.join(', ')}`)
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
      mode: actualRoot ? statSync(join(actualRoot, path)).mode & 0o777 : (modes.get(path) ?? 0o644),
    })),
    unsupported: applied.unsupported,
  }
  req.profile_materialization_receipt = receipt
  console.info(`[cli-bridge] profile materialization receipt ${JSON.stringify(receipt)}`)
  return receipt
}
