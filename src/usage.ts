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
  inputTokens: number
  outputTokens: number
  cost: number
  /**
   * False when any contributing record omitted `cost`, which makes `cost` a
   * floor rather than a total. A consumer that treats a floor as a total
   * understates spend by exactly the records that reported none.
   */
  costComplete: boolean
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
  return {
    inputTokens: (current?.inputTokens ?? 0) + (next.input_tokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.output_tokens ?? 0),
    cost: totalCost ? (next.cost ?? 0) : (current?.cost ?? 0) + (next.cost ?? 0),
    costComplete: totalCost
      ? next.cost !== undefined
      : (current?.costComplete ?? true) && next.cost !== undefined,
    estimated: (current?.estimated ?? false) || next.estimated === true,
  }
}
