import type { ChatRequest } from './types.js'
import type { Spawner } from '../executors/types.js'

export interface ClaudeStreamInit {
  type: 'system'
  subtype: 'init'
  session_id: string
  model?: string
}

export interface ClaudeStreamAssistant {
  type: 'assistant'
  message: {
    id: string
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
    stop_reason?: string | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  session_id?: string
}

export interface ClaudeStreamResult {
  type: 'result'
  subtype: string
  session_id: string
  is_error?: boolean
  result?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  total_cost_usd?: number
}

export type ClaudeStreamLine = ClaudeStreamInit | ClaudeStreamAssistant | ClaudeStreamResult | { type: string }

const MAX_UPSTREAM_ERROR_DETAIL_CHARS = 300

export function sanitizeUpstreamErrorDetail(detail: string | undefined): string {
  const fallback = 'provider returned an error result'
  if (!detail) return fallback
  const sanitized = detail
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]+/gu, ' ')
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
    .replace(/\s+/gu, ' ')
    .trim()
  return (sanitized || fallback).slice(0, MAX_UPSTREAM_ERROR_DETAIL_CHARS)
}

export interface ClaudeBackendOptions {
  bin: string
  timeoutMs: number
  harness?: string
  anthropicBaseUrl?: string | null
  spawner?: Spawner
}

export function claudeEffort(
  effort: ChatRequest['effort'],
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  if (!effort) return null
  if (effort === 'none' || effort === 'minimal') return 'low'
  if (effort === 'ultracode') return 'max'
  return effort
}
