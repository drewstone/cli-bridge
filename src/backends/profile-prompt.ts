import { join } from 'node:path'
import type {
  AgentProfile,
} from '@tangle-network/agent-interface'
import type { ChatMessage, ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { resolveAgentProfile } from './profile-support.js'

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

  const resources = pickDeclaredResources((profile as Record<string, unknown>).resources)
  if (resources.length) {
    sections.push(`Caller-declared resources for this session: ${resources.join(', ')}`)
  }

  const permissionSummary = renderPermissions((profile as Record<string, unknown>).permissions)
  if (permissionSummary) {
    sections.push(`Requested permission posture: ${permissionSummary}`)
  }

  return sections.length ? sections.join('\n\n') : null
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

/**
 * The resource kinds a profile actually declares.
 *
 * `AgentProfileResources` mixes resource kinds (`files`, `skills`,
 * `instructions`, ...) with materialization options such as `failOnError`.
 * An option is a scalar, never content, so only a kind holding at least one
 * resource is named; the model was being told `failOnError` was a resource.
 */
function pickDeclaredResources(value: unknown): string[] {
  if (Array.isArray(value) || !value || typeof value !== 'object') return pickNamedEntries(value)
  return Object.entries(value as Record<string, unknown>)
    .filter(([, declared]) => holdsResource(declared))
    .map(([kind]) => kind)
}

function holdsResource(declared: unknown): boolean {
  if (Array.isArray(declared)) return declared.length > 0
  if (typeof declared === 'string') return declared.trim().length > 0
  return declared !== null && typeof declared === 'object'
}

function renderPermissions(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}=${v}`)
  return entries.length ? entries.join(', ') : null
}
