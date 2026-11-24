/**
 * Translation of one native provider turn into canonical runtime events.
 *
 * Anything the translator does not recognise is forwarded as a `raw` event
 * rather than dropped, so a provider that grows a new event shape degrades to
 * an opaque record instead of a silent gap in the transcript.
 */

import {
  DurablePlanSchema,
  InteractionRequestSchema,
  canonicalCandidateDigest,
  interactionRequestDigest,
  permissionAnswerSpec,
  type AgentEnvironmentEvent,
  type DurablePlan,
  type InteractionRequest,
  type InteractionRequestMaterial,
  type InteractionResponse,
  type Part,
  type RequestedInteractions,
  type StreamEvent,
  type ToolState,
} from '@tangle-network/agent-interface'
import type { NativeSession } from '../../backends/types.js'
import {
  mergePiResponseIdentity,
  piResponseIdentityDelta,
  piResponseIdentityFromEvent,
  piUsageReceiptsFromEvent,
  type PiResponseIdentity,
  type PiUsageReceipt,
} from '../../backends/pi.js'
import type { Run } from '../../runs/registry.js'
import { piPermissionPublicTitle, piPermissionTokenFromTitle } from '../../backends/pi-interaction.js'
import { normalizeClaudeUsage, sanitizeUpstreamErrorDetail, type ClaudeNativeUsage } from '../../backends/claude.js'
import { CLAUDE_TURN_SETTLED, ClaudeNativeSession } from '../../backends/claude-native-session.js'
import { ACP_PERMISSION, ACP_TURN_SETTLED, AcpNativeSession } from '../../backends/acp-native-session.js'
import { CODEX_TURN_SETTLED, CodexNativeSession, isCodexToolApproval } from '../../backends/codex-native-session.js'
import { KIMI_TURN_SETTLED, KimiNativeSession } from '../../backends/kimi-native-session.js'
import { OPENCLAW_REPLY, OPENCLAW_TURN_SETTLED, OpenclawNativeSession } from '../../backends/openclaw-native-session.js'
import { OPENCODE_TURN_SETTLED, OpencodeNativeSession } from '../../backends/opencode-native-session.js'
import { opencodeStepUsage } from '../../backends/opencode.js'
import { numberValue, recordValue, stringValue } from './json-values.js'

export interface NativeTurnInput {
  native: NativeSession
  run: Run
  sessionId: string
  prompt: string
  backendName: string
  providerName: string
  environmentId: string
  interactions: RequestedInteractions
  /**
   * Who answers permission prompts. `unattended-allow` and `unattended-deny` make the Bridge
   * answer each one itself, so an unattended run gets what a one-shot turn already has.
   */
  interactionPolicy: 'interactive' | 'unattended-deny' | 'unattended-allow'
  /** Answer provider UI for the Bridge: what the turn did not admit is denied. */
  answerInteraction: (input: {
    run: Run
    request: InteractionRequest
    nativeId: string
  }, decision: 'allow' | 'deny') => Promise<void>
  /** The provider disclosed its own session id; record it before continuing. */
  onProviderSessionId: (providerSessionId: string) => void
}

/**
 * The one turn driver: it owns the loop, the raw fallback, deferred denials
 * and the failing catch. Pi's step is inline below; Claude's is `claudeStep`, opencode's `opencodeStep`, Kimi's `kimiStep`,
 * Codex's `codexStep`.
 */
