import type { ChatRequest } from './types.js'

export function ensureK2DefaultConfig(config: string): string {
  const nextDefault = 'default_model = "kimi-code/kimi-k2.6"'
  let next = config
  if (/^default_model\s*=.*$/m.test(next)) next = next.replace(/^default_model\s*=.*$/m, nextDefault)
  else next = `${nextDefault}\n${next}`
  if (!/\[models\."kimi-code\/kimi-k2\.6"\]/.test(next)) {
    next += '\n\n[models."kimi-code/kimi-k2.6"]\n'
    next += 'provider = "managed:kimi-code"\n'
    next += 'model = "kimi-k2.6"\n'
    next += 'max_context_size = 262144\n'
    next += 'capabilities = ["thinking", "video_in", "image_in"]\n'
    next += 'display_name = "Kimi-k2.6"\n'
  }
  return next
}

export function thinkingFlagForEffort(effort: ChatRequest['effort']): '--thinking' | '--no-thinking' | null {
  if (!effort || effort === 'medium') return null
  if (effort === 'none' || effort === 'minimal' || effort === 'low') return '--no-thinking'
  return '--thinking'
}

export function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const key of ['session_id', 'sessionId', 'session', 'id']) {
    const value = ev[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'object' && value !== null) {
      const id = (value as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return null
}

export function extractText(ev: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
  ]
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return null
}

export function extractToolUse(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const type = String(ev.type ?? '').toLowerCase()
  if (!type.includes('tool')) return null
  const id = String(ev.id ?? ev.tool_use_id ?? '')
  const name = String(ev.name ?? ev.tool ?? '')
  const input = ev.input ?? ev.arguments ?? {}
  if (!id || !name) return null
  return { id, name, arguments: typeof input === 'string' ? input : JSON.stringify(input) }
}
