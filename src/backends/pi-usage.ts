import type { ChatDelta } from './types.js'
import { BackendError } from './types.js'

export interface PiUsageReceipt {
  input: number
  output: number
  cost?: number
}

export interface PiUsageCost {
  receipts: number
  total: number
  complete: boolean
}

/** Read a provider failure off a `turn_end` assistant message, or null when the turn succeeded.
 *
 *  Pi's `AssistantMessage` carries `stopReason: 'stop' | 'length' | 'toolUse' | 'error' |
 *  'aborted'` plus an optional `errorMessage` (pi 0.83.0 `docs/session-format.md`). A provider
 *  failure produces neither a `type: 'error'` event nor a non-zero exit, so this message is the
 *  only failure signal on the wire.
 *
 *  `aborted` is deliberately NOT a failure here: the caller's `AbortSignal` already owns that
 *  path and reports `finish_reason: 'error'` before this is consulted. */
export function piAssistantFailure(message: unknown): string | null {
  const value = record(message)
  if (!value) return null
  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage.trim() : ''
  if (stopReason !== 'error' && errorMessage === '') return null
  return errorMessage !== '' ? errorMessage : `stopReason=${stopReason ?? 'error'}`
}

/** Auth/scope failures are a local credential problem, not a transient upstream one, whether they
 *  arrive on pi's stderr or in the provider's error body. */
export function piFailureKind(detail: string): 'not_configured' | 'upstream' {
  return /401|403|token expired|forbidden|unauthorized/i.test(detail) ? 'not_configured' : 'upstream'
}

export function piUsageReceiptsFromEvent(ev: Record<string, unknown>): PiUsageReceipt[] {
  const message = record(ev.message)
  const partial = record(ev.partial)
  const direct = record(ev.usage) ?? record(message?.usage) ?? record(partial?.usage)
  if (direct) {
    const receipt = piUsageFromRecord(direct)
    return receipt ? [receipt] : []
  }

  if (!Array.isArray(ev.messages)) return []
  const receipts: PiUsageReceipt[] = []
  for (const item of ev.messages) {
    const usage = record(record(item)?.usage)
    if (!usage) continue
    const receipt = piUsageFromRecord(usage)
    if (receipt) receipts.push(receipt)
  }
  return receipts
}

function piUsageFromRecord(usage: Record<string, unknown>): PiUsageReceipt | undefined {
  // Native Pi usage separates fresh input, cache reads, and cache writes.
  // OpenAI prompt_tokens already includes all three, so never add cache fields
  // to that older aggregate shape.
  const nativeInput = piTokenCount(usage.input ?? usage.inputTokens, 'input')
  const openAiInput = piTokenCount(usage.prompt_tokens, 'prompt_tokens')
  const cacheRead = piTokenCount(
    usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
    'cacheRead',
  )
  const cacheWrite = piTokenCount(
    usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    'cacheWrite',
  )
  const output = piTokenCount(usage.output ?? usage.outputTokens ?? usage.completion_tokens, 'output')
  if (
    nativeInput === undefined &&
    openAiInput === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return undefined
  }

  const rawCost = usage.cost
  const nestedCost = record(rawCost)
  const cost = piCost(nestedCost ? nestedCost.total : rawCost)
  return {
    input: openAiInput ?? (nativeInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output: output ?? 0,
    ...(cost !== undefined ? { cost } : {}),
  }
}

export function piTokenUsage(receipt: PiUsageReceipt): NonNullable<ChatDelta['usage']> {
  return {
    input_tokens: receipt.input,
    output_tokens: receipt.output,
  }
}

export function recordPiUsageCost(total: PiUsageCost, receipt: PiUsageReceipt): void {
  total.receipts += 1
  if (receipt.cost === undefined) {
    total.complete = false
    return
  }
  total.total += receipt.cost
}

function piTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BackendError(`pi reported invalid ${field} token count`, 'upstream')
  }
  return value
}

function piCost(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BackendError('pi reported invalid usage cost', 'upstream')
  }
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