export async function* canonicalTurn(input: NativeTurnInput): AsyncIterable<{ event: StreamEvent }> {
  const { native, run, sessionId, prompt, backendName } = input
  yield { event: { type: 'status', status: 'started' } }
  const text = new Map<number, string>()
  const reasoning = new Map<number, string>()
  const toolParts = new Map<string, Part>()
  let nextContentIndex = 0
  let lastTurnFailure: string | null = null
  let responseIdentity: PiResponseIdentity | undefined
  const deferredDenials: Promise<void>[] = []
  const claude = native instanceof ClaudeNativeSession ? claudeStep(input, native, deferredDenials)
    : native instanceof OpencodeNativeSession ? opencodeStep(input, native, deferredDenials)
    : native instanceof KimiNativeSession ? kimiStep(input, native, deferredDenials)
    : native instanceof CodexNativeSession ? codexStep(input, native, deferredDenials)
    : native instanceof AcpNativeSession ? acpStep(input, native, deferredDenials)
    : native instanceof OpenclawNativeSession ? openclawStep(input) : null
  try {
    for await (const raw of native.turn(prompt, run.signal)) {
      const event = recordValue(raw)
      if (!event) {
        yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      if (claude) {
        for (const translated of claude(event) ?? [{ type: 'raw', backend: backendName, event: raw } satisfies StreamEvent]) yield { event: translated }
        continue
      }
      const type = String(event.type ?? '')
      const observedIdentity = piResponseIdentityFromEvent(event)
      if (observedIdentity) {
        const merged = mergePiResponseIdentity(responseIdentity, observedIdentity)
        if (merged.model !== responseIdentity?.model || merged.systemFingerprint !== responseIdentity?.systemFingerprint) {
          // Preserve the same explicit provider observation as the one-shot path.
          // Configured native models and compatibility routes never enter this projection.
          yield { event: { type: 'raw', backend: backendName, event: {
            type: 'raw', data: piResponseIdentityDelta(merged),
          } } }
        }
        responseIdentity = merged
      }
      if (type === 'session') {
        if (typeof event.id === 'string') input.onProviderSessionId(event.id)
        if (typeof event.id === 'string')
          yield {
            event: { type: 'session.updated', sessionId: boundedRuntimeId(event.id), time: { updated: Date.now() } },
          }
        continue
      }
      if (type === 'agent_start') {
        yield { event: { type: 'status', status: 'started' } }
        continue
      }
      if (type === 'turn_start') {
        yield { event: { type: 'status', status: 'processing' } }
        continue
      }
      if (type === 'message_update') {
        const messageEvent = recordValue(event.assistantMessageEvent)
        if (!messageEvent) {
          yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        const messageType = String(messageEvent.type ?? '').replace(/-/g, '_')
        const index = numberValue(messageEvent.contentIndex ?? messageEvent.content_index) ?? nextContentIndex
        nextContentIndex = Math.max(nextContentIndex, index + 1)
        const delta = typeof messageEvent.delta === 'string' ? messageEvent.delta : ''
        if (messageType === 'text_start' || messageType === 'text_delta' || messageType === 'text_end') {
          const current = `${text.get(index) ?? ''}${messageType === 'text_delta' ? delta : messageType === 'text_start' ? '' : ''}`
          text.set(index, current)
          yield {
            event: textEvent(sessionId, run.id, index, current, messageType === 'text_delta' ? delta : undefined),
          }
          continue
        }
        if (messageType === 'thinking_start' || messageType === 'thinking_delta' || messageType === 'thinking_end') {
          const current = `${reasoning.get(index) ?? ''}${messageType === 'thinking_delta' ? delta : ''}`
          reasoning.set(index, current)
          yield {
            event: reasoningEvent(
              sessionId,
              run.id,
              index,
              current,
              messageType === 'thinking_delta' ? delta : undefined,
            ),
          }
          continue
        }
        if (messageType.includes('toolcall') || messageType.includes('tool_call')) {
          const tool = toolFromNative(messageEvent)
          if (tool) {
            const part = toolPart(sessionId, run.id, tool.id, tool.name, tool.args, 'pending')
            toolParts.set(tool.id, part)
            yield { event: { type: 'message.part.updated', part } }
          }
          continue
        }
        yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
        const tool = toolFromNative(event)
        if (tool) {
          const status =
            type === 'tool_execution_start'
              ? 'running'
              : type === 'tool_execution_end'
                ? event.isError
                  ? 'error'
                  : 'completed'
                : 'running'
          const part = toolPart(sessionId, run.id, tool.id, tool.name, tool.args, status, event)
          toolParts.set(tool.id, part)
          yield { event: { type: 'message.part.updated', part } }
        } else yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      if (type === 'extension_ui_request') {
        const interaction = interactionFromPi(
          run,
          event,
          sessionId,
          input.providerName,
          input.environmentId,
        )
        if (interaction) {
          yield { event: admitInteraction(input, interaction, deferredDenials) }
        } else if (isFireAndForgetUi(event)) {
          yield { event: { type: 'raw', backend: backendName, event: raw } }
        } else {
          yield {
            event: {
              type: 'warning',
              code: 'unsupported_interaction',
              message: 'Pi emitted an interaction shape cli-bridge cannot answer safely',
            },
          }
        }
        continue
      }
      if (type === 'turn_end') {
        lastTurnFailure = nativeTurnFailure(event.message)
        for (const receipt of piUsageReceiptsFromEvent(event)) {
          yield { event: { type: 'raw', backend: backendName, event: usageEnvironmentEvent(receipt, responseIdentity) } }
        }
        yield { event: { type: 'model-processing', phase: 'generating' } }
        continue
      }
      if (type === 'plan' || type === 'plan_submitted') {
        const plan = recordValue(event.plan)
        const parsedPlan = durablePlanFromNative(plan)
        if (parsedPlan) {
          yield { event: { type: 'plan.submitted', plan: parsedPlan } }
        } else yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      if (type === 'error' || event.error) {
        lastTurnFailure = String(event.message ?? recordValue(event.error)?.message ?? 'pi error')
        yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      if (type === 'agent_end') {
        // Pi may retry or compact after this low-level boundary. Keep the
        // provider record, but wait for agent_settled before publishing a
        // canonical terminal status.
        yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      // A successfully handled Pi prompt never starts an agent run and has
      // no agent_settled event. Its response completes the admitted HTTP turn.
      if (type === 'agent_settled' || (
        type === 'response' && event.command === 'prompt' && event.success === true
        && recordValue(event.data)?.disposition === 'handled'
      )) {
        yield { event: settledStatus(lastTurnFailure) }
        continue
      }
      yield { event: { type: 'raw', backend: backendName, event: raw } }
    }
    await Promise.all(deferredDenials)
  } catch (thrown) {
    // An answer the Bridge could not deliver aborts the native turn; report that cause, not the abort.
    const answerFailure = (await Promise.allSettled(deferredDenials))
      .find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason
    const error = answerFailure ?? thrown
    if (!run.signal.aborted)
      yield {
        event: { type: 'status', status: 'failed', detail: error instanceof Error ? error.message : String(error) },
      }
    throw error
  }
}

/**
 * Publish a provider dialog this turn requested, deny one it did not, or answer a permission
 * prompt as the turn's unattended policy says. The Bridge's answer waits one tick so the
 * provider has resumed from the yielded request (Pi installs its response waiter on that resume).
 */
function admitInteraction(
  input: NativeTurnInput,
  interaction: { request: InteractionRequest; nativeId: string },
  deferredDenials: Promise<void>[],
): StreamEvent {
  const byPolicy = interaction.request.kind === 'permission' && input.interactionPolicy !== 'interactive'
  const requested = (input.interactions as Readonly<Record<string, boolean | undefined>>)[interaction.request.kind] === true
  if (byPolicy || !requested) {
    const decision = byPolicy && input.interactionPolicy === 'unattended-allow' ? 'allow' : 'deny'
    deferredDenials.push(new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void input.answerInteraction({
          run: input.run,
          request: interaction.request,
          nativeId: interaction.nativeId,
        }, decision).then(resolve, reject)
      })
    }).catch(async (error: unknown) => {
      // The harness waits on this answer forever; end the turn instead of leaving it waiting.
      await input.native.abort().catch(() => {})
      throw new Error(`the Bridge could not ${decision} the ${interaction.request.kind} interaction: ${error instanceof Error ? error.message : String(error)}`)
    }))
    return byPolicy
      ? {
          type: 'warning',
          code: 'interaction_answered_by_policy',
          message: `permission interaction was answered ${decision} by interaction_policy ${input.interactionPolicy}`,
        }
      : {
          type: 'warning',
          code: 'interaction_not_requested',
          message: `${interaction.request.kind} interaction was denied because this turn did not request it`,
        }
  }
  input.run.registerInteraction({ request: interaction.request, nativeId: interaction.nativeId })
  return { type: 'interaction', request: interaction.request }
}

function settledStatus(failure: string | null): StreamEvent {
  return { type: 'status', status: failure ? 'failed' : 'completed', ...(failure ? { detail: failure } : {}) }
}

/** Per process: Claude's `total_cost_usd` is cumulative per process, so each `result` sends only its increase. */
const claudeCostTotals = new WeakMap<ClaudeNativeSession, number>()

/**
 * Claude's step: one stream-json line to canonical events, or null to keep it
 * as `raw`. Claude prints whole content blocks, so each text block is one
 * part. The first failure sticks, as in one-shot.
 */
function claudeStep(
  input: NativeTurnInput,
  native: ClaudeNativeSession,
  deferredDenials: Promise<void>[],
): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  const tools = new Map<string, { name: string; args: Record<string, unknown> }>()
  const models = new Set<string>()
  let nextContentIndex = 0
  let failure: string | null = null
  const raw = (event: unknown): StreamEvent => ({ type: 'raw', backend: backendName, event })
  return (event) => {
    const type = String(event.type ?? '')
    const out: StreamEvent[] = []
    if (type === 'system' && event.subtype === 'init') {
      const id = stringValue(event.session_id)
      if (id) {
        input.onProviderSessionId(id)
        out.push({ type: 'session.updated', sessionId: boundedRuntimeId(id), time: { updated: Date.now() } })
      }
      out.push({ type: 'status', status: 'processing' })
      return out
    }
    if (type === 'assistant') {
      const message = recordValue(event.message)
      const model = stringValue(message?.model)
      const observation = `${String(message?.id)}:${model}`
      // Served model identity, reported as one-shot and Pi report it.
      if (event.isApiErrorMessage !== true && model && model !== '<synthetic>' && !models.has(observation)) {
        models.add(observation)
        out.push(raw({ type: 'raw', data: { model, provider_models: [model] } }))
      }
      let unrecognised = false
      for (const item of message && Array.isArray(message.content) ? message.content : []) {
        const block = recordValue(item)
        const text = stringValue(block?.text)
        const thinking = stringValue(block?.thinking)
        const id = stringValue(block?.id)
        const name = stringValue(block?.name)
        if (block?.type === 'text' && text) {
          if (event.isApiErrorMessage === true) failure ??= sanitizeUpstreamErrorDetail(text)
          out.push(textEvent(sessionId, run.id, nextContentIndex++, text, text))
        } else if (block?.type === 'thinking' && thinking) {
          out.push(reasoningEvent(sessionId, run.id, nextContentIndex++, thinking, thinking))
        } else if (block?.type === 'tool_use' && id && name) {
          const args = recordValue(block.input) ?? {}
          tools.set(id, { name, args })
          out.push({ type: 'message.part.updated', part: toolPart(sessionId, run.id, id, name, args, 'pending') })
        } else if (block?.type !== 'thinking') unrecognised = true
      }
      // Blocks with no canonical form (redacted thinking, server tools) keep the whole line as raw.
      if (unrecognised) out.push(raw(event))
      return out
    }
    if (type === 'user') {
      const message = recordValue(event.message)
      for (const item of message && Array.isArray(message.content) ? message.content : []) {
        const block = recordValue(item)
        const id = block?.type === 'tool_result' ? stringValue(block.tool_use_id) : null
        const tool = id ? tools.get(id) : undefined
        if (!block || !id || !tool) continue
        const failed = block.is_error === true
        const outcome = failed
          ? { error: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), result: block.content }
          : { result: block.content }
        out.push({ type: 'message.part.updated',
          part: toolPart(sessionId, run.id, id, tool.name, tool.args, failed ? 'error' : 'completed', outcome) })
      }
      // The prompt and steer echoes stay raw: they are the consumption receipts.
      return out.length > 0 ? out : null
    }
    if (type === 'control_request') {
      const request = recordValue(event.request)
      const nativeId = stringValue(event.request_id)
      if (request?.subtype !== 'can_use_tool' || !nativeId) return null
      const interaction = interactionFromClaude(run, request, nativeId, sessionId, input.providerName, input.environmentId)
      if (interaction) return [admitInteraction(input, interaction, deferredDenials)]
      // Claude waits on every permission request; one the bridge cannot publish is refused.
      deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
      return [{ type: 'warning', code: 'unsupported_interaction', message: 'Claude emitted a permission request cli-bridge cannot publish' }]
    }
    if (type === 'error') {
      failure ??= sanitizeUpstreamErrorDetail(stringValue(recordValue(event.error)?.message) ?? stringValue(event.message) ?? undefined)
      return null
    }
    if (type === 'result') {
      const total = typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : undefined
      const previous = claudeCostTotals.get(native) ?? 0
      if (total !== undefined) claudeCostTotals.set(native, Math.max(total, previous))
      const usage = claudeUsageEvent(event, total === undefined || total < previous ? undefined : total - previous)
      if (event.is_error === true || event.subtype !== 'success')
        failure ??= sanitizeUpstreamErrorDetail(stringValue(event.result) ?? `result ${String(event.subtype ?? 'error')}`)
      return [...(usage ? [raw(usage)] : []), raw(event)]
    }
    if (type === CLAUDE_TURN_SETTLED) return [settledStatus(failure)]
    return null
  }
}

