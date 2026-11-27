/**
 * DeepSeek Harness's token counts. Its ACP answers carry none, but it keeps each session's running totals
 * in its projection cache, `<DSH_HOME or ~/.dsh>/storages/session_projcache/sessions/<session id>.json`, at
 * `record.rows.tokenUsage.val.totals` (`uncachedInputTokens`, `outputTokens`, `cacheReadTokens`,
 * `cacheWriteTokens`). Measured on 0.2.2-rc.1 against the Router's scripted model: a prompt that asked for
 * usage 1234 56 left totals of 1234 and 56, and a second prompt of 100 and 7 left 1334 and 63. The
 * harness writes the file as a turn ends, so a reader polls for the totals to move (acpUsageSince).
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpUsage } from './acp-native-session.js'

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

/** The session's running totals, ACP's names: the prompt count includes its cached part. */
export function dshTotals(cache: unknown): AcpUsage | undefined {
  const totals = record(record(record(record(record(cache)?.record)?.rows)?.tokenUsage)?.val)?.totals
  const buckets = record(totals)
  if (!buckets) return undefined
  const cacheRead = count(buckets.cacheReadTokens), cacheWrite = count(buckets.cacheWriteTokens)
  return {
    inputTokens: count(buckets.uncachedInputTokens) + cacheRead + cacheWrite,
    outputTokens: count(buckets.outputTokens),
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
  }
}

export async function dshSessionUsage(agentSessionId: string): Promise<AcpUsage | undefined> {
  if (!/^[\w.-]{1,128}$/u.test(agentSessionId)) return undefined
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${agentSessionId}.json`)
  const text = await readFile(file, 'utf8').catch(() => '')
  try { return dshTotals(JSON.parse(text)) } catch { return undefined }
}
