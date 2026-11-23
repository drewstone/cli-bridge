import { randomBytes } from 'node:crypto'
import { BackendError } from './types.js'
import { exceedsHostEnvValueLimit, MAX_ENV_VALUE_BYTES } from '../executors/host.js'

/** The environment variable opencode merges as its final local config layer. */
export const OPENCODE_PROCESS_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

/**
 * Lay the text-only tool surface into opencode's FINAL config layer and name
 * the agent that carries it.
 *
 * The native boundary, measured against the real runner (opencode 1.18.30,
 * local recording provider): a turn run with `--agent <name>` whose agent is
 * declared `agent[name] = { mode: "primary", permission: { "*": "deny" } }`
 * carries ZERO tools on the wire — the resolver appends this agent-specific
 * wildcard after the global and agent defaults and checks every tool id,
 * ambient action tools and MCP servers alike. Verified with a provider
 * configured by the project layer, MCP servers in the project config and the
 * operator's global JSONC config, and hostile `"*": "allow"` entries in both
 * the global permission map and `agent.build.permission`: 12 tools on the
 * ordinary control, 0 on the isolated turn, tools restored afterwards, all
 * runs completing through their own provider.
 *
 * The agent name is fresh per turn, so no inherited same-name agent object
 * can override the wildcard per-tool. Unrelated config keys (provider,
 * instructions, other agents, MCP declarations) are preserved untouched: the
 * project layer and the operator's global config stay live, which is what
 * keeps a project-configured provider working on a text-only turn. The env
 * content itself is strict JSON — a comment there is a hard config error
 * before this overlay runs — so a strict parse merges it correctly.
 *
 * `tool_choice: "none"` is the standard no-model-tool-calls request: the
 * model is offered no tools at all, and analysis/trace callbacks stay outside
 * the nested model call on their own authority.
 */
export function overlayOpencodeTextOnlyToolSurface(env: Record<string, string>): string {
  const current = env[OPENCODE_PROCESS_CONFIG_ENV] ?? process.env[OPENCODE_PROCESS_CONFIG_ENV]
  let base: Record<string, unknown> = {}
  if (current !== undefined && current.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      throw new BackendError(
        `the ${OPENCODE_PROCESS_CONFIG_ENV} already present is not valid JSON, so the text-only tool surface `
          + 'cannot be laid over it; correct or unset it before requesting tool_choice "none" on backend opencode',
        'parse_error',
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BackendError(
        `the ${OPENCODE_PROCESS_CONFIG_ENV} already present is not a JSON object, so the text-only tool surface `
          + 'cannot be laid over it',
        'parse_error',
      )
    }
    base = parsed as Record<string, unknown>
  }
  const agentName = `cli-bridge-text-only-${randomBytes(8).toString('hex')}`
  const agents = base.agent && typeof base.agent === 'object' && !Array.isArray(base.agent)
    ? { ...(base.agent as Record<string, unknown>) }
    : {}
  const merged: Record<string, unknown> = {
    ...base,
    agent: {
      ...agents,
      [agentName]: { mode: 'primary', permission: { '*': 'deny' } },
    },
  }
  const value = JSON.stringify(merged)
  if (exceedsHostEnvValueLimit(value)) {
    throw new BackendError(
      `the opencode config for this text-only turn is ${value.length} characters and this bridge carries at most `
        + `${MAX_ENV_VALUE_BYTES} in one environment value, so it would not reach the process on the host executor`,
      'parse_error',
    )
  }
  env[OPENCODE_PROCESS_CONFIG_ENV] = value
  return agentName
}