/**
 * Kimi's step: one frame of Kimi's local-server WebSocket to canonical events, or null to keep it as `raw`.
 * An assistant message or reasoning item is one content part, fed by its snapshots and `item.delta` appends;
 * a tool call item is one tool part. Each `turn.updated` step is one model call's usage. A `user_message`
 * item (the prompt or a steer) stays raw: it is the consumption receipt. The first failure sticks, as in one-shot.
 */
function kimiStep(
  input: NativeTurnInput,
  native: KimiNativeSession,
  deferredDenials: Promise<void>[],
): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  const items = new Map<string, string>()
  const parts = new Map<string, { index: number; text: string }>()
  const tools = new Map<string, { name: string; args: Record<string, unknown>; status: 'pending' | 'running' | 'completed' | 'error' | null }>()
  const steps = new Set<string>()
  let nextContentIndex = 0
  let failure: string | null = null
  const raw = (event: unknown): StreamEvent => ({ type: 'raw', backend: backendName, event })
  // Publish only what extends the item's text; a stale or rewritten snapshot adds nothing the deltas did not.
  const content = (itemId: string, kind: 'text' | 'reasoning', delta: string | null, snapshot = ''): StreamEvent[] => {
    let entry = parts.get(itemId)
    if (!entry) parts.set(itemId, entry = { index: nextContentIndex++, text: '' })
    const appended = delta ?? (snapshot.startsWith(entry.text) ? snapshot.slice(entry.text.length) : '')
    if (!appended) return []
    entry.text += appended
    return [(kind === 'reasoning' ? reasoningEvent : textEvent)(sessionId, run.id, entry.index, entry.text, appended)]
  }
  const tool = (id: string, fields: Record<string, unknown>, ended: boolean): StreamEvent[] => {
    const known = tools.get(id) ?? { name: 'tool', args: {}, status: null }
    const name = stringValue(fields.name) ?? known.name
    let args = recordValue(fields.input) ?? known.args
    if (!recordValue(fields.input) && typeof fields.input_text === 'string') {
      try { args = recordValue(JSON.parse(fields.input_text)) ?? args } catch { /* still streaming */ }
    }
    const error = stringValue(fields.error)
    const status: 'pending' | 'running' | 'completed' | 'error' = ended ? (error || fields.outcome === 'failed' ? 'error' : 'completed')
      : fields.stage === 'executing' ? 'running' : known.status ?? 'pending'
    tools.set(id, { name, args, status })
    if (status === known.status) return []
    const outcome = status === 'completed' ? { output: fields.output ?? null }
      : status === 'error' ? { error: error ?? 'tool failed', result: fields.output } : undefined
    return [{ type: 'message.part.updated', part: toolPart(sessionId, run.id, id, name, args, status, outcome) }]
  }
  return (event) => {
    const type = String(event.type ?? '')
    if (type === KIMI_TURN_SETTLED) return [settledStatus(failure)]
    if (type === 'turn.started') return [{ type: 'status', status: 'processing' }]
    if (type === 'turn.ended') {
      const turn = recordValue(event.turn)
      if (turn?.outcome === 'failed')
        failure ??= sanitizeUpstreamErrorDetail(stringValue(recordValue(turn.error)?.message) ?? `turn ended: ${String(turn.end_reason ?? 'failed')}`)
      return null
    }
    if (type === 'turn.updated') {
      const step = recordValue(event.step)
      const usage = recordValue(step?.usage)
      const key = `${String(event.turn_id)}:${String(step?.index)}`
      // A retry frame carries no usage and stays raw: it names the provider's wait.
      if (!usage) return null
      if (steps.has(key)) return []
      steps.add(key)
      const fresh = numberValue(usage.input_other) ?? 0, cacheRead = numberValue(usage.input_cache_read) ?? 0
      const cacheWrite = numberValue(usage.input_cache_creation) ?? 0
      return [raw(usageEnvironmentEvent({ input: fresh + cacheRead + cacheWrite, freshInput: fresh, cacheRead, cacheWrite,
        output: numberValue(usage.output) ?? undefined }, undefined))]
    }
    if (type === 'item.started' || type === 'item.ended' || type === 'item.updated' || type === 'item.delta') {
      const item = recordValue(event.item)
      const id = stringValue(item?.item_id) ?? stringValue(event.item_id)
      if (!id) return null
      const kind = stringValue(item?.type) ?? items.get(id)
      if (kind) items.set(id, kind)
      const fields = item ?? recordValue(event.set) ?? {}
      if (kind === 'assistant_message' || kind === 'reasoning') {
        const part = kind === 'reasoning' ? 'reasoning' : 'text'
        if (type === 'item.delta') return event.field === 'text' && typeof event.delta === 'string' ? content(id, part, event.delta) : []
        return content(id, part, null, typeof fields.text === 'string' ? fields.text : '')
      }
      if (kind === 'tool_call') return type === 'item.delta' ? [] : tool(id, fields, type === 'item.ended')
      return null
    }
    if (type === 'interaction') {
      const nativeId = stringValue(event.interaction_id)
      if (!nativeId || event.status !== 'pending') return []
      const request = recordValue(event.request)
      if (event.kind === 'approval') {
        const name = (stringValue(request?.tool_name) ?? 'tool').replace(/[^\p{L}\p{N} .,_:\/-]/gu, ' ').trim().slice(0, 120) || 'tool'
        const body = [stringValue(request?.action), request?.tool_input_display === undefined ? null : JSON.stringify(request.tool_input_display)]
          .filter((part): part is string => part !== null).join('\n').slice(0, 4_000)
        const interaction = permissionInteraction(run, nativeId, `Permission: ${name}`, body || null, sessionId,
          input.providerName, input.environmentId)
        if (interaction) return [admitInteraction(input, interaction, deferredDenials)]
      }
      // Kimi waits on every interaction; a question, or an approval the bridge cannot publish, is dismissed.
      deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
      return [{ type: 'warning', code: 'unsupported_interaction', message: `Kimi asked a ${String(event.kind)} cli-bridge cannot publish; it was dismissed` }]
    }
    // Session, agent, context and task bookkeeping carry nothing a turn's consumer reads.
    if (['session', 'agent', 'context', 'task', 'task.list', 'todo', 'goal', 'turns'].includes(type)) return []
    return null
  }
}

