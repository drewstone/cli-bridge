/**
 * How each one-shot agent the Bridge drives starts, takes MCP servers, names its session and reports usage
 * (one-shot.ts). Each entry was measured on the version agent-container's image pins
 * (`infra/nix/agent-clis.json`), against the Router's scripted model with no vendor login.
 *
 * - nanocode 0.7.0 (`nc exec`) takes its route from `NANOCODE_OPENAI_BASE_URL`, `NANOCODE_OPENAI_API_KEY`
 *   and `NANOCODE_MODELS_URL`. It prints the reply alone on stdout and `session <id>` on stderr, and `-r`
 *   resumes. It reads no MCP server configuration in `exec`, so a turn with MCP servers is refused. Its
 *   usage is in its OpenTelemetry traces, one `<NANOCODE_HOME>/log/otel/<time>-<pid>/traces.jsonl` per
 *   process: each completed model call's span carries `input_tokens` and `output_tokens`.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OneShotHarnessName } from '../config.js'
import { BackendError } from './types.js'
import type { OneShotAgent } from './one-shot.js'

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const count = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}

/** Sums the completed model calls' tokens in one nanocode process's trace export. */
function nanocodeUsage(traces: string): { input: number; output: number } | null {
  let input = 0, output = 0, calls = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    const node = record(value)
    if (!node) return
    if (Array.isArray(node.attributes)) {
      const attributes = new Map<string, unknown>()
      for (const entry of node.attributes) {
        const attribute = record(entry), held = record(attribute?.value)
        if (typeof attribute?.key === 'string' && held) attributes.set(attribute.key, held.intValue ?? held.stringValue)
      }
      const inTokens = count(attributes.get('input_tokens')), outTokens = count(attributes.get('output_tokens'))
      if (inTokens !== null && outTokens !== null && (attributes.get('status') ?? 'completed') === 'completed') {
        input += inTokens; output += outTokens; calls += 1
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'attributes') visit(child)
  }
  for (const line of traces.split('\n')) {
    try { visit(JSON.parse(line)) } catch { /* a partial last line */ }
  }
  return calls > 0 ? { input, output } : null
}

const nanocode: OneShotAgent = {
  envPassthroughKeys: ['NANOCODE_HOME', 'NANOCODE_OPENAI_BASE_URL', 'NANOCODE_OPENAI_API_KEY', 'NANOCODE_MODELS_URL'],
  async launch(turn) {
    if (turn.mcp) {
      throw new BackendError('nanocode reads no MCP server configuration in `nc exec`; send this turn without MCP servers', 'capability_denied')
    }
    const home = process.env.NANOCODE_HOME || join(homedir(), '.nanocode')
    const otel = join(home, 'log', 'otel')
    const before = new Set(await readdir(otel).catch(() => [] as string[]))
    const args = ['exec', '--harness', 'codex', '-C', turn.cwd]
    if (turn.model) args.push('-m', turn.model)
    if (turn.resume) args.push('-r', turn.resume)
    args.push('--', turn.prompt)
    return {
      args,
      stdout: (line) => ({ line }),
      stderr(line) {
        const session = /^session ([0-9a-f-]{36})$/u.exec(line.trim())
        return session ? { sessionId: session[1]! } : null
      },
      async after({ pid }) {
        // The process's own export directory ends in its pid; failing that, the one it created.
        const created = (await readdir(otel).catch(() => [] as string[])).filter((name) => !before.has(name))
        const mine = created.filter((name) => pid !== undefined && name.endsWith(`-${pid}`))
        const dir = mine.length === 1 ? mine[0] : created.length === 1 ? created[0] : undefined
        if (!dir) return null
        const usage = nanocodeUsage(await readFile(join(otel, dir, 'traces.jsonl'), 'utf8').catch(() => ''))
        return usage ? { usage } : null
      },
    }
  },
}

export const oneShotAgents: Record<OneShotHarnessName, OneShotAgent> = { nanocode }
