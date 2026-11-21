import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BackendError } from './types.js'
import { exceedsHostEnvValueLimit, MAX_ENV_VALUE_BYTES } from '../executors/host.js'

/** The environment variable opencode merges as its final local config layer. */
export const OPENCODE_PROCESS_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

/**
 * The `permission` spelling of an explicit text-only turn: every verb `deny`.
 *
 * Measured against opencode 1.18.30 with a local recording provider: a request
 * whose config denies every permission verb carries ZERO ambient action tools,
 * an `allow` verb overrides a `tools: false` entry (the harness resolves a tool
 * as enabled when its permission allows it — the reason #218 needed the deny),
 * and this spelling in a request-scoped `OPENCODE_CONFIG` file beats the same
 * keys set to `allow` in the operator's global config.
 */
export const OPENCODE_TEXT_ONLY_PERMISSION: Readonly<Record<string, 'deny'>> = Object.freeze({
  external_directory: 'deny',
  bash: 'deny',
  edit: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  read: 'deny',
  write: 'deny',
  skill: 'deny',
  task: 'deny',
  todowrite: 'deny',
  webfetch: 'deny',
  lsp: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  question: 'deny',
  doom_loop: 'deny',
})

/**
 * The belt-and-suspenders `tools` spelling: every ambient tool the harness
 * ships is disabled outright. Unknown names in this map are ignored by the
 * harness, so it also covers a tool that has no permission verb.
 */
export const OPENCODE_TEXT_ONLY_TOOLS: Readonly<Record<string, false>> = Object.freeze({
  bash: false,
  edit: false,
  glob: false,
  grep: false,
  list: false,
  read: false,
  write: false,
  skill: false,
  task: false,
  todowrite: false,
  webfetch: false,
})

/** A plain object record, or an empty record for every other shape. */
function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Put the zero-tool surface into opencode's FINAL config layer.
 *
 * `OPENCODE_CONFIG_CONTENT` is merged last, above both the operator's global
 * config and the request-scoped `OPENCODE_CONFIG` file. Every channel that can
 * put a tool back on the wire was measured against the real runner
 * (opencode 1.18.30, local recording provider) and is closed here:
 *
 *  - a permission `allow` verb overrides `tools: false` (#218), and a global
 *    `agent.build.tools: true` map reintroduces every ambient tool even under a
 *    top-level deny — the final layer replaces `permission` and `tools`
 *    wholesale AND pins `agent.build.permission` to deny-everything, which beats
 *    the agent tools map;
 *  - `default_agent` is pinned to `build` so a configured custom primary agent
 *    (with its own tool set) cannot be selected;
 *  - an MCP server named by the ambient content or the operator's global config
 *    survives `mcp: {}` (the mcp key deep-merges per server), so every
 *    enumerable server name is written `enabled: false` — the one spelling that
 *    removed it from the wire;
 *  - the project layer (`<cwd>/opencode.json`, which can declare its own
 *    servers) is disabled outright with `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
 *
 * A `tool_choice: "none"` request is the standard no-model-tool-calls request:
 * caller-bound MCP servers are suppressed for the turn too (analysis/trace
 * callbacks belong outside the nested model call, on their own authority), and
 * the bridge does not mount any server it was asked to carry. Restriction wins
 * by construction; unrelated config keys (provider, instructions, ...) are
 * preserved. When an upstream configuration cannot be enumerated — an
 * operator's global config that is not valid JSON — the turn is refused before
 * dispatch rather than run with an unknown MCP surface.
 */
export function overlayOpencodeTextOnlyToolSurface(env: Record<string, string>): void {
  const current = env[OPENCODE_PROCESS_CONFIG_ENV] ?? process.env[OPENCODE_PROCESS_CONFIG_ENV]
  let base: Record<string, unknown> = {}
  if (current !== undefined && current.length > 0) {
    base = parseProcessConfig(current)
  }
  const disabledServers = disabledMcpServerNames(base, env)
  const baseAgent = objectRecord(base.agent)
  const baseMcp = objectRecord(base.mcp)
  const merged: Record<string, unknown> = {
    ...base,
    permission: OPENCODE_TEXT_ONLY_PERMISSION,
    tools: OPENCODE_TEXT_ONLY_TOOLS,
    agent: {
      ...baseAgent,
      build: { ...objectRecord(baseAgent.build), permission: OPENCODE_TEXT_ONLY_PERMISSION },
    },
    default_agent: 'build',
    mcp: {
      ...baseMcp,
      ...Object.fromEntries([...disabledServers].map((name) => [name, { enabled: false }])),
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
  // The project layer can mount its own MCP servers from the run's cwd; a
  // text-only turn has no project layer. Profiled turns already carry this.
  env.OPENCODE_DISABLE_PROJECT_CONFIG ??= '1'
}

/** Parse the existing final-layer config, refusing values the overlay cannot build on. */
function parseProcessConfig(current: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>
}

/**
 * Every MCP server name a text-only turn must disable: those named by the
 * ambient/final config base, and those declared by the operator's global
 * opencode config (resolved against the environment the child will see).
 *
 * The global config is the one input the bridge does not author. When the file
 * exists but cannot be parsed as an object, its server set is unknowable, so
 * the turn is refused before dispatch — never run with an unenumerated surface.
 */
function disabledMcpServerNames(base: Record<string, unknown>, env: Record<string, string>): Set<string> {
  const names = new Set(Object.keys(objectRecord(base.mcp)))
  const configHome = env.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME
    || join(env.HOME || process.env.HOME || homedir(), '.config')
  const globalPath = join(configHome, 'opencode', 'opencode.json')
  let raw: string
  try {
    raw = readFileSync(globalPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return names
    throw new BackendError(
      'backend opencode cannot enforce tool_choice "none": the operator\'s global config '
        + `${globalPath} exists but cannot be read (${code ?? 'unknown error'}), so its MCP server set is `
        + 'unknowable; correct or remove it before requesting a text-only turn',
      'not_configured',
      undefined,
      { providerDispatch: 'not_started' },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new BackendError(
      'backend opencode cannot enforce tool_choice "none": the operator\'s global config '
        + `${globalPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}), `
        + 'so its MCP server set is unknowable; correct or remove it before requesting a text-only turn',
      'not_configured',
      undefined,
      { providerDispatch: 'not_started' },
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackendError(
      'backend opencode cannot enforce tool_choice "none": the operator\'s global config '
        + `${globalPath} is not a JSON object, so its MCP server set is unknowable; correct or remove it `
        + 'before requesting a text-only turn',
      'not_configured',
      undefined,
      { providerDispatch: 'not_started' },
    )
  }
  for (const name of Object.keys(objectRecord((parsed as Record<string, unknown>).mcp))) {
    names.add(name)
  }
  return names
}