/**
 * An ACP agent's step: one `session/update` to canonical events, or null to keep it as `raw`. Each
 * assistant message (by `messageId`) or thought is one content part fed by its chunks; a tool call is
 * one tool part. The `session/prompt` result settles the turn with the usage it reports. A steer's
 * receipt stays raw.
 */
function acpStep(
  input: NativeTurnInput,
  native: AcpNativeSession,
  deferredDenials: Promise<void>[],
): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  const parts = new Map<string, { index: number; text: string }>()
  const tools = new Map<string, { name: string; args: Record<string, unknown> }>()
  let nextContentIndex = 0
  const raw = (event: unknown): StreamEvent => ({ type: 'raw', backend: backendName, event })
  const content = (key: string, kind: 'text' | 'reasoning', delta: string): StreamEvent[] => {
    let entry = parts.get(key)
    if (!entry) parts.set(key, entry = { index: nextContentIndex++, text: '' })
    entry.text += delta
    return [(kind === 'reasoning' ? reasoningEvent : textEvent)(sessionId, run.id, entry.index, entry.text, delta)]
  }
  return (event) => {
    const type = String(event.type ?? '')
    if (type === ACP_TURN_SETTLED) {
      const failure = typeof event.error === 'string' ? sanitizeUpstreamErrorDetail(event.error)
        : event.stopReason === 'refusal' ? 'the agent refused the prompt' : null
      const usage = recordValue(event.usage)
      const read = (key: string) => numberValue(usage?.[key]) ?? undefined
      const counted = usage && [read('inputTokens'), read('outputTokens')].some((count) => count !== undefined && count > 0)
      return [
        ...(counted ? [raw(usageEnvironmentEvent({ input: read('inputTokens'), output: read('outputTokens'), reasoning: read('thoughtTokens'),
          cacheRead: read('cachedReadTokens'), cacheWrite: read('cachedWriteTokens') }, undefined))] : []),
        settledStatus(failure),
      ]
    }
    if (type === ACP_PERMISSION) {
      const nativeId = stringValue(event.id)
      if (!nativeId) return []
      const call = recordValue(event.toolCall) ?? {}
      const title = (stringValue(call.title) ?? 'tool').replace(/[^\p{L}\p{N} .,_:\/-]/gu, ' ').trim().slice(0, 120) || 'tool'
      const body = call.rawInput === undefined ? null : JSON.stringify(call.rawInput).slice(0, 4_000)
      const interaction = permissionInteraction(run, nativeId, `Permission: ${title}`, body, sessionId, input.providerName, input.environmentId)
      if (interaction) return [admitInteraction(input, interaction, deferredDenials)]
      deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
      return [{ type: 'warning', code: 'unsupported_interaction', message: 'the agent asked a permission cli-bridge cannot publish; it was refused' }]
    }
    if (type !== 'session/update') return null
    const update = recordValue(event.update) ?? {}
    const kind = String(update.sessionUpdate ?? '')
    const chunk = recordValue(update.content)
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && chunk?.type === 'text' && typeof chunk.text === 'string') {
      const key = `${kind}:${stringValue(update.messageId) ?? ''}`
      return chunk.text ? content(key, kind === 'agent_thought_chunk' ? 'reasoning' : 'text', chunk.text) : []
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = stringValue(update.toolCallId)
      if (!id) return null
      const known = tools.get(id) ?? { name: 'tool', args: {} }
      const name = stringValue(update.title) ?? known.name
      const args = recordValue(update.rawInput) ?? known.args
      tools.set(id, { name, args })
      const output = Array.isArray(update.content)
        ? update.content.map((item) => stringValue(recordValue(recordValue(item)?.content)?.text) ?? '').filter(Boolean).join('\n')
        : undefined
      const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'error'
        : update.status === 'in_progress' ? 'running' : kind === 'tool_call' ? 'pending' : null
      if (!status) return []
      return [{ type: 'message.part.updated', part: toolPart(sessionId, run.id, id, name, args, status,
        status === 'completed' ? { output: output ?? null } : status === 'error' ? { error: output || 'tool failed' } : undefined) }]
    }
    // Plans, usage gauges, session info, commands and config are not a turn's output.
    return []
  }
}

