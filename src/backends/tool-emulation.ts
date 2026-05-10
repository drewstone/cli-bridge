/**
 * Tool-call emulation for CLI backends that don't natively forward
 * caller-supplied tool definitions to the model.
 *
 * The OpenAI Chat Completions tool-calling protocol is multi-turn at the
 * HTTP layer: the caller sends `tools[]`, the model returns `tool_calls`,
 * the caller executes them and sends results back as `role:"tool"` messages
 * in the next call. Most CLI harnesses (claude-code, kimi-code, opencode)
 * run their OWN tool loop in `--print` mode and don't expose the
 * tool-decision step to the caller — they just return the final answer.
 *
 * To bridge that gap without forking the harness, we instruct the model
 * via prompt to emit tool decisions in a fenced marker format and stop.
 * cli-bridge parses the markers out of the stream and yields synthetic
 * `tool_calls` deltas. The caller's main-agent loop then drives the
 * multi-turn flow normally.
 *
 * Default: **enabled** whenever the caller passes a non-empty `tools[]`
 * array. The opt-out is `BRIDGE_DISABLE_TOOL_EMULATION=1` for byte-stable
 * benchmark workloads that want the legacy pre-0.x.x behavior. cli-bridge
 * is a localhost-only, bearer-protected, single-user surface — the
 * agentic default is the right one. Silently dropping caller-supplied
 * tools (the prior default) was the worst failure mode: wrong output,
 * no error, no log.
 *
 * Migration: any benchmark that relied on the previous default must
 * either set `BRIDGE_DISABLE_TOOL_EMULATION=1` in its env or stop
 * passing `tools[]`.
 */

export interface CallerTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export type ToolChoice =
  | 'auto' | 'none' | 'required'
  | { type: 'function'; function: { name: string } }

export interface EmulatedToolCall {
  id: string
  name: string
  arguments: string
}

const FENCE_OPEN = '<<<TOOL_CALL>>>'
const FENCE_CLOSE = '<<<END_TOOL_CALL>>>'
const MARKER_RE = /<<<TOOL_CALL>>>([\s\S]*?)<<<END_TOOL_CALL>>>/g

export function isEmulationEnabled(req: { tools?: CallerTool[] | null }): boolean {
  // Default ON: emulate whenever the caller supplied tools[]. The bridge
  // is local + bearer-protected; agentic behavior is the right default
  // and silently dropping tools[] is the worst failure mode.
  // Opt-out: BRIDGE_DISABLE_TOOL_EMULATION=1 for byte-stable benchmark
  // workloads. (BRIDGE_EMULATE_TOOL_CALLS=0 is also honored as an
  // explicit kill switch — see migration note in the file header.)
  if (process.env.BRIDGE_DISABLE_TOOL_EMULATION === '1') return false
  if (process.env.BRIDGE_EMULATE_TOOL_CALLS === '0') return false
  return Array.isArray(req.tools) && req.tools.length > 0
}

/**
 * Render the system-level instruction the model sees. The wrapping
 * harness still injects its own preamble first; this is appended via
 * --append-system-prompt so it has the last word on response format.
 */
export function renderToolEmulationDirective(
  tools: CallerTool[],
  toolChoice: ToolChoice | undefined,
): string {
  const choiceLine = (() => {
    if (!toolChoice || toolChoice === 'auto') {
      return 'You may call zero or more tools, or respond with plain text if no tool is needed.'
    }
    if (toolChoice === 'none') {
      return 'Do NOT call any tools — respond with plain text only.'
    }
    if (toolChoice === 'required') {
      return 'You MUST call at least one tool. Do not answer with plain text alone.'
    }
    return `You MUST call the tool named "${toolChoice.function.name}". Do not call any other tool.`
  })()

  const toolBlock = tools.map((t) => {
    const params = t.function.parameters ? JSON.stringify(t.function.parameters) : '{}'
    const desc = t.function.description ? `\n  description: ${t.function.description}` : ''
    return `- ${t.function.name}${desc}\n  parameters: ${params}`
  }).join('\n')

  return [
    '# Caller-supplied tools',
    '',
    'The application calling you has registered the following tools. You DO NOT have',
    'access to your own built-in Read/Write/Bash/Edit. To use a tool, declare it in',
    'the format below and STOP — the application will execute it and call you again',
    'with the result.',
    '',
    choiceLine,
    '',
    '## Tool-call format (strict)',
    '',
    'Emit each tool call as a single JSON object between the markers, on its own lines:',
    '',
    FENCE_OPEN,
    '{"id": "<short-unique-id>", "name": "<tool-name>", "arguments": <json-object>}',
    FENCE_CLOSE,
    '',
    'Multiple tool calls in one turn: emit multiple marker pairs, one per call.',
    'After the last marker, STOP — do not narrate, do not continue. The application',
    'is waiting for your decision.',
    '',
    '## Available tools',
    '',
    toolBlock,
    '',
    '## Reminders',
    '- Use ONLY the caller tools above. Do not attempt Read/Bash/Edit/Write.',
    '- `arguments` MUST be a JSON object matching the tool\'s parameters schema.',
    '- If you can answer without a tool AND tool_choice allows it, respond with prose only — no markers.',
  ].join('\n')
}

