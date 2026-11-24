/**
 * Cursor Agent's native AgentProfile surfaces, measured on cursor-agent 2026.11.22 through this
 * Bridge under fs-jail and the relay:
 *
 *  - instructions: a project rule. Cursor loads `.cursor/rules/**\/*.mdc` from the workspace and
 *    each ancestor, and sends a rule whose front matter says `alwaysApply: true` with every turn.
 *  - MCP: the project config `<workspace>/.cursor/mcp.json` (profile-mcp.ts). `--approve-mcps`
 *    only admits the servers: each tool CALL still needs approval, which a headless turn answers
 *    "rejected" ("MCP approval denied"). The one grant short of `--force` is the permission entry
 *    `Mcp(<server>:*)` in the project config `.cursor/cli.json`, so the turn writes one per
 *    mounted server there and nothing broader.
 *
 * Cursor offers a customer seat no system-prompt control. Its one replacement flag, the hidden
 * `--system-prompt <file>`, is described by the CLI itself as "Anysphere/OpenAI team only", and a
 * rule is project context, not the system prompt. So `prompt.systemPrompt` and
 * `prompt.appendSystemPrompt` are refused (profile-prompt.ts), and every other profile surface
 * Cursor has no control for is refused by name before anything is written or spawned.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
/** A server name Cursor's `Mcp(<server>:<tool>)` permission pattern can name exactly. */
const PERMISSION_SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/u

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
  const unnameable = servers.filter((name) => !PERMISSION_SAFE_NAME.test(name))
  if (unnameable.length > 0) {
    throw new BackendError(
      `Cursor Agent can grant MCP tool calls only to servers named with letters, digits, '.', '_' or '-'; rename ${unnameable.map((name) => JSON.stringify(name)).join(', ')}`,
      'parse_error',
    )
  }
  const instructions = (profile?.prompt?.instructions ?? []).filter((line) => line.trim().length > 0)
  // The user config the spawned CLI layers the project config over: a jail redirects HOME and XDG_CONFIG_HOME under its root.
  const jailRoot = req.jailSpec?.root
  return {
    flags: servers.length > 0 ? ['--approve-mcps'] : [],
    mount(cwd) {
      const restores: Array<() => void> = []
      const restore = (): void => { for (const undo of restores.splice(0).reverse()) undo() }
      try {
        // MCP first: its mount may create `.cursor`, which the others then share.
        const mcp = materializeMcpServersForCursor(specs, cwd)
        if (mcp) {
          restores.push(mcp.cleanup)
          const grants = mcp.serverNames.map((name) => `Mcp(${name}:*)`)
          restores.push(mountCwdNativeFile(requireMaterializationCwd(cwd, 'cursor MCP passthrough'), {
            subdir: '.cursor',
            filename: 'cli.json',
            backendName: BACKEND,
            nouns: { config: 'CLI permissions', mount: 'MCP tool permissions', run: 'MCP-mounted run' },
            render: (original) => projectCliConfig(original, userCliPermissions(jailRoot), grants),
          }).cleanup)
        }
        if (instructions.length > 0) {
          restores.push(mountCwdNativeFile(requireMaterializationCwd(cwd, 'cursor AgentProfile instructions'), {
            subdir: RULE_DIR,
            filename: RULE_FILE,
            backendName: BACKEND,
            nouns: { config: 'profile rule', mount: 'the profile rule', run: 'profiled run' },
            render: () => `---\nalwaysApply: true\n---\n\n${instructions.join('\n\n')}\n`,
          }).cleanup)
        }
      } catch (error) {
        restore()
        throw error
      }
      return restore
    },
  }
}

interface PermissionLists { allow: string[]; deny: string[] }

/**
 * The run's `.cursor/cli.json`: the workspace's own config with the MCP grants added.
 *
 * Cursor merges a project config over the user's by replacing each array, so the lists written
 * here are the run's whole lists. They keep every entry of the user's config and the workspace's
 * own: a deny the operator wrote still applies, and the only addition is the grant.
 */
function projectCliConfig(original: string | null, user: PermissionLists, grants: string[]): string {
  let own: Record<string, unknown> = {}
  if (original !== null) {
    try {
      const parsed = JSON.parse(original) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) own = parsed as Record<string, unknown>
    } catch {
      // Unparseable workspace config: Cursor could not have applied it either; cleanup restores its bytes.
    }
  }
  const workspace = permissionLists(own.permissions)
  const unique = (entries: string[]): string[] => [...new Set(entries)]
  return JSON.stringify({
    ...own,
    permissions: {
      allow: unique([...user.allow, ...workspace.allow, ...grants]),
      deny: unique([...user.deny, ...workspace.deny]),
    },
  }, null, 2)
}

function permissionLists(value: unknown): PermissionLists {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const strings = (list: unknown): string[] => Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  return { allow: strings(record.allow), deny: strings(record.deny) }
}

/** `cli-config.json` where the spawned Cursor reads it: CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor. */
function userCliPermissions(jailRoot: string | undefined): PermissionLists {
  const env = process.env
  const dir = env.CURSOR_CONFIG_DIR?.trim()
    || (jailRoot ? join(jailRoot, '.config', 'cursor')
      : env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), 'cursor') : join(env.HOME?.trim() || homedir(), '.cursor'))
  const path = join(dir, 'cli-config.json')
  let fd: number
  try {
    // No-follow and non-blocking: a jailed home is workspace-writable, so a planted link or FIFO must not redirect or stall the read.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { allow: [], deny: [] }
    throw new BackendError(`Cursor user config ${path} is not readable as a regular file, so its permissions cannot be kept`, 'not_configured')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new BackendError(`Cursor user config ${path} is not a regular file under 1 MiB, so its permissions cannot be kept`, 'not_configured')
    }
    try {
      return permissionLists((JSON.parse(readFileSync(fd, 'utf8')) as { permissions?: unknown }).permissions)
    } catch {
      throw new BackendError(`Cursor user config ${path} is not JSON, so its permissions cannot be kept`, 'not_configured')
    }
  } finally {
    closeSync(fd)
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