/**
 * OpenClaw's step: each answered `openclaw agent` call of the turn (the prompt, and any `/steer`) is
 * one text part with that call's usage; the settle frame ends the turn with the first failure.
 */
function openclawStep(input: NativeTurnInput): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  let nextContentIndex = 0
  return (event) => {
    const type = String(event.type ?? '')
    if (type === OPENCLAW_TURN_SETTLED) {
      return [settledStatus(typeof event.error === 'string' ? sanitizeUpstreamErrorDetail(event.error) : null)]
    }
    if (type !== OPENCLAW_REPLY) return null
    const text = typeof event.text === 'string' ? event.text : ''
    const usage = recordValue(event.usage)
    return [
      ...(text ? [textEvent(sessionId, run.id, nextContentIndex++, text, text)] : []),
      ...(usage ? [{ type: 'raw', backend: backendName, event: usageEnvironmentEvent({ input: numberValue(usage.input_tokens) ?? undefined,
        freshInput: numberValue(usage.fresh_input_tokens) ?? undefined, cacheRead: numberValue(usage.cache_read_input_tokens) ?? undefined,
        cacheWrite: numberValue(usage.cache_write_input_tokens) ?? undefined, output: numberValue(usage.output_tokens) ?? undefined }, undefined) } satisfies StreamEvent] : []),
    ]
  }
}

/**
 * Codex's step: one app-server message to canonical events, or null to keep it as `raw`. An agent message or
 * reasoning item is one content part, fed by its deltas and its completed snapshot; a command, MCP tool call, file
 * change or web search item is one tool part, named as the one-shot path names it. Each `thread/tokenUsage/updated`
 * that moved the thread's total is one model call's usage. A `userMessage` item (the prompt or a steer) stays raw: it
 * is the consumption receipt. The first failure sticks, as in one-shot.
 */
