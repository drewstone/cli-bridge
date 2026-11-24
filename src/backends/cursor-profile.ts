/**
 * Cursor Agent's native AgentProfile surfaces, read from cursor-agent 2026.11.22:
 *
 *  - instructions: a project rule. Cursor loads `.cursor/rules/**\/*.mdc` from the workspace and
 *    each ancestor, and sends a rule whose front matter says `alwaysApply: true` with every turn.
 *  - MCP: the project config `<workspace>/.cursor/mcp.json` (profile-mcp.ts), admitted without a
 *    prompt by `--approve-mcps`.
 *
 * Cursor offers a customer seat no system-prompt control. Its one replacement flag, the hidden
 * `--system-prompt <file>`, is described by the CLI itself as "Anysphere/OpenAI team only", and a
 * rule is project context, not the system prompt. So `prompt.systemPrompt` and
 * `prompt.appendSystemPrompt` are refused (profile-prompt.ts), and every other profile surface
 * Cursor has no control for is refused by name before anything is written or spawned.
 */
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { assertProfileRequestAuthority, requireMaterializationCwd } from './profile-support.js'
import { assertProfilePromptIntentsSupported } from './profile-prompt.js'
import { buildCanonicalMcpServers, materializeMcpServersForCursor, mountCwdNativeFile, resolveMcpServers } from './profile-mcp.js'

const BACKEND = 'cursor'
/** One fixed name, so the mount's lock refuses a second profiled run in the same workspace. */
const RULE_DIR = '.cursor/rules'
const RULE_FILE = 'cli-bridge-agent-profile.mdc'

export interface CursorProfilePlan {
  /** Launch flags for the surfaces this turn mounts. */
  flags: string[]
  /** Write the turn's rule and MCP config into the workspace; returns the idempotent restore, run after the CLI exits. */
  mount(cwd: string | undefined): () => void
}

/** Validate a turn's profile and MCP for Cursor, before admission and before any workspace write. */
export function planCursorProfile(req: ChatRequest, session: SessionRecord | null): CursorProfilePlan {
  const profile = assertProfileRequestAuthority(req, session)
  if (profile) assertCursorProfileSupported(req, profile)
  const specs = resolveMcpServers(req, session, { backend: BACKEND, privateMcpConfig: false })
  const servers = specs ? Object.keys(buildCanonicalMcpServers(specs)) : []
  const instructions = (profile?.prompt?.instructions ?? []).filter((line) => line.trim().length > 0)
  return {
    flags: servers.length > 0 ? ['--approve-mcps'] : [],
    mount(cwd) {
      const restores: Array<() => void> = []
      const restore = (): void => { for (const undo of restores.splice(0).reverse()) undo() }
      try {
        // MCP first: its mount may create `.cursor`, which the rule's `.cursor/rules` then nests in.
        const mcp = materializeMcpServersForCursor(specs, cwd)
        if (mcp) restores.push(mcp.cleanup)
        if (instructions.length > 0) {
          const rule = mountCwdNativeFile(requireMaterializationCwd(cwd, 'cursor AgentProfile instructions'), {
            subdir: RULE_DIR,
            filename: RULE_FILE,
            backendName: BACKEND,
            nouns: { config: 'profile rule', mount: 'the profile rule', run: 'profiled run' },
            render: () => `---\nalwaysApply: true\n---\n\n${instructions.join('\n\n')}\n`,
          })
          restores.push(rule.cleanup)
        }
      } catch (error) {
        restore()
        throw error
      }
      return restore
    },
  }
}

/**
 * Refuse what a Cursor turn cannot carry exactly: a profile bound to another harness or model,
 * a prompt intent without a control (profile-prompt.ts), and every surface with no Cursor control.
 */
function assertCursorProfileSupported(req: ChatRequest, profile: AgentProfile): void {
  if (profile.harness !== undefined && profile.harness !== BACKEND) {
    throw new BackendError(
      `agent_profile.harness ${JSON.stringify(profile.harness)} conflicts with selected harness ${JSON.stringify(BACKEND)}`,
      'parse_error',
    )
  }
  assertProfilePromptIntentsSupported(profile, BACKEND)

  // `cursor` and `cursor/default` both keep Cursor's configured default model.
  const harnessModel = (id: string): string => {
    const bare = id === BACKEND ? '' : id.startsWith(`${BACKEND}/`) ? id.slice(BACKEND.length + 1) : id
    return bare === 'default' ? '' : bare
  }
  const model = profile.model
  if (model?.default !== undefined && harnessModel(model.default) !== harnessModel(req.model)) {
    throw new BackendError(
      `request model ${JSON.stringify(req.model)} conflicts with agent_profile.model ${JSON.stringify(model.default)}`,
      'parse_error',
    )
  }
  if (model?.provider !== undefined && model.provider !== BACKEND) {
    throw new BackendError(
      `agent_profile.model.provider ${JSON.stringify(model.provider)} cannot be selected through Cursor Agent, which routes its own models`,
      'parse_error',
    )
  }

  const declared = (value: unknown): boolean => Array.isArray(value) ? value.length > 0
    : typeof value === 'string' ? value.trim().length > 0
      : value !== null && typeof value === 'object' && Object.keys(value).length > 0
  const unsupported = [
    ...(['small', 'reasoningEffort', 'maxVisibleOutputTokens', 'maxReasoningTokens', 'maxTotalOutputTokens'] as const)
      .filter((key) => model?.[key] !== undefined).map((key) => `model.${key}`),
    ...(['tools', 'permissions', 'subagents', 'hooks', 'modes'] as const)
      .filter((key) => declared(profile[key])).map((key) => key),
    // A resource kind holding at least one resource; `failOnError` is an option, not a resource.
    ...Object.entries(profile.resources ?? {})
      .filter(([kind, value]) => kind !== 'failOnError' && declared(value)).map(([kind]) => `resources.${kind}`),
  ]
  if (unsupported.length > 0) {
    throw new BackendError(
      `Cursor Agent has no control for agent_profile ${unsupported.join(', ')}; it carries prompt.instructions and mcp`,
      'capability_denied',
      undefined,
      { providerDispatch: 'not_started' },
    )
  }
}
