import type { ChatDelta } from './types.js'

type ToolCallDelta = NonNullable<ChatDelta['tool_calls']>[number]

export class PiToolCallTracker {
  private readonly emitted = new Set<string>()
  private readonly byIndex = new Map<number, string>()
  private nextSyntheticId = 0

  observe(ev: Record<string, unknown>, eventType: string): ToolCallDelta | null {
    const normalized = normalizePiEventType(eventType)
    if (!isPiToolLifecycleEvent(normalized)) return null

    const tool = this.pickNestedTool(ev)
    const id = this.pickToolCallId(ev, tool) ?? this.idForContentIndex(ev)
    const name = this.pickToolName(ev, tool)
    const args = this.pickToolArguments(ev, tool)

    if (!id || !name || this.emitted.has(id)) return null
    if (this.shouldDefer(normalized, args)) return null
    this.emitted.add(id)
    return {
      id,
      name,
      arguments: stringifyToolArguments(args),
    }
  }

  private shouldDefer(normalized: string, args: unknown): boolean {
    // Pi's real `toolcall_start` frame usually has id/name and an empty
    // arguments object; `toolcall_delta` then streams partial JSON and may
    // start with delta:"". Wait for `toolcall_end` / `tool_execution_start`
    // with the complete args. Emitting early would make every downstream trace
    // see `{}` or an incomplete path forever because tool calls are de-duped.
    if (normalized.includes('delta')) return true
    return normalized.includes('start') && !normalized.startsWith('tool_execution') && isEmptyToolArguments(args)
  }

  private pickToolCallId(ev: Record<string, unknown>, tool: Record<string, unknown> | null): string | null {
    for (const key of ['id', 'toolCallId', 'toolCallID', 'tool_call_id', 'callId', 'callID']) {
      const value = ev[key]
      if (typeof value === 'string' && value.length > 0) return value
    }

    if (tool) {
      for (const key of ['id', 'toolCallId', 'toolCallID', 'tool_call_id', 'callId', 'callID']) {
        const value = tool[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }

    return null
  }

  private idForContentIndex(ev: Record<string, unknown>): string {
    const raw = ev.contentIndex ?? ev.content_index ?? ev.index
    const index = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(index)) {
      const existing = this.byIndex.get(index)
      if (existing) return existing
      const id = `pi_call_${index}`
      this.byIndex.set(index, id)
      return id
    }

    this.nextSyntheticId += 1
    return `pi_call_${this.nextSyntheticId}`
  }

  private pickToolName(ev: Record<string, unknown>, tool: Record<string, unknown> | null): string | null {
    for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
      const value = ev[key]
      if (typeof value === 'string' && value.length > 0) return value
    }

    if (tool) {
      for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
        const value = tool[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }

    return null
  }

  private pickToolArguments(ev: Record<string, unknown>, tool: Record<string, unknown> | null): unknown {
    for (const key of ['input', 'arguments', 'args', 'parameters', 'delta']) {
      if (ev[key] !== undefined) return ev[key]
    }

    if (tool) {
      for (const key of ['input', 'arguments', 'args', 'parameters', 'partialArgs']) {
        if (tool[key] !== undefined) return tool[key]
      }
    }

    return {}
  }

  private pickNestedTool(ev: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of ['toolCall', 'tool_call', 'toolCallRequest', 'tool_call_request', 'tool']) {
      const value = ev[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    }
    const partial = ev.partial
    if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
      const content = (partial as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && !Array.isArray(block)) {
            const candidate = block as Record<string, unknown>
            const kind = String(candidate.type ?? '')
              .replace(/-/g, '_')
              .toLowerCase()
            if (kind === 'toolcall' || kind === 'tool_call') return candidate
          }
        }
      }
    }
    return null
  }
}

function normalizePiEventType(eventType: string): string {
  return eventType.replace(/-/g, '_').toLowerCase()
}

function isPiToolLifecycleEvent(normalized: string): boolean {
  return normalized.includes('tool_call') || normalized.includes('toolcall') || normalized.startsWith('tool_execution')
}

function isEmptyToolArguments(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.length === 0
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length === 0
  return Object.keys(value as Record<string, unknown>).length === 0
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}