function codexStep(
  input: NativeTurnInput,
  native: CodexNativeSession,
  deferredDenials: Promise<void>[],
): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  const parts = new Map<string, { index: number; text: string }>()
  const tools = new Map<string, 'pending' | 'running' | 'completed' | 'error'>()
  const models = new Set<string>()
  let lastTotal: string | null = null
  let nextContentIndex = 0
  let processing = false
  let failure: string | null = null
  const raw = (event: unknown): StreamEvent => ({ type: 'raw', backend: backendName, event })
  // Publish only what extends the part's text; a stale or rewritten snapshot adds nothing the deltas did not.
  const content = (key: string, kind: 'text' | 'reasoning', delta: string | null, snapshot = ''): StreamEvent[] => {
    let entry = parts.get(key)
    if (!entry) parts.set(key, entry = { index: nextContentIndex++, text: '' })
    const appended = delta ?? (snapshot.startsWith(entry.text) ? snapshot.slice(entry.text.length) : '')
    if (!appended) return []
    entry.text += appended
    return [(kind === 'reasoning' ? reasoningEvent : textEvent)(sessionId, run.id, entry.index, entry.text, appended)]
  }
  const tool = (item: Record<string, unknown>, ended: boolean): StreamEvent[] | null => {
    const id = stringValue(item.id)
    const kind = item.type
    if (!id) return null
    const named = kind === 'commandExecution' ? { name: 'bash', args: { command: item.command ?? '' } }
      : kind === 'mcpToolCall' ? { name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('_') || 'mcp',
        args: recordValue(item.arguments) ?? {} }
      : kind === 'fileChange' ? { name: 'apply_patch', args: { changes: item.changes ?? [] } }
      : kind === 'webSearch' ? { name: 'websearch', args: { query: item.query ?? '' } }
      : null
    if (!named) return null
    const failed = item.status === 'failed' || item.status === 'declined'
      || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    const status = !ended ? 'running' : failed ? 'error' : 'completed'
    if (tools.get(id) === status) return []
    tools.set(id, status)
    const output = item.result ?? item.aggregatedOutput ?? null
    const outcome = status === 'completed' ? { output }
      : status === 'error' ? { error: stringValue(recordValue(item.error)?.message) ?? `${String(kind)} ${String(item.status ?? 'failed')}`, result: output }
      : undefined
    return [{ type: 'message.part.updated', part: toolPart(sessionId, run.id, id, named.name, named.args, status, outcome) }]
  }
  const approval = (method: string, nativeId: string, params: Record<string, unknown>): StreamEvent => {
    const title = method === 'item/commandExecution/requestApproval' ? 'Permission: command'
      : method === 'item/fileChange/requestApproval' ? 'Permission: file change'
      : `Permission: ${[stringValue(params.serverName), stringValue(recordValue(params._meta)?.tool_name)].filter(Boolean).join('.')
        .replace(/[^\p{L}\p{N} .,_:\/-]/gu, ' ').trim().slice(0, 120) || 'MCP tool'}`
    const meta = recordValue(params._meta)
    const body = [stringValue(params.command), stringValue(params.cwd), stringValue(params.reason), stringValue(params.message),
      meta?.tool_params === undefined ? null : JSON.stringify(meta.tool_params)]
      .filter((part): part is string => Boolean(part)).join('\n').slice(0, 4_000)
    const interaction = permissionInteraction(run, nativeId, title, body || null, sessionId, input.providerName, input.environmentId)
    if (interaction) return admitInteraction(input, interaction, deferredDenials)
    // Codex waits on every approval; one the bridge cannot publish is declined.
    deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
    return { type: 'warning', code: 'unsupported_interaction', message: 'Codex asked an approval cli-bridge cannot publish; it was declined' }
  }
  return (event) => {
    if (event.type === CODEX_TURN_SETTLED) return [settledStatus(failure)]
    if (event.type === 'warning') {
      return [{ type: 'warning', code: 'unsupported_interaction', message: `Codex sent ${String(event.method)}, which cli-bridge does not answer; it was refused` }]
    }
    const method = stringValue(event.method)
    const params = recordValue(event.params) ?? {}
    if (!method) return null
    if (event.id !== undefined) {
      const nativeId = String(event.id)
      if (method === 'mcpServer/elicitation/request' && !isCodexToolApproval(params)) {
        // An MCP server's own form has no Bridge interaction; it is declined.
        deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
        return [{ type: 'warning', code: 'unsupported_interaction', message: 'an MCP server asked for input cli-bridge cannot publish; it was declined' }]
      }
      return [approval(method, nativeId, params)]
    }
    if (method === 'turn/started') {
      if (processing) return []
      processing = true
      return [{ type: 'status', status: 'processing' }]
    }
    if (method === 'turn/completed') {
      const turn = recordValue(params.turn)
      if (turn?.status === 'failed')
        failure ??= sanitizeUpstreamErrorDetail(stringValue(recordValue(turn.error)?.message) ?? 'turn failed')
      return null
    }
    if (method === 'error') {
      if (params.willRetry !== true) failure ??= sanitizeUpstreamErrorDetail(stringValue(recordValue(params.error)?.message) ?? 'codex error')
      return null
    }
    if (method === 'item/agentMessage/delta') {
      const id = stringValue(params.itemId)
      return id && typeof params.delta === 'string' ? content(id, 'text', params.delta) : null
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const id = stringValue(params.itemId)
      const key = `${id}:${method === 'item/reasoning/textDelta' ? 'text' : 'summary'}`
      return id && typeof params.delta === 'string' ? content(key, 'reasoning', params.delta) : null
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = recordValue(params.item) ?? {}
      const id = stringValue(item.id)
      if (item.type === 'agentMessage' && id) return content(id, 'text', null, typeof item.text === 'string' ? item.text : '')
      if (item.type === 'reasoning' && id) {
        const summary = Array.isArray(item.summary) ? item.summary.filter((part) => typeof part === 'string').join('\n') : ''
        return summary ? content(`${id}:summary`, 'reasoning', null, summary) : []
      }
      return tool(item, method === 'item/completed')
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = recordValue(params.tokenUsage)
      const total = JSON.stringify(usage?.total ?? null)
      const last = recordValue(usage?.last)
      if (!last || total === lastTotal) return []
      lastTotal = total
      const inputTokens = numberValue(last.inputTokens), cacheRead = numberValue(last.cachedInputTokens)
      return [raw(usageEnvironmentEvent({
        input: inputTokens ?? undefined,
        freshInput: inputTokens !== null && cacheRead !== null && inputTokens >= cacheRead ? inputTokens - cacheRead : undefined,
        cacheRead: cacheRead ?? undefined,
        cacheWrite: numberValue(last.cacheWriteInputTokens) ?? undefined,
        output: numberValue(last.outputTokens) ?? undefined,
        reasoning: numberValue(last.reasoningOutputTokens) ?? undefined,
      }, undefined))]
    }
    if (method === 'model/rerouted') {
      // Codex names the served model only when it differs from the request, as on the one-shot path.
      const model = stringValue(params.toModel)
      if (!model || models.has(model)) return []
      models.add(model)
      return [raw({ type: 'raw', data: { model, provider_models: [model] } })]
    }
    // Thread, account, MCP startup and output-stream bookkeeping carry nothing a turn's consumer reads.
    if (['thread/started', 'thread/status/changed', 'account/rateLimits/updated', 'mcpServer/startupStatus/updated',
      'serverRequest/resolved', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress',
      'turn/diff/updated', 'remoteControl/status/changed'].includes(method)) return []
    return null
  }
}

/**
 * opencode's step: one `/event` record to canonical events, or null to keep it as `raw`. Text and
 * reasoning arrive as part snapshots plus `message.part.delta` appends, one content index per part;
 * a user message's parts (the prompt and steers) are not output. Each `step-finish` part is one
 * model call's usage. The first failure sticks, as in one-shot; an abort is the run's own.
 */