/**
 * Stateful parser. Feed it streaming text chunks; it returns any complete
 * tool_calls it found in this chunk plus the residual prose (text outside
 * markers). Buffers partial markers across chunks.
 */
export class ToolMarkerParser {
  private buffer = ''
  private nextId = 0

  feed(chunk: string): { toolCalls: EmulatedToolCall[]; prose: string } {
    this.buffer += chunk
    const toolCalls: EmulatedToolCall[] = []
    const proseParts: string[] = []

    while (true) {
      const openIdx = this.buffer.indexOf(FENCE_OPEN)
      if (openIdx === -1) {
        // No open fence in buffer. Everything is prose EXCEPT a possible
        // partial-marker tail. Look for the rightmost `<` near the end —
        // if found within (FENCE_OPEN.length - 1) of the end, preserve
        // from there; otherwise the whole buffer is prose.
        const tailWindow = Math.max(0, this.buffer.length - (FENCE_OPEN.length - 1))
        const tailLT = this.buffer.indexOf('<', tailWindow)
        const safeLen = tailLT === -1 ? this.buffer.length : tailLT
        if (safeLen > 0) {
          proseParts.push(this.buffer.slice(0, safeLen))
          this.buffer = this.buffer.slice(safeLen)
        }
        break
      }
      // Anything before the open fence is prose.
      if (openIdx > 0) {
        proseParts.push(this.buffer.slice(0, openIdx))
      }
      const closeIdx = this.buffer.indexOf(FENCE_CLOSE, openIdx + FENCE_OPEN.length)
      if (closeIdx === -1) {
        // Open fence found but close not yet — preserve from open onward.
        this.buffer = this.buffer.slice(openIdx)
        break
      }
      // Complete marker — extract and parse JSON inside.
      const inner = this.buffer.slice(openIdx + FENCE_OPEN.length, closeIdx).trim()
      const tail = this.buffer.slice(closeIdx + FENCE_CLOSE.length)
      const parsed = this.parseInner(inner)
      if (parsed) {
        toolCalls.push(parsed)
        // Discard whitespace immediately after a successfully-parsed
        // marker so multiple back-to-back marker blocks read clean.
        this.buffer = tail.replace(/^\s+/, '')
      } else {
        // Malformed marker — keep the tail as prose so we don't
        // silently swallow whatever followed it.
        this.buffer = tail
      }
    }

    return { toolCalls, prose: proseParts.join('') }
  }

  /** Drain remaining buffer as prose. Call after the stream ends. */
  flush(): { toolCalls: EmulatedToolCall[]; prose: string } {
    // Flush any complete markers that snuck in at the very end.
    const final = this.feed('')
    if (this.buffer.length > 0) {
      // Treat any stray opener-without-closer as prose so it shows up
      // in the response rather than getting silently dropped.
      final.prose += this.buffer
      this.buffer = ''
    }
    return final
  }

  private parseInner(inner: string): EmulatedToolCall | null {
    // Tolerate the model wrapping the JSON in a code fence (```json ...```).
    const stripped = inner
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    try {
      const obj = JSON.parse(stripped) as { id?: string; name?: string; arguments?: unknown }
      if (typeof obj.name !== 'string' || obj.name.length === 0) return null
      const id = typeof obj.id === 'string' && obj.id.length > 0
        ? obj.id
        : `emul_${Date.now().toString(36)}_${(this.nextId++).toString(36)}`
      const args = obj.arguments == null ? '{}' : JSON.stringify(obj.arguments)
      return { id, name: obj.name, arguments: args }
    } catch {
      return null
    }
  }
}
