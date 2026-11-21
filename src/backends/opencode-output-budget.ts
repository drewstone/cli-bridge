import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * OpenCode normalizes omitted counters to zero. Once a model has answered, a
 * zero sum cannot establish unused capacity. Positive visible and reasoning
 * counts are disjoint in its native step receipt. This same reader is embedded
 * in the native plugin, so it must remain self-contained.
 */
export function verifiedStepOutput(tokens: Record<string, unknown> | undefined, reason: unknown): number | undefined {
  const output = tokens?.output === undefined ? tokens?.output_tokens : tokens.output
  const reasoning = tokens?.reasoning
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0
    || typeof reasoning !== 'number' || !Number.isSafeInteger(reasoning) || reasoning < 0) return undefined
  const total = output + reasoning
  if (!Number.isSafeInteger(total) || total === 0) return undefined
  if (output > 0) return total
  // A provider can report only its reasoning subtotal. A tool call has
  // visible output. For a pure reasoning step, reconcile the independent
  // total with every input class before treating the subtotal as complete.
  if (typeof reason !== 'string' || !reason || reason === 'tool-calls' || reason === 'tool_calls') return undefined
  const cache = tokens?.cache as Record<string, unknown> | undefined
  const inputs = [tokens?.input, cache?.read, cache?.write]
  let accounted = total
  for (const value of inputs) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
    accounted += value
  }
  return Number.isSafeInteger(accounted) && accounted === tokens?.total ? total : undefined
}

/** Install the turn's budget plugin in its private OpenCode configuration. */
export function installOutputCapPlugin(configDir: string, cap: number): void {
  const pluginDir = join(configDir, 'plugin')
  mkdirSync(pluginDir, { recursive: true, mode: 0o755 })
  writeFileSync(join(pluginDir, 'cli-bridge-output-cap.js'), outputCapPluginSource(cap), { mode: 0o644 })
}

/** The per-turn output-budget plugin with this turn's cap baked in. Never mentions caller data. */
export function outputCapPluginSource(cap: number): string {
  return `// Written by cli-bridge for one capped turn. OpenCode 1.18.30 announces a
// new assistant before chat.params. The hook names its user; the start and
// finish parts of this model step name that assistant in the same session.
export const CliBridgeOutputCap = async () => {
  const CAP = ${String(cap)}
  const verifiedStepOutput = ${verifiedStepOutput.toString()}
  const hasID = value => typeof value === 'string' && value.trim().length > 0
  const assistants = new Set()
  const pending = new Map()
  const settled = new Set()
  let available = CAP
  let lease = null
  let unmeasured = false
  return {
    'chat.params': async (input, params) => {
      if (lease !== null) {
        throw new Error('cli-bridge: refusing an overlapping model call: the previous call holds the output budget and has not settled on a receipt')
      }
      if (available <= 0) {
        throw new Error('cli-bridge: the ' + CAP + '-token output budget ' + (unmeasured ? 'is reserved because native usage is unknown' : 'is spent'))
      }
      const base = Number.isSafeInteger(params.maxOutputTokens) && params.maxOutputTokens > 0 ? params.maxOutputTokens : CAP
      const ask = Math.min(available, base)
      const sessionID = input?.sessionID
      const user = input?.message
      const key = JSON.stringify([sessionID, user?.id])
      const assistant = user?.role === 'user' && user.sessionID === sessionID ? pending.get(key) : undefined
      pending.delete(key)
      available -= ask
      lease = { ask, sessionID, assistant }
      params.maxOutputTokens = ask
    },
    event: async ({ event }) => {
      if (event?.type === 'message.updated') {
        const msg = event.properties?.info
        if (msg?.role !== 'assistant' || !hasID(msg.id) || !hasID(msg.parentID) || !hasID(msg.sessionID)) return
        const key = JSON.stringify([msg.sessionID, msg.parentID])
        const identity = JSON.stringify([msg.sessionID, msg.id])
        if (assistants.has(identity)) {
          if ((msg.finish || msg.error || msg.time?.completed !== undefined) && pending.get(key) === msg.id) pending.delete(key)
          return
        }
        assistants.add(identity)
        if (msg.finish || msg.error || msg.time?.completed !== undefined) return
        // Two candidates for the same user cannot identify this request.
        pending.set(key, pending.has(key) ? null : msg.id)
        return
      }
      const part = event?.properties?.part
      if (event?.type !== 'message.part.updated' || !part) return
      const identified = hasID(part.id) && hasID(part.sessionID) && hasID(part.messageID)
      const matches = identified && lease !== null && part.sessionID === lease.sessionID && part.messageID === lease.assistant
      if (part.type === 'step-start' || part.type === 'step_start') {
        if (matches) lease.start = lease.start === undefined || lease.start === part.id ? part.id : null
        return
      }
      if (part.type !== 'step-finish' && part.type !== 'step_finish') return
      if (identified) {
        const key = JSON.stringify([part.sessionID, part.messageID, part.id])
        if (settled.has(key)) return
        settled.add(key)
      }
      const billed = verifiedStepOutput(part.tokens, part.reason)
      if (billed === undefined) unmeasured = true
      if (matches && hasID(lease.start)) {
        // Unknown spend consumes this reservation. It is not billed telemetry.
        if (billed !== undefined) available += lease.ask - billed
        lease = null
      } else {
        // A different or unidentifiable attempt cannot return this lease.
        available -= billed ?? CAP
      }
    },
  }
}
`
}