function opencodeStep(
  input: NativeTurnInput,
  native: OpencodeNativeSession,
  deferredDenials: Promise<void>[],
): (event: Record<string, unknown>) => StreamEvent[] | null {
  const { run, sessionId, backendName } = input
  const userMessages = new Set<string>()
  const parts = new Map<string, { index: number; kind: 'text' | 'reasoning'; text: string }>()
  const tools = new Map<string, string>()
  const steps = new Set<string>()
  const models = new Set<string>()
  let model: string | undefined
  let nextContentIndex = 0
  let processing = false
  let failure: string | null = null
  const raw = (event: unknown): StreamEvent => ({ type: 'raw', backend: backendName, event })
  const fail = (error: Record<string, unknown> | null): void => {
    if (!error || error.name === 'MessageAbortedError') return
    failure ??= sanitizeUpstreamErrorDetail(stringValue(recordValue(error.data)?.message) ?? stringValue(error.name) ?? undefined)
  }
  // Publish only what extends the part's text; a stale or rewritten snapshot adds nothing the deltas did not.
  const content = (partId: string, kind: 'text' | 'reasoning', delta: string | null, snapshot = ''): StreamEvent[] => {
    let entry = parts.get(partId)
    if (!entry) parts.set(partId, entry = { index: nextContentIndex++, kind, text: '' })
    const appended = delta ?? (snapshot.startsWith(entry.text) ? snapshot.slice(entry.text.length) : '')
    if (!appended) return []
    entry.text += appended
    return [(entry.kind === 'reasoning' ? reasoningEvent : textEvent)(sessionId, run.id, entry.index, entry.text, appended)]
  }
  return (event) => {
    const type = String(event.type ?? '')
    const props = recordValue(event.properties) ?? {}
    if (type === OPENCODE_TURN_SETTLED) return [settledStatus(failure)]
    if (type === 'message.updated') {
      const info = recordValue(props.info)
      const id = stringValue(info?.id)
      if (info?.role === 'user') {
        if (id) userMessages.add(id)
        return []
      }
      fail(recordValue(info?.error))
      model = stringValue(info?.modelID) ?? model
      // Served model identity, reported as one-shot and Claude report it.
      if (!id || !model || models.has(`${id}:${model}`)) return []
      models.add(`${id}:${model}`)
      return [raw({ type: 'raw', data: { model, provider_models: [model] } })]
    }
    if (type === 'message.part.delta') {
      const partId = stringValue(props.partID)
      const messageId = stringValue(props.messageID)
      const delta = props.delta
      if (!partId || !messageId || props.field !== 'text' || typeof delta !== 'string') return null
      if (userMessages.has(messageId)) return []
      return content(partId, parts.get(partId)?.kind ?? 'text', delta)
    }
    if (type === 'message.part.updated') {
      const part = recordValue(props.part)
      const partId = stringValue(part?.id)
      const messageId = stringValue(part?.messageID)
      if (!part || !partId || !messageId) return null
      if (userMessages.has(messageId) || part.synthetic === true) return []
      const kind = part.type
      if (kind === 'text' || kind === 'reasoning') return content(partId, kind, null, typeof part.text === 'string' ? part.text : '')
      if (kind === 'tool') {
        const id = stringValue(part.callID) ?? partId
        const state = recordValue(part.state) ?? {}
        const status = state.status
        if ((status !== 'pending' && status !== 'running' && status !== 'completed' && status !== 'error') || tools.get(id) === status) return []
        tools.set(id, status)
        const outcome = status === 'completed' ? { output: state.output } : status === 'error' ? { error: state.error } : undefined
        return [{ type: 'message.part.updated',
          part: toolPart(sessionId, run.id, id, stringValue(part.tool) ?? 'tool', recordValue(state.input) ?? {}, status, outcome) }]
      }
      if (kind === 'step-start') {
        if (processing) return []
        processing = true
        return [{ type: 'status', status: 'processing' }]
      }
      if (kind === 'step-finish') {
        if (steps.has(partId)) return []
        steps.add(partId)
        const usage = opencodeStepUsage(part)
        return usage ? [raw(usageEnvironmentEvent({
          input: usage.input_tokens, freshInput: usage.fresh_input_tokens, cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_write_input_tokens, output: usage.output_tokens, reasoning: usage.reasoning_output_tokens,
          estimatedCost: usage.estimated_cost,
        }, model ? { model } : undefined))] : []
      }
      return null
    }
    if (type === 'session.error') {
      fail(recordValue(props.error))
      return []
    }
    if (type === 'permission.asked') {
      const nativeId = stringValue(props.id)
      if (!nativeId) return null
      const permission = (stringValue(props.permission) ?? 'tool').replace(/[^\p{L}\p{N} .,_:\/-]/gu, ' ').trim().slice(0, 120) || 'tool'
      const body = JSON.stringify({ patterns: props.patterns, metadata: props.metadata }).slice(0, 4_000)
      const interaction = permissionInteraction(run, nativeId, `Permission: ${permission}`, body, sessionId,
        input.providerName, input.environmentId)
      if (interaction) return [admitInteraction(input, interaction, deferredDenials)]
      // opencode waits on every permission request; one the bridge cannot publish is refused.
      deferredDenials.push(native.respondToNativeInteraction(nativeId, { cancelled: true }))
      return [{ type: 'warning', code: 'unsupported_interaction', message: 'opencode emitted a permission request cli-bridge cannot publish' }]
    }
    // A retry status stays raw: it names the provider's wait.
    if (type === 'session.status') return recordValue(props.status)?.type === 'retry' ? null : []
    if (type === 'session.updated' || type === 'session.diff' || type === 'permission.replied') return []
    return null
  }
}

function interactionFromClaude(
  run: Run,
  request: Record<string, unknown>,
  nativeId: string,
  sessionId: string,
  providerName: string,
  environmentId: string,
): { request: InteractionRequest; nativeId: string } | null {
  const tool = (stringValue(request.display_name) ?? stringValue(request.tool_name) ?? 'tool')
    .replace(/[^\p{L}\p{N} .,_:\/-]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'tool'
  const input = recordValue(request.input)
  const body = [stringValue(request.description), input ? JSON.stringify(input) : null]
    .filter((part): part is string => part !== null)
    .join('\n')
    .slice(0, 4_000)
  return permissionInteraction(run, nativeId, `Permission: ${tool}`, body || null, sessionId, providerName, environmentId)
}

/** Claude's per-result usage receipt; `cost` is this result's share of Claude Code's own estimate. */
function claudeUsageEvent(result: Record<string, unknown>, cost: number | undefined): AgentEnvironmentEvent | null {
  const usage = normalizeClaudeUsage((recordValue(result.usage) ?? undefined) as ClaudeNativeUsage | undefined)
  if (!usage) return null
  const rawUsage = {
    ...(usage.input_tokens === undefined ? {} : { prompt_tokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { completion_tokens: usage.output_tokens }),
    ...(usage.fresh_input_tokens === undefined ? {} : { fresh_input_tokens: usage.fresh_input_tokens }),
    ...(usage.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: usage.cache_read_input_tokens }),
    ...(usage.cache_write_input_tokens === undefined ? {} : { cache_write_input_tokens: usage.cache_write_input_tokens }),
    estimated: false,
    cost_known: false,
  }
  return {
    type: 'usage',
    data: { usage: rawUsage, ...(cost === undefined ? {} : { estimatedCostUsd: cost }) },
    ...(usage.input_tokens === undefined || usage.output_tokens === undefined ? {} : { usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens === undefined ? {} : { cacheReadInputTokens: usage.cache_read_input_tokens }),
      ...(usage.cache_write_input_tokens === undefined ? {} : { cacheCreationInputTokens: usage.cache_write_input_tokens }),
    } }),
    usageMode: 'delta',
    providerEvent: { usage: rawUsage },
  }
}

/** The inverse of {@link interactionFromPi} — a canonical answer as Pi expects it. */
export function nativeResponseFor(request: InteractionRequest, response: InteractionResponse): Record<string, unknown> {
  if (response.outcome !== 'accepted') return { cancelled: true }
  const field = request.answerSpec.fields[0]
  const value = response.data?.[field?.name ?? 'value']
  if (field?.type === 'boolean') return { confirmed: value === true }
  if (field?.type === 'select') return { value: Array.isArray(value) ? value[0] : value }
  return { value }
}

function textEvent(sessionId: string, runId: string, index: number, text: string, delta?: string): StreamEvent {
  const messageID = boundedRuntimeId(`${runId}:message:${index}`)
  return {
    type: 'message.part.updated',
    part: {
      id: boundedRuntimeId(`${runId}:message:${index}:text`),
      sessionID: boundedRuntimeId(sessionId),
      messageID,
      type: 'text',
      text,
    },
    ...(delta !== undefined ? { delta } : {}),
  }
}

