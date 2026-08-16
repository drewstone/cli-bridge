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
import type { Run } from '../../runs/registry.js'
import { piPermissionPublicTitle, piPermissionTokenFromTitle } from '../../backends/pi-interaction.js'
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
  /** Deny provider UI that was not explicitly admitted by this turn. */
  onUnrequestedInteraction: (input: {
    run: Run
    request: InteractionRequest
    nativeId: string
  }) => Promise<void>
  /** The provider disclosed its own session id; record it before continuing. */
  onProviderSessionId: (providerSessionId: string) => void
}

export async function* canonicalTurn(input: NativeTurnInput): AsyncIterable<{ event: StreamEvent }> {
  const { native, run, sessionId, prompt, backendName } = input
  yield { event: { type: 'status', status: 'started' } }
  const text = new Map<number, string>()
  const reasoning = new Map<number, string>()
  const toolParts = new Map<string, Part>()
  let nextContentIndex = 0
  let lastTurnFailure: string | null = null
  const deferredDenials: Promise<void>[] = []
  try {
    for await (const raw of native.turn(prompt, run.signal)) {
      const event = recordValue(raw)
      if (!event) {
        yield { event: { type: 'raw', backend: backendName, event: raw } }
        continue
      }
      const type = String(event.type ?? '')
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
          if (
            (input.interactions as Readonly<Record<string, boolean | undefined>>)[
              interaction.request.kind
            ] !== true
          ) {
            // Let the provider resume from its yielded UI request before
            // writing the cancellation. Pi installs its response waiter on
            // that resume, not while this event is being translated.
            const denial = new Promise<void>((resolve, reject) => {
              setImmediate(() => {
                void input.onUnrequestedInteraction({
                  run,
                  request: interaction.request,
                  nativeId: interaction.nativeId,
                }).then(resolve, reject)
              })
            })
            deferredDenials.push(denial)
            yield {
              event: {
                type: 'warning',
                code: 'interaction_not_requested',
                message: `${interaction.request.kind} interaction was denied because this turn did not request it`,
              },
            }
            continue
          }
          run.registerInteraction({ request: interaction.request, nativeId: interaction.nativeId })
          yield { event: { type: 'interaction', request: interaction.request } }
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
        const usage = usageFromPi(event)
        if (usage) yield { event: { type: 'raw', backend: backendName, event: usageEnvironmentEvent(usage) } }
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
      if (type === 'agent_settled') {
        yield {
          event: {
            type: 'status',
            status: lastTurnFailure ? 'failed' : 'completed',
            ...(lastTurnFailure ? { detail: lastTurnFailure } : {}),
          },
        }
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

export function isUsageEvent(value: unknown): value is AgentEnvironmentEvent {
  const record = recordValue(value)
  if (record?.type !== 'usage') return false
  const data = recordValue(record.data)
  return recordValue(record.usage) !== null || recordValue(data?.usage) !== null
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
    title: piPermissionPublicTitle(title),
    ...(stringValue(event.message) ? { body: stringValue(event.message)! } : {}),
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

function usageFromPi(event: Record<string, unknown>): Record<string, number> | null {
  const message = recordValue(event.message)
  const usage = recordValue(event.usage) ?? recordValue(message?.usage)
  if (!usage) return null
  const result: Record<string, number> = {}
  for (const [key, target] of [
    ['input', 'inputTokens'],
    ['output', 'outputTokens'],
    ['cacheRead', 'cacheReadInputTokens'],
    ['cacheWrite', 'cacheCreationInputTokens'],
    ['reasoning', 'reasoningTokens'],
    ['cost', 'cost'],
  ] as const) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[target] = value
  }
  if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') return null
  return result
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

function usageEnvironmentEvent(usage: Record<string, number>): AgentEnvironmentEvent {
  return { type: 'usage', data: {}, usage: usage as AgentEnvironmentEvent['usage'] }
}

function boundedRuntimeId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
}
