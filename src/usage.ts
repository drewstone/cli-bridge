/**
 * Token/cost accumulation over a delta stream.
 *
 * One implementation, deliberately: the usage the caller receives in the
 * completion body and the usage written to the trace have to be the same
 * arithmetic, or the trace quietly becomes a second source of truth that
 * disagrees with the invoice.
 */

import type { ChatDelta } from './backends/types.js'

export interface CollectedUsage {
  /** True after at least one token-bearing receipt; cost-only receipts do not affect completeness. */
  hasTokenUsage: boolean
  inputTokens: number
  inputTokensKnown: boolean
  freshInputTokens: number
  freshInputTokensKnown: boolean
  cacheReadInputTokens: number
  cacheReadInputTokensKnown: boolean
  cacheWriteInputTokens: number
  cacheWriteInputTokensKnown: boolean
  outputTokens: number
  outputTokensKnown: boolean
  cost: number
  /**
   * False when any contributing record omitted `cost`, which makes `cost` a
   * floor rather than a total. A consumer that treats a floor as a total
   * understates spend by exactly the records that reported none.
   */
  costComplete: boolean
  costProvenance?: 'provider-receipt' | 'billing-receipt'
  estimatedCost: number
  /** True only when a total catalog estimate covers every contributing call. */
  estimatedCostComplete: boolean
  /** True when any contributing record was derived from text rather than measured. */
  estimated: boolean
}

/**
 * Fold one usage record into the running total.
 *
 * Token counts are incremental — a backend may emit one record per model call.
 * Cost is incremental too unless the record declares `cost_scope: 'total'`, which
 * asserts it covers everything emitted so far and therefore REPLACES the sum.
 */
export function addUsage(
  current: CollectedUsage | undefined,
  next: NonNullable<ChatDelta['usage']>,
): CollectedUsage {
  const totalCost = next.cost_scope === 'total'
  const hasTokenReceipt = nonnegativeFinite(next.input_tokens)
    || nonnegativeFinite(next.fresh_input_tokens)
    || nonnegativeFinite(next.cache_read_input_tokens)
    || nonnegativeFinite(next.cache_write_input_tokens)
    || nonnegativeFinite(next.output_tokens)
  const hadTokenReceipt = current?.hasTokenUsage ?? false
  const trustedProvenance = next.cost_provenance === 'provider-receipt'
    || next.cost_provenance === 'billing-receipt'
    ? next.cost_provenance
    : undefined
  const trustedCost = next.cost_known === true
    && trustedProvenance !== undefined
    && nonnegativeFinite(next.cost)
      ? next.cost
      : undefined
  const catalogEstimate = next.cost_known !== true
    && next.cost_provenance === 'catalog-estimate'
    && nonnegativeFinite(next.estimated_cost)
      ? next.estimated_cost
      : undefined
  return {
    hasTokenUsage: hadTokenReceipt || hasTokenReceipt,
    inputTokens: (current?.inputTokens ?? 0) + finiteTokenCount(next.input_tokens),
    inputTokensKnown: hasTokenReceipt
      ? (!hadTokenReceipt || current?.inputTokensKnown === true) && nonnegativeFinite(next.input_tokens)
      : current?.inputTokensKnown ?? false,
    freshInputTokens: (current?.freshInputTokens ?? 0) + finiteTokenCount(next.fresh_input_tokens),
    freshInputTokensKnown: hasTokenReceipt
      ? (!hadTokenReceipt || current?.freshInputTokensKnown === true) && nonnegativeFinite(next.fresh_input_tokens)
      : current?.freshInputTokensKnown ?? false,
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + finiteTokenCount(next.cache_read_input_tokens),
    cacheReadInputTokensKnown: hasTokenReceipt
      ? (!hadTokenReceipt || current?.cacheReadInputTokensKnown === true) && nonnegativeFinite(next.cache_read_input_tokens)
      : current?.cacheReadInputTokensKnown ?? false,
    cacheWriteInputTokens: (current?.cacheWriteInputTokens ?? 0) + finiteTokenCount(next.cache_write_input_tokens),
    cacheWriteInputTokensKnown: hasTokenReceipt
      ? (!hadTokenReceipt || current?.cacheWriteInputTokensKnown === true) && nonnegativeFinite(next.cache_write_input_tokens)
      : current?.cacheWriteInputTokensKnown ?? false,
    outputTokens: (current?.outputTokens ?? 0) + finiteTokenCount(next.output_tokens),
    outputTokensKnown: hasTokenReceipt
      ? (!hadTokenReceipt || current?.outputTokensKnown === true) && nonnegativeFinite(next.output_tokens)
      : current?.outputTokensKnown ?? false,
    cost: totalCost ? (trustedCost ?? 0) : (current?.cost ?? 0) + (trustedCost ?? 0),
    costComplete: totalCost
      ? trustedCost !== undefined
      : (current?.costComplete ?? true) && trustedCost !== undefined,
    ...(trustedCost !== undefined
      ? { costProvenance: trustedProvenance }
      : current?.costProvenance
        ? { costProvenance: current.costProvenance }
        : {}),
    estimatedCost: totalCost
      ? (catalogEstimate ?? 0)
      : (current?.estimatedCost ?? 0) + (catalogEstimate ?? 0),
    estimatedCostComplete: totalCost
      ? catalogEstimate !== undefined
      : (current?.estimatedCostComplete ?? true) && catalogEstimate !== undefined,
    estimated: (current?.estimated ?? false) || next.estimated === true,
  }
}

function nonnegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function finiteTokenCount(value: number | undefined): number {
  return nonnegativeFinite(value) ? value : 0
}
