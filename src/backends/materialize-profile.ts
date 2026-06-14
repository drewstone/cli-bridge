/**
 * materializeProfile — ONE per-harness profile materializer, shared by all three
 * layers (cli-bridge host, agent-dev-container box, VB). It turns a structured
 * AgentProfile into a WorkspacePlan: the exact native files to write into the run
 * workspace (cwd), plus the env/flags some harnesses need because they have NO
 * cwd auto-discovery for certain dimensions.
 *
 * This generalizes the MCP-only materialisers in profile-support.ts to every
 * dimension (context, skills, mcp, hooks, subagents, commands), routed per the
 * VERIFIED capability matrix (workflow harness-capability-matrix, 2026-06-14).
 *
 * FAIL-CLOSED, not silent-drop: when a requested dimension has no path on the
 * chosen harness (e.g. kimi MCP is flag-only, hermes hooks are opt-in global),
 * it is recorded in `plan.unsupported` with the reason — never silently ignored,
 * which is exactly the "looks provisioned, loads nothing" trap.
 *
 * The ONLY trustworthy proof a dimension works is the in-session effect (skill
 * secret word, MCP tool called n>0, hook sentinel file) — see the canary tests.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AgentProfile,
  AgentProfileMcpServer,
  AgentSubagentProfile,
} from '@tangle-network/sandbox'

/** Hook command shape (promoted from agent-dev-container's inline schema). */
export interface HookCommand {
  command: string
  timeoutMs?: number
  blocking?: boolean
  /** Tool/event matcher (claude/gemini settings.json semantics). */
  matcher?: string
  env?: Record<string, string>
}

/** The materializer input: the canonical AgentProfile + the content-bearing
 *  dimensions not yet promoted into the published type (skills/hooks/commands).
 *  When those land in @tangle-network/sandbox the field names already align. */
export interface MaterializableProfile extends AgentProfile {
  /** skill name → SKILL.md content (VB frontmatter or raw markdown; normalized here). */
  skills?: Record<string, string>
  /** hook event (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/…) → commands. */
  hooks?: Record<string, HookCommand[]>
  /** slash-command name → template body. */
  commands?: Record<string, string>
}

export type HarnessId =
  | 'claude-code' | 'claude' | 'claudish' | 'nanoclaw'
  | 'codex' | 'opencode' | 'kimi-code' | 'kimi' | 'pi'
  | 'gemini' | 'hermes' | 'openclaw'

export interface PlanFile {
  relPath: string
  content: string
  /** chmod mode (e.g. 0o755 for hook scripts); default 0o644. */
  mode?: number
}
export interface Unsupported {
  dimension: 'skills' | 'mcp' | 'hooks' | 'subagents' | 'commands' | 'instructions' | 'systemPrompt' | 'permissions' | 'tools'
  reason: string
}
/** The plan a caller writes into the run cwd, then applies to the spawn. */
export interface WorkspacePlan {
  harness: HarnessId
  /** Files to write relative to the run workspace (cwd). */
  files: PlanFile[]
  /** Env vars to set on the spawned process (for harnesses needing them). */
  env: Record<string, string>
  /** Extra CLI flags to pass (e.g. kimi --mcp-config-file <path>). */
  flags: string[]
  /** Dimensions requested but with NO cwd path on this harness — fail-closed record. */
  unsupported: Unsupported[]
}

// ─── Verified per-harness conventions (capability matrix) ───────────────────

/** Project context file each harness actually reads from cwd. NEVER a constant. */
const CONTEXT_FILE: Record<HarnessId, string> = {
  'claude-code': 'CLAUDE.md', claude: 'CLAUDE.md', claudish: 'CLAUDE.md', nanoclaw: 'CLAUDE.md',
  codex: 'AGENTS.md', opencode: 'AGENTS.md', 'kimi-code': 'AGENTS.md', kimi: 'AGENTS.md', pi: 'AGENTS.md',
  gemini: 'GEMINI.md', // current default; AGENTS.md only via .gemini/settings.json context.fileName
  hermes: 'HERMES.md', // highest-priority native name; only ONE context loads (first match)
  openclaw: 'AGENTS.md',
}

