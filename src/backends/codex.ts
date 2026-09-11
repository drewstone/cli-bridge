/**
 * Codex CLI backend — spawns `codex exec --json` and translates its
 * JSONL event stream to OpenAI chat deltas.
 *
 * Model id scheme: `codex/<model>` where `<model>` is the Codex model
 * alias. Passed via `-c model="<model>"` config override. Bare `codex`
 * uses the subscription's default.
 *
 * Session resume: the external session id maps (via SessionStore) to a
 * Codex thread_id (UUID, reported on the `thread.started` event).
 * Subsequent calls invoke `codex exec resume <thread_id>` so Codex
 * loads prior context.
 *
 * Event shapes we parse (from `codex exec --json` JSONL):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"message","content":{"text":"..."}}         — best-effort
 *   {"type":"item.completed","item":{"type":"message",…}} — best-effort
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"error","message":"..."}
 *
 * The message-content field names vary across codex versions. We
 * defensively pull `.content`, `.text`, `.message`, `.item.content`,
 * `.item.text` etc — whatever has a string. If Codex changes the shape
 * again, adjust `extractText` below rather than the whole pipeline.
 */

import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ensurePrivateDataDirectory } from '../runtime/single-instance.js'
import type { Backend, BackendFailureReason, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { versionHealth } from './health.js'
import { BackendError, BRIDGE_RESERVED_FAILURE_CODES, terminalOutcome } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  materializeMcpServersForCodex,
  profileExecutionIdentity,
  provisionProfileWorkspace,
  resolveMcpServers,
  resolvePromptMessages,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { describeCliExit, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { nativeReasoningControl } from '@tangle-network/agent-interface'

export interface CodexBackendOptions {
  bin: string
  timeoutMs: number
  /** Bridge-owned native state; session execution leases serialize access. */
  stateDir?: string
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class CodexBackend implements Backend {
  readonly name = 'codex'
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner
  constructor(private readonly opts: CodexBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'codex' || m.startsWith('codex/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    // Codex has `--sandbox` flags but we haven't verified end-to-end that
    // every FS/shell tool is gated under read-only. Reject hosted-safe
    // until that audit lands — never fake safety.
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'codex hosted-safe requires verified --sandbox read-only audit')

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session, 'codex'))
    // The canonical wire id is `codex/<provider>/<model>` (agent-runtime's
    // profileBridgeWireModel). Codex config keys the two separately: the
    // provider segment selects `model_provider` (endpoint identity, 'openai'
    // is the builtin default) and only the remainder is the `model` id —
    // passing the qualified form verbatim was rejected by the API as a
    // nonexistent model, killing every profile-declared codex lead.
    const { provider: splitProvider, model: modelArg } = splitCodexModel(this.extractModel(req.model))
    // #161: the harness name is never a codex provider. A caller composes one harness prefix
    // and spends a provider equal to the harness there, so a second `codex/` segment restates
    // the harness rather than naming a `[model_providers.*]` key — passing it on made codex
    // resolve a provider that no config.toml defines. Dropped here, where the argv is built,
    // so the rule holds for an unprofiled request too; a profile comparison never sees one.
    const providerArg = splitProvider === this.name ? null : splitProvider

    // Build argv. `codex exec resume <id> <prompt>` if we have one,
    // else `codex exec <prompt>`. --json emits JSONL events.
    const args: string[] = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]
    if (providerArg) args.push('-c', `model_provider="${providerArg}"`)
    if (modelArg) args.push('-c', `model="${modelArg}"`)
    const reasoningEffort = nativeReasoningControl(
      'codex',
      resolveRequestedReasoningEffort(req, session),
    )
    if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)

    if (session?.internalId) {
      args.splice(1, 0, 'resume', session.internalId)
      // codex exec resume <id> [prompt]
    }
    args.push(prompt)

    // Reject unsupported profile plans before copying auth or writing MCP
    // credentials into a synthetic CODEX_HOME.
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'codex',
      cwd,
      profileExecutionIdentity(req, session, 'codex', reasoningEffort),
    )
    args.push(...provisioned.flags)

    // Session leases own this directory's read/execute/update interval.
    // Keep native state across turns, but regenerate MCP config and auth each time.
    const mcpServers = resolveMcpServers(req, session)
    const externalId = req.session_id ?? session?.externalId
    const nativeHome = this.opts.stateDir && externalId
      ? join(this.opts.stateDir, createHash('sha256').update(externalId).digest('hex'))
      : undefined
    const legacySession = nativeHome && session?.internalId && !existsSync(nativeHome)
    if (legacySession && mcpServers) {
      throw new BackendError(
        'Codex session has no retained native home; cannot attach MCP without losing its thread. ' +
        'Continue an existing no-MCP session without MCP, or start a new external session with retained context.',
        'parse_error',
      )
    }
    const codexHome = materializeMcpServersForCodex(
      mcpServers,
      resolveCodexAuthPath(),
      nativeHome && !legacySession
        ? ensurePrivateDataDirectory(nativeHome)
        : undefined,
    )

    // When MCP passthrough is active, the synthetic CODEX_HOME (selected MCP config
    // + copied auth) is the source of truth. Register it as the jail's codex auth
    // source so a CONFINED run gets it surfaced inside the jail with CODEX_HOME
    // redirected there. Seeded WRITABLE: codex must write PATH aliases,
    // app-server state, and session
    // rollouts inside its home before it can run at all. The jail applies this
    // only when it actually wraps; on docker/fallback paths the host
    // `CODEX_HOME` env below is used unchanged.
    if (req.jailSpec && codexHome) {
      req.jailSpec.authSources = [
        ...(req.jailSpec.authSources ?? []).filter((s) => s.envVar !== 'CODEX_HOME'),
        {
          source: codexHome.homePath,
          jailRel: '.codex',
          mode: 'seed-writable',
          only: ['auth.json', 'config.toml'],
          envVar: 'CODEX_HOME',
        },
      ]
    }

    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: {
          ...process.env,
          ...provisioned.env,
          ...(codexHome ? { CODEX_HOME: codexHome.homePath } : {}),
        },
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    } catch (error) {
      codexHome?.cleanup()
      throw error
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    // The spawner registers a synchronous 'error' listener so the spawn
    // failure event doesn't crash the process before our own listener
    // can attach. We consult the captured value here (and double-attach
    // for safety against future spawner refactors).
    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // The durable run owns the deadline and delivers it through this signal.
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    let emittedToolCall = false
    try {
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      child.stderr?.on('data', (b) => { stderr.append(b) })
      if (spawnErrorMessage) {
        throw new BackendError(`codex spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('codex subprocess has no stdout pipe', 'upstream')
      }
      let sawError: BackendFailureReason | null = null

      for await (const event of readProcessLines({ child, stdout: child.stdout })) {
        if (event.kind !== 'line') continue
        const line = event.line
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        const type = String(ev.type ?? '')

        if (type === 'thread.started' && typeof ev.thread_id === 'string') {
          internalSessionId = ev.thread_id
          yield { internal_session_id: internalSessionId }
          continue
        }

        if (type === 'error') {
          sawError = codexFailureReason(ev)
          continue
        }

        const toolCall = extractToolCall(ev)
        if (toolCall) {
          yield { tool_calls: [toolCall] }
          emittedToolCall = true
          // Fall through to extractText: a tool item can also carry a
          // string result payload, which consumers audit as evidence.
        }

        const text = extractText(ev)
        if (text) {
          yield { content: text }
        }

        if (type === 'turn.completed' || type === 'thread.completed') {
          const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
          yield {
            ...terminalOutcome('codex', sawError, emittedToolCall),
            usage,
            internal_session_id: internalSessionId,
          }
          return
        }
      }

      const exitCode = await waitForProcessClose(child)

      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }
      if (sawError) {
        // Ended through the delta envelope, not a throw: `BackendError.code` is the
        // bridge's own closed taxonomy and cannot carry a provider discriminant, while
        // the terminal error delta reaches the caller with it. The route answers both
        // shapes 502 (`BackendReportedFailureError`), so only the code is new.
        yield { ...terminalOutcome('codex', sawError, emittedToolCall), internal_session_id: internalSessionId }
        return
      }
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(await describeCliExit(spawned, 'codex', exitCode, stderr.render()), 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop', internal_session_id: internalSessionId }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree — codex spawns sub-processes for MCP
      // tool calls, model HTTP I/O, etc. and we owe them a clean exit.
      await terminateSpawned(spawned)
      releaseSpawner()
      codexHome?.cleanup()
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'codex') return null
    // `codex/default` is the alias for "no model override; let codex
    // CLI use whatever ~/.codex/config.toml resolves to". Returning
    // null here suppresses the `-c model="..."` flag in chat() so the
    // call works on accounts without entitlement for the gated alias.
    if (lower === 'codex/default') return null
    if (lower.startsWith('codex/')) {
      const rest = fullModel.slice('codex/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}

/**
 * Split a provider-qualified codex model remainder (`openai/gpt-5.1-codex`)
 * into its `model_provider` / `model` config pair. A remainder with no slash
 * is a bare model id under the account's default provider. Codex model ids
 * themselves never contain `/` (OSS variants use `:`), so the first segment
 * is always the provider when a slash is present.
 */
export function splitCodexModel(
  remainder: string | null,
): { provider: string | null; model: string | null } {
  if (!remainder) return { provider: null, model: null }
  const slash = remainder.indexOf('/')
  if (slash <= 0) return { provider: null, model: remainder }
  return { provider: remainder.slice(0, slash), model: remainder.slice(slash + 1) }
}


/**
 * Path to the user's persistent codex auth.json. cli-bridge points
 * codex at a synthetic CODEX_HOME for MCP passthrough, but the spawned
 * codex still needs to authenticate as the operator. Honors a
 * `CODEX_HOME` already set on cli-bridge's env so admins can pin a
 * custom location. Falls back to `$HOME/.codex/auth.json` which is
 * where `codex login` writes by default.
 */
function resolveCodexAuthPath(): string | undefined {
  const home = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, '.codex') : undefined)
  return home ? join(home, 'auth.json') : undefined
}

/**
 * Read one codex failure event as a reason a caller can branch on.
 *
 * Codex states the same refusal in two places and the bridge sees both. It sets
 * its own `CodexErrorInfo` discriminant — `server_overloaded` (410),
 * `response_too_many_failed_attempts` (309), `other` (164),
 * `usage_limit_exceeded` (92) and `unauthorized` (8) across the 983 refusals
 * recorded on this machine — and where the refusal came over the wire it quotes
 * the provider's JSON body inside the message text, which is where
 * `invalid_request_error` and its `code` live.
 *
 * Both were flattened into one opaque `upstream` string, which made a capacity
 * refusal that clears on its own indistinguishable from a request that will
 * fail identically forever — the difference between waiting and giving up.
 * agent-runtime reads the relayed `type` as `upstreamCode` and the relayed
 * `status` through its own classifier, which is what ends the retry loop on a
 * malformed request instead of re-driving it to the attempt ceiling.
 *
 * Permissive on shape for the same reason `extractText` is: codex's field
 * naming has drifted across versions, and a reason with no code is still a
 * reason. An unrecognized payload keeps `upstream` and the CLI's own words.
 */
export function codexFailureReason(ev: Record<string, unknown>): BackendFailureReason {
  const message = firstString(ev.message) ?? 'codex error'
  const codexCode = codexErrorDiscriminant(ev.codex_error_info)
  const variant = codexErrorVariantPayload(ev.codex_error_info)
  const provider = providerErrorBody(message)
  const providerCode = firstString(provider?.body.type, provider?.body.code)
  // `other` is codex declining to classify, so it must not outrank a code the
  // provider did state: 20 of the 983 recorded refusals are a malformed request
  // whose body names `invalid_request_error` under an `other` discriminant. It
  // still beats nothing when the body names no code either.
  const relayed = codexCode === CODEX_UNCLASSIFIED
    ? relayableCode(providerCode) ?? relayableCode(codexCode)
    : relayableCode(codexCode) ?? relayableCode(providerCode)
  // Both structured channels, and only those: the variant payload's own
  // `http_status_code` (429 on every recorded rate-limit refusal) and the status
  // the provider's wrapper states beside its body (400 on the recorded malformed
  // requests). Codex also names a status in prose on 139 of the 983, and that one
  // is left alone — agent-runtime already reads a status out of message text, and
  // a second scraper here would only disagree with it.
  const status = httpStatus(variant?.http_status_code) ?? httpStatus(provider?.status)
  return {
    message,
    type: relayed ?? 'upstream',
    ...(status === undefined ? {} : { status }),
  }
}

/**
 * A code the bridge may relay as its own failure type, or undefined.
 *
 * The relay channel is shared with the bridge's own taxonomy: the route answers
 * 504 for `timeout` and 502 for everything else, and agent-runtime treats
 * `parse_error`, `not_configured` and `capability_denied` as never-retry. The
 * text on this channel comes from a provider, so a body that quotes one of those
 * words would otherwise decide the bridge's status and the caller's retry.
 * Refusing the collision costs only the code — the CLI's own words still reach
 * the caller in `message`.
 */
function relayableCode(code: string | undefined): string | undefined {
  return code === undefined || BRIDGE_RESERVED_FAILURE_CODES.has(code) ? undefined : code
}

/** A status a provider actually stated, within the range HTTP defines. */
function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

/** Codex's own discriminant for a failure it did not classify. */
const CODEX_UNCLASSIFIED = 'other'

/**
 * The `CodexErrorInfo` variant codex named, from either form it serializes.
 *
 * A unit variant is a bare string (`server_overloaded`, `usage_limit_exceeded`,
 * `unauthorized`, `other`); a variant that carries data is a single-key object,
 * and the 429 codex reports after exhausting its retries is
 * `{"response_too_many_failed_attempts":{"http_status_code":429}}` — no `type`
 * and no `code` field, so reading only those lost the most common classified
 * refusal in the recordings (309 of 983).
 */
function codexErrorDiscriminant(value: unknown): string | undefined {
  const bare = firstString(value)
  if (bare !== undefined) return bare
  const info = asRecord(value)
  if (!info) return undefined
  const named = firstString(info.type, info.code)
  if (named !== undefined) return named
  const keys = Object.keys(info)
  return keys.length === 1 ? keys[0] : undefined
}

/**
 * The fields a data-carrying `CodexErrorInfo` variant holds.
 *
 * They sit one level UNDER the variant key, which is the same nesting
 * {@link codexErrorDiscriminant} reads the key from — every field a caller wants
 * from this channel has to come through here, or it reads a shape serde never
 * writes. A unit variant is a bare string and carries no fields at all.
 */
function codexErrorVariantPayload(value: unknown): Record<string, unknown> | null {
  const info = asRecord(value)
  if (!info) return null
  const keys = Object.keys(info)
  return keys.length === 1 ? asRecord(info[keys[0]!]) : null
}

/**
 * The provider's own error body, quoted inside a codex message, with the status
 * its wrapper states beside it.
 *
 * Codex wraps it in its own prose (`unexpected status 400, url: …, cf-ray: …:
 * <body>`), and the prose continues after it on some paths, so the body is read
 * as a balanced object rather than as the tail of the string. Each `{` is tried
 * in turn because the prose before it may itself contain a brace; the attempt
 * count is bounded so a message full of braces cannot become quadratic.
 *
 * A codex message also quotes tool output and assistant text, so a parseable
 * object is not yet a provider error: the candidate must carry an `error` object
 * or name its own class beside a message. Without that test, a tool call echoed
 * into the prose supplied the code the bridge relayed.
 */
function providerErrorBody(
  message: string,
): { body: Record<string, unknown>; status: unknown } | null {
  let attempts = 0
  for (let at = message.indexOf('{'); at !== -1 && attempts < 8; at = message.indexOf('{', at + 1)) {
    attempts += 1
    const candidate = balancedObjectAt(message, at)
    if (candidate === null) continue
    let parsed: unknown
    try { parsed = JSON.parse(candidate) } catch { continue }
    const wrapper = asRecord(parsed)
    if (!wrapper) continue
    // `{"error":{…},"status":400}` is the wrapper the provider sends; a bare body is
    // also accepted, and then the wrapper IS the body.
    const nested = asRecord(wrapper.error)
    const body = nested ?? wrapper
    const namesItsOwnClass = firstString(body.type, body.code) !== undefined
      && typeof body.message === 'string'
    if (nested === null && !namesItsOwnClass) continue
    return { body, status: wrapper.status }
  }
  return null
}

/** The `{…}` span starting at `from`, or null when it never closes. String-aware. */
function balancedObjectAt(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Item types that carry tool activity rather than assistant text.
 * `codex exec --json` reports each tool invocation as an
 * `item.completed` whose `item.type` names the tool class:
 *   command_execution — {command, aggregated_output, exit_code, status}
 *   mcp_tool_call     — {server, tool, arguments?, status}
 *   web_search        — {query}
 *   file_change       — {changes:[{path,kind}], status}
 * These must surface as ChatDelta.tool_calls (not flattened to text):
 * downstream consumers audit tool usage per call — a treatment gate
 * cannot distinguish "agent never searched" from "stream dropped the
 * call" unless the call is a first-class delta.
 */
function extractToolCall(
  ev: Record<string, unknown>,
): { id: string; name: string; arguments: string } | null {
  if (String(ev.type ?? '') !== 'item.completed') return null
  const item = ev.item as Record<string, unknown> | undefined
  if (!item) return null
  const itemType = String(item.type ?? '')
  const id = String(item.id ?? '')
  switch (itemType) {
    case 'command_execution':
      return {
        id,
        name: 'bash',
        arguments: JSON.stringify({ command: item.command ?? '' }),
      }
    case 'mcp_tool_call': {
      const server = String(item.server ?? '')
      const tool = String(item.tool ?? '')
      if (!server && !tool) return null
      // Matches the MCP convention consumers key on: <server>_<tool>.
      const name = server && tool ? `${server}_${tool}` : server || tool
      const args = item.arguments ?? {}
      return {
        id,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      }
    }
    case 'web_search':
      return {
        id,
        name: 'websearch',
        arguments: JSON.stringify({ query: item.query ?? '' }),
      }
    case 'file_change':
      return {
        id,
        name: 'apply_patch',
        arguments: JSON.stringify({ changes: item.changes ?? [] }),
      }
    default:
      return null
  }
}

/**
 * Pull any message-shaped text out of a codex event. Intentionally
 * permissive — codex's field naming has drifted across versions, and
 * we'd rather capture text from a slightly-wrong shape than silently
 * drop it.
 */
function extractText(ev: Record<string, unknown>): string | null {
  // Common patterns we've seen
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.item as Record<string, unknown> | undefined)?.text,
    (ev.item as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}