function reasoningEvent(sessionId: string, runId: string, index: number, text: string, delta?: string): StreamEvent {
  const messageID = boundedRuntimeId(`${runId}:message:${index}`)
  return {
    type: 'message.part.updated',
    part: {
      id: boundedRuntimeId(`${runId}:message:${index}:reasoning`),
      sessionID: boundedRuntimeId(sessionId),
      messageID,
      type: 'reasoning',
      text,
    },
    ...(delta !== undefined ? { delta } : {}),
  }
}

function toolPart(
  sessionId: string,
  runId: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'pending' | 'running' | 'completed' | 'error',
  event?: Record<string, unknown>,
): Part {
  const input = args
  const now = Date.now()
  let state: ToolState
  if (status === 'pending') {
    state = { status: 'pending', input }
  } else if (status === 'running') {
    state = { status: 'running', input, time: { start: now } }
  } else if (status === 'completed') {
    state = {
      status: 'completed',
      input,
      output: event?.result ?? event?.output ?? null,
      time: { start: now, end: now },
    }
  } else {
    state = {
      status: 'error',
      input,
      error: String(event?.error ?? event?.result ?? 'tool failed'),
      output: event?.result,
      time: { start: now, end: now },
    }
  }
  return {
    id: boundedRuntimeId(`${runId}:tool:${id}`),
    sessionID: boundedRuntimeId(sessionId),
    messageID: boundedRuntimeId(`${runId}:message:tools`),
    type: 'tool',
    callID: boundedRuntimeId(id),
    tool: boundedRuntimeId(name),
    state,
  }
}

function toolFromNative(
  event: Record<string, unknown>,
): { id: string; name: string; args: Record<string, unknown> } | null {
  const nested =
    recordValue(event.toolCall) ??
    recordValue(event.tool_call) ??
    recordValue(event.partial) ??
    recordValue(event.content) ??
    event
  const nestedContent = Array.isArray(nested.content) ? recordValue(nested.content[0]) : null
  const candidate = nestedContent ?? nested
  const id = stringValue(
    event.toolCallId ??
      event.toolCallID ??
      event.tool_call_id ??
      candidate.id ??
      candidate.callID ??
      candidate.toolCallId,
  )
  const name = stringValue(event.toolName ?? event.tool_name ?? candidate.name ?? candidate.tool)
  if (!id || !name) return null
  const rawArgs =
    event.args ?? event.input ?? event.arguments ?? candidate.args ?? candidate.arguments ?? candidate.input ?? {}
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      return { id, name, args: recordValue(parsed) ?? { raw: rawArgs } }
    } catch {
      return { id, name, args: { raw: rawArgs } }
    }
  }
  return { id, name, args: recordValue(rawArgs) ?? {} }
}

function interactionFromPi(
  run: Run,
  event: Record<string, unknown>,
  sessionId: string,
  providerName: string,
  environmentId: string,
): { request: InteractionRequest; nativeId: string } | null {
  const nativeId = stringValue(event.id)
  const method = stringValue(event.method)
  if (!nativeId || method !== 'select') return null
  const title = stringValue(event.title)
  if (!title || !piPermissionTokenFromTitle(title)) return null
  return permissionInteraction(run, nativeId, piPermissionPublicTitle(title), stringValue(event.message), sessionId,
    providerName, environmentId)
}

/** One provider permission prompt as a canonical interaction bound to this exact run. */
function permissionInteraction(
  run: Run,
  nativeId: string,
  title: string,
  body: string | null,
  sessionId: string,
  providerName: string,
  environmentId: string,
): { request: InteractionRequest; nativeId: string } | null {
  const interactionId = boundedRuntimeId(`${run.id}:interaction:${nativeId}`)
  const binding = {
    runId: run.id,
    provider: providerName,
    environmentId,
    sessionId,
    executionId: run.executionId ?? run.id,
    interactionId,
  }
  const material: InteractionRequestMaterial = {
    id: interactionId,
    kind: 'permission',
    title,
    ...(body ? { body } : {}),
    answerSpec: permissionAnswerSpec({ allowFeedback: false }),
    responseScopes: ['interaction'],
    binding,
  }
  const request: InteractionRequest = { ...material, requestDigest: interactionRequestDigest(material) }
  const parsed = InteractionRequestSchema.safeParse(request)
  return parsed.success ? { request: parsed.data, nativeId } : null
}

function isFireAndForgetUi(event: Record<string, unknown>): boolean {
  return ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(String(event.method ?? ''))
}

function nativeTurnFailure(message: unknown): string | null {
  const value = recordValue(message)
  if (!value) return null
  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage.trim() : ''
  if (stopReason !== 'error' && errorMessage === '') return null
  return errorMessage !== '' ? errorMessage : `stopReason=${stopReason ?? 'error'}`
}

function durablePlanFromNative(value: Record<string, unknown> | null): DurablePlan | null {
  const parsed = DurablePlanSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function usageEnvironmentEvent(receipt: PiUsageReceipt, identity: PiResponseIdentity | undefined): AgentEnvironmentEvent {
  const rawUsage = {
    model_requests: 1,
    ...(receipt.input === undefined ? {} : { prompt_tokens: receipt.input }),
    ...(receipt.output === undefined ? {} : { completion_tokens: receipt.output }),
    ...(receipt.reasoning === undefined ? {} : { reasoning_tokens: receipt.reasoning }),
    ...(receipt.freshInput === undefined ? {} : { fresh_input_tokens: receipt.freshInput }),
    ...(receipt.cacheRead === undefined ? {} : { cache_read_input_tokens: receipt.cacheRead }),
    ...(receipt.cacheWrite === undefined ? {} : { cache_write_input_tokens: receipt.cacheWrite }),
    estimated: false,
    cost_known: false,
  }
  return {
    type: 'usage',
    data: {
      ...piResponseIdentityDelta(identity),
      modelRequests: 1,
      usage: rawUsage,
      ...(receipt.estimatedCost === undefined ? {} : { estimatedCostUsd: receipt.estimatedCost }),
    },
    ...(receipt.input === undefined || receipt.output === undefined ? {} : { usage: {
      inputTokens: receipt.input,
      outputTokens: receipt.output,
      ...(receipt.reasoning === undefined ? {} : { reasoningTokens: receipt.reasoning }),
      ...(receipt.cacheRead === undefined ? {} : { cacheReadInputTokens: receipt.cacheRead }),
      ...(receipt.cacheWrite === undefined ? {} : { cacheCreationInputTokens: receipt.cacheWrite }),
    } }),
    usageMode: 'delta',
    providerEvent: { usage: rawUsage },
  }
}

function boundedRuntimeId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
}