/** cwd-relative native skill dir, or null if the harness has no cwd skill primitive. */
const SKILL_DIR: Record<HarnessId, string | null> = {
  'claude-code': '.claude/skills', claude: '.claude/skills', claudish: '.claude/skills', nanoclaw: '.claude/skills',
  codex: '.codex/skills', opencode: '.opencode/skills', 'kimi-code': '.kimi/skills', kimi: '.kimi/skills',
  pi: '.pi/skills', gemini: '.gemini/skills',
  hermes: null, // skills are ~/.hermes/skills (user) only — no cwd discovery
  openclaw: 'skills', // <workspace>/skills/<name>/SKILL.md
}

function canonicalHarness(h: HarnessId): HarnessId {
  if (h === 'claude' || h === 'claudish') return 'claude-code'
  if (h === 'kimi') return 'kimi-code'
  return h
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Normalize any skill markdown (VB frontmatter `skill:`/`description:`, or raw) into a
 *  harness SKILL.md with `name:`/`description:` frontmatter the harnesses require. */
export function normalizeSkillMd(name: string, raw: string): string {
  const m = raw.match(FRONTMATTER_RE)
  const fm = m?.[1] ?? ''
  const body = (m?.[2] ?? raw).trim()
  let desc = `Skill ${name}. Use when the task matches its domain.`
  if (fm) {
    const lines = fm.split('\n')
    const i = lines.findIndex((l) => /^description:/.test(l))
    if (i >= 0) {
      const inline = (lines[i] ?? '').replace(/^description:\s*/, '').trim()
      if (inline && !['>', '|', '>-', '|-'].includes(inline)) desc = collapse(inline)
      else {
        const buf: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const ln = lines[j] ?? ''
          if (/^\s+\S/.test(ln)) buf.push(ln.trim())
          else if (ln.trim() === '') continue
          else break
        }
        if (buf.length) desc = collapse(buf.join(' '))
      }
    }
  }
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`
}

const tomlStr = (s: string) => JSON.stringify(s) // valid TOML basic string

// ─── The materializer ─────────────────────────────────────────────────────────

/**
 * Build the WorkspacePlan for `profile` on `harness`. Pure — no IO. The caller
 * writes plan.files into the run cwd and applies plan.env/plan.flags to the spawn.
 */
export function materializeProfile(
  profile: MaterializableProfile,
  harness: HarnessId,
  opts: { skip?: Unsupported['dimension'][] } = {},
): WorkspacePlan {
  const h = canonicalHarness(harness)
  const skip = new Set(opts.skip ?? [])
  const plan: WorkspacePlan = { harness: h, files: [], env: {}, flags: [], unsupported: [] }
  const add = (relPath: string, content: string, mode?: number) => plan.files.push({ relPath, content, ...(mode ? { mode } : {}) })
  const unsupported = (dimension: Unsupported['dimension'], reason: string) => plan.unsupported.push({ dimension, reason })

  // 1) CONTEXT (instructions + systemPrompt → the harness's native context file).
  const instr: string[] = []
  if (profile.prompt?.systemPrompt) instr.push(profile.prompt.systemPrompt)
  if (profile.prompt?.instructions?.length) instr.push(...profile.prompt.instructions)
  const resInstr = profile.resources?.instructions
  if (typeof resInstr === 'string') instr.push(resInstr)
  else if (resInstr && resInstr.kind === 'inline') instr.push(resInstr.content)
  if (instr.length) {
    add(CONTEXT_FILE[h], `${instr.join('\n\n')}\n`)
    // gemini reads AGENTS.md only via settings; we write GEMINI.md so no extra step.
  }

  // 2) SKILLS → native skill dir, or fail-closed (hermes has no cwd skill dir).
  const skills = profile.skills ?? {}
  for (const [name, raw] of Object.entries(skills)) {
    const dir = SKILL_DIR[h]
    if (!dir) { unsupported('skills', `${h}: no cwd skill dir (skills live in a user/global dir); skill "${name}" not mounted`); continue }
    add(`${dir}/${name}/SKILL.md`, normalizeSkillMd(name, raw))
  }

  // 3) MCP → per-harness format (the divergence the matrix names). Skippable so the
  //    additive host-wiring can leave MCP on cli-bridge's existing per-harness path.
  const mcp = profile.mcp ?? {}
  if (!skip.has('mcp') && Object.keys(mcp).length) materializeMcp(h, mcp, plan, add, unsupported)

  // 4) HOOKS → per-harness format; cwd-native only for claude/codex/gemini/opencode(plugin).
  const hooks = profile.hooks ?? {}
  if (Object.keys(hooks).length) materializeHooks(h, hooks, add, unsupported, plan)

  // 5) SUBAGENTS → cwd-native for claude/codex/opencode/gemini; flag/global elsewhere.
  const subagents = profile.subagents ?? {}
  for (const [name, sa] of Object.entries(subagents)) materializeSubagent(h, name, sa, add, unsupported)

  // 6) COMMANDS → cwd-native for claude/opencode/gemini/pi; "commands are skills" on kimi.
  const commands = profile.commands ?? {}
  for (const [name, body] of Object.entries(commands)) materializeCommand(h, name, body, add, unsupported)

  // Merge multi-writer JSON files (e.g. .claude/settings.json from both mcp and hooks)
  // so the second write can't clobber the first.
  plan.files = mergeJsonFiles(plan.files)
  return plan
}

/** Collapse multiple PlanFiles with the same relPath: top-level-merge JSON, last-wins
 *  for non-JSON. settings.json contributors use disjoint top-level keys, so this unions them. */
function mergeJsonFiles(files: PlanFile[]): PlanFile[] {
  const byPath = new Map<string, PlanFile>()
  for (const f of files) {
    const prev = byPath.get(f.relPath)
    if (!prev) { byPath.set(f.relPath, f); continue }
    if (f.relPath.endsWith('.json')) {
      try {
        const merged = { ...JSON.parse(prev.content), ...JSON.parse(f.content) }
        byPath.set(f.relPath, { ...prev, content: JSON.stringify(merged, null, 2) })
        continue
      } catch { /* fall through to last-wins */ }
    }
    byPath.set(f.relPath, f) // non-JSON or parse-fail: last wins
  }
  return [...byPath.values()]
}

/**
 * Apply a WorkspacePlan to a real workspace dir: write every file (creating parent
 * dirs), and return the env + flags the caller must hand the spawn. This is the IO
 * consumer of the pure `materializeProfile` — used by the cli-bridge host spawn, the
 * agent-dev-container box, and VB. Returns `unsupported` so the caller can log/fail.
 */
export function applyWorkspacePlan(plan: WorkspacePlan, workspaceDir: string): {
  env: Record<string, string>
  flags: string[]
  unsupported: Unsupported[]
  written: string[]
} {
  const written: string[] = []
  for (const f of plan.files) {
    const abs = join(workspaceDir, f.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content, { mode: f.mode ?? 0o644 })
    written.push(f.relPath)
  }
  return { env: plan.env, flags: plan.flags, unsupported: plan.unsupported, written }
}

// ─── Per-dimension routing (verified matrix) ────────────────────────────────

function materializeMcp(
  h: HarnessId,
  mcp: Record<string, AgentProfileMcpServer>,
  plan: WorkspacePlan,
  add: (p: string, c: string, m?: number) => void,
  unsupported: (d: Unsupported['dimension'], r: string) => void,
) {
  switch (h) {
    case 'claude-code': case 'nanoclaw':
      // claude reads ./.mcp.json but each server needs per-project APPROVAL; we also
      // enable them via .claude/settings.json enabledMcpjsonServers to skip the prompt.
      add('.mcp.json', JSON.stringify({ mcpServers: mcp }, null, 2))
      add('.claude/settings.json', JSON.stringify({ enabledMcpjsonServers: Object.keys(mcp) }, null, 2))
      if (h === 'nanoclaw') unsupported('mcp', 'nanoclaw MCP is SDK-injected (options.mcpServers); .mcp.json may be ignored — inject via the SDK adapter')
      break
    case 'codex': {
      // codex reads [mcp_servers.<id>] in .codex/config.toml; trusted projects only.
      const lines = ['[projects."."]', 'trust_level = "trusted"', '']
      for (const [name, s] of Object.entries(mcp)) {
        lines.push(`[mcp_servers.${name}]`)
        if (s.command) lines.push(`command = ${tomlStr(s.command)}`)
        if (s.args?.length) lines.push(`args = [${s.args.map(tomlStr).join(', ')}]`)
        if (s.url) lines.push(`url = ${tomlStr(s.url)}`)
        if (s.env) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }`)
        lines.push('')
      }
      add('.codex/config.toml', lines.join('\n'))
      break
    }
    case 'opencode':
      // opencode.json "mcp" block (local|remote).
      add('opencode.json', JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: opencodeMcp(mcp) }, null, 2))
      break
    case 'gemini':
      add('.gemini/settings.json', JSON.stringify({ mcpServers: mcp }, null, 2))
      break
    case 'kimi-code': {
      // NO cwd auto-discovery — kimi needs an explicit --mcp-config-file FLAG.
      const rel = '.kimi/mcp.json'
      add(rel, JSON.stringify({ mcpServers: mcp }, null, 2))
      plan.flags.push('--mcp-config-file', rel)
      break
    }
    case 'pi':
      unsupported('mcp', 'pi MCP is wired via a TS extension (.pi/extensions/*.ts), not a declarative cwd file — build an extension')
      break
    case 'hermes':
      unsupported('mcp', 'hermes MCP is global config.yaml (mcp_servers), no cwd discovery — write to the hermes global config or pass a config flag')
      break
    case 'openclaw':
      unsupported('mcp', 'openclaw MCP is central ~/.openclaw/openclaw.json (mcp.servers), no cwd discovery')
      break
  }
}

