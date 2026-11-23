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
 * and the failing catch. Pi's step is inline below; Claude's is `claudeStep`.
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
  const claude = native instanceof ClaudeNativeSession ? claudeStep(input, native, deferredDenials) : null
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
  } catch (error) {
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
