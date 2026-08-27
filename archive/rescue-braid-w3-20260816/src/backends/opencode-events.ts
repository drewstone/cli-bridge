import type { ChatDelta, ChatRequest } from './types.js'

export type UsageReceipt = NonNullable<ChatDelta['usage']>

export interface UsageTotal {
  receipt: UsageReceipt
  costComplete: boolean
}

export function opencodeVariantForEffort(effort: ChatRequest['effort']): string | null {
  return effort ?? null
}

export function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const k of ['session_id', 'sessionId', 'sessionID', 'session']) {
    const v = ev[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'object' && v !== null) {
      const id = (v as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return null
}

export function extractToolUse(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const part = ev.part as Record<string, unknown> | undefined
  const tool =
    (ev.tool_call as Record<string, unknown> | undefined)
    ?? (ev.toolCall as Record<string, unknown> | undefined)
    ?? (part?.type === 'tool' || part?.type === 'tool_call' ? part : undefined)
  if (!tool) return null
  const id = String(tool.id ?? tool.callID ?? tool.toolCallID ?? tool.tool_call_id ?? '')
  const name = String(tool.name ?? tool.tool ?? '')
  if (!id || !name) return null
  const state = tool.state as Record<string, unknown> | undefined
  const input = tool.input ?? state?.input ?? tool.arguments ?? {}
  return {
    id,
    name,
    arguments: typeof input === 'string' ? input : JSON.stringify(input),
  }
}

export function extractUsage(ev: Record<string, unknown>): UsageReceipt | null {
  const direct = ev.usage as Record<string, unknown> | undefined
  if (direct) {
    return usageFromValues({
      input_tokens: direct.input_tokens ?? direct.input,
      output_tokens: direct.output_tokens ?? direct.output,
      cost: direct.cost ?? ev.cost,
    })
  }

  const part = ev.part as Record<string, unknown> | undefined
  const tokens = part?.tokens as Record<string, unknown> | undefined
  const cache = tokens?.cache as Record<string, unknown> | undefined

  return usageFromValues({
    // OpenCode reports input/output *excluding* cache and reasoning.
    // OpenAI totals include those categories, so reconstruct full compute.
    input_tokens: sumKnown([
      tokens?.input_tokens ?? tokens?.input,
      cache?.read,
      cache?.write,
    ]),
    output_tokens: sumKnown([
      tokens?.output_tokens ?? tokens?.output,
      tokens?.reasoning,
    ]),
    cost: part?.cost ?? ev.cost,
  })
}

function usageFromValues(values: Record<string, unknown>): UsageReceipt | null {
  const inputTokens = nonnegativeFinite(values.input_tokens)
  const outputTokens = nonnegativeFinite(values.output_tokens)
  const cost = nonnegativeFinite(values.cost)
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return null
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  }
}

export function isStepReceipt(ev: Record<string, unknown>): boolean {
  const type = String(ev.type ?? '')
  const partType = String((ev.part as Record<string, unknown> | undefined)?.type ?? '')
  return type === 'step_finish'
    || type === 'step-finish'
    || partType === 'step_finish'
    || partType === 'step-finish'
}

export function addUsage(total: UsageTotal | undefined, next: UsageReceipt): UsageTotal {
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined ? right : right === undefined ? left : left + right
  return {
    receipt: {
      input_tokens: sum(total?.receipt.input_tokens, next.input_tokens),
      output_tokens: sum(total?.receipt.output_tokens, next.output_tokens),
      cost: sum(total?.receipt.cost, next.cost),
    },
    costComplete: (total?.costComplete ?? true) && next.cost !== undefined,
  }
}

export function completeUsage(total: UsageTotal): UsageReceipt {
  return {
    ...(total.receipt.input_tokens !== undefined
      ? { input_tokens: total.receipt.input_tokens }
      : {}),
    ...(total.receipt.output_tokens !== undefined
      ? { output_tokens: total.receipt.output_tokens }
      : {}),
    ...(total.costComplete && total.receipt.cost !== undefined
      ? { cost: total.receipt.cost }
      : {}),
  }
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sumKnown(values: unknown[]): number | undefined {
  let total = 0
  let sawValue = false
  for (const value of values) {
    const numeric = nonnegativeFinite(value)
    if (numeric === undefined) continue
    total += numeric
    sawValue = true
  }
  return sawValue ? total : undefined
}

export function extractText(ev: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
    (ev.part as Record<string, unknown> | undefined)?.text,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}