function opencodeMcp(mcp: Record<string, AgentProfileMcpServer>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(mcp)) {
    out[name] = s.url
      ? { type: 'remote', url: s.url, enabled: s.enabled !== false, ...(s.headers ? { headers: s.headers } : {}) }
      : { type: 'local', command: [s.command, ...(s.args ?? [])].filter(Boolean), enabled: s.enabled !== false, ...(s.env ? { environment: s.env } : {}) }
  }
  return out
}

function materializeHooks(
  h: HarnessId,
  hooks: Record<string, HookCommand[]>,
  add: (p: string, c: string, m?: number) => void,
  unsupported: (d: Unsupported['dimension'], r: string) => void,
  plan: WorkspacePlan,
) {
  switch (h) {
    case 'claude-code': case 'nanoclaw': {
      // .claude/settings.json hooks{} — each event → [{matcher, hooks:[{type:command,command}]}].
      const settingsHooks: Record<string, unknown[]> = {}
      for (const [event, cmds] of Object.entries(hooks)) {
        settingsHooks[event] = cmds.map((c) => ({ matcher: c.matcher ?? '*', hooks: [{ type: 'command', command: c.command, ...(c.timeoutMs ? { timeout: Math.round(c.timeoutMs / 1000) } : {}) }] }))
      }
      add('.claude/settings.json', JSON.stringify({ hooks: settingsHooks }, null, 2))
      break
    }
    case 'gemini': {
      const settingsHooks: Record<string, unknown[]> = {}
      for (const [event, cmds] of Object.entries(hooks)) settingsHooks[event] = cmds.map((c) => ({ matcher: c.matcher ?? '*', hooks: [{ type: 'command', command: c.command }] }))
      add('.gemini/settings.json', JSON.stringify({ hooks: settingsHooks }, null, 2))
      break
    }
    case 'codex': {
      // codex hooks.json (event → commands).
      add('.codex/hooks.json', JSON.stringify({ hooks }, null, 2))
      break
    }
    case 'opencode':
      // opencode hooks are PLUGINS (JS/TS), not a settings block — emit a plugin stub.
      for (const [event, cmds] of Object.entries(hooks)) {
        const body = cmds.map((c) => `  // ${event}: ${c.command}`).join('\n')
        add(`.opencode/plugin/vb-hooks-${event}.js`, `// auto-generated hook plugin for ${event}\nexport default async function () {\n${body}\n}\n`)
      }
      unsupported('hooks', 'opencode hooks are JS/TS plugins — generated a stub; a real handler must run the command (format differs from settings.json)')
      break
    case 'kimi-code':
      unsupported('hooks', 'kimi hooks are [[hooks]] in the config TOML loaded via --config-file, not cwd — pass --config-file')
      break
    case 'pi':
      unsupported('hooks', 'pi hooks are TS extensions (.pi/extensions/*.ts) — build an extension')
      break
    case 'hermes': {
      // opt-in project plugins; requires HERMES_ENABLE_PROJECT_PLUGINS=1.
      for (const [event, cmds] of Object.entries(hooks)) add(`.hermes/plugins/vb-${event}/plugin.md`, cmds.map((c) => c.command).join('\n'))
      plan.env.HERMES_ENABLE_PROJECT_PLUGINS = '1'
      break
    }
    case 'openclaw':
      unsupported('hooks', 'openclaw hooks are DISABLED by default — enable in ~/.openclaw/openclaw.json; cwd hooks/ alone is a no-op')
      break
  }
}

function materializeSubagent(
  h: HarnessId, name: string, sa: AgentSubagentProfile,
  add: (p: string, c: string, m?: number) => void,
  unsupported: (d: Unsupported['dimension'], r: string) => void,
) {
  switch (h) {
    case 'claude-code': case 'nanoclaw': {
      const fm = ['---', `name: ${name}`]
      if (sa.description) fm.push(`description: ${JSON.stringify(sa.description)}`)
      if (sa.model) fm.push(`model: ${sa.model}`)
      if (sa.tools) fm.push(`tools: ${Object.keys(sa.tools).filter((t) => sa.tools![t]).join(', ')}`)
      fm.push('---', '', sa.prompt ?? sa.description ?? name)
      add(`.claude/agents/${name}.md`, fm.join('\n') + '\n')
      break
    }
    case 'opencode': {
      const fm = ['---', `description: ${JSON.stringify(sa.description ?? name)}`]
      if (sa.model) fm.push(`model: ${sa.model}`)
      fm.push('---', '', sa.prompt ?? '')
      add(`.opencode/agent/${name}.md`, fm.join('\n') + '\n')
      break
    }
    case 'gemini':
      add(`.gemini/agents/${name}.md`, `---\nname: ${name}\ndescription: ${JSON.stringify(sa.description ?? name)}\n---\n\n${sa.prompt ?? ''}\n`)
      break
    case 'codex': {
      const lines = [`name = ${tomlStr(name)}`]
      if (sa.description) lines.push(`description = ${tomlStr(sa.description)}`)
      if (sa.model) lines.push(`model = ${tomlStr(sa.model)}`)
      if (sa.prompt) lines.push(`prompt = ${tomlStr(sa.prompt)}`)
      add(`.codex/agents/${name}.toml`, lines.join('\n') + '\n')
      break
    }
    default:
      unsupported('subagents', `${h}: subagents have no cwd file (config/flag/global only); "${name}" not mounted`)
  }
}

function materializeCommand(
  h: HarnessId, name: string, body: string,
  add: (p: string, c: string, m?: number) => void,
  unsupported: (d: Unsupported['dimension'], r: string) => void,
) {
  switch (h) {
    case 'claude-code': case 'nanoclaw': add(`.claude/commands/${name}.md`, body.endsWith('\n') ? body : body + '\n'); break
    case 'opencode': add(`.opencode/command/${name}.md`, body.endsWith('\n') ? body : body + '\n'); break
    case 'gemini': add(`.gemini/commands/${name}.toml`, `prompt = ${tomlStr(body)}\n`); break
    case 'pi': add(`.pi/prompts/${name}.md`, body.endsWith('\n') ? body : body + '\n'); break
    case 'kimi-code': unsupported('commands', 'kimi commands ARE skills (/skill:<name>) — provide as a skill instead'); break
    case 'codex': unsupported('commands', 'codex project commands unsupported (~/.codex/prompts is user-global only)'); break
    default: unsupported('commands', `${h}: no cwd command path`)
  }
}
