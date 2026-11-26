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
 * - Exo (`exo run`) reads an agent definition file: its model, base URL and vault credential, and MCP
 *   servers by URL only. The Bridge relays the turn's stdio servers by URL (mcp-url-relay.ts) and lets
 *   each one's tools run without asking (`permission_policy: always_allow`); Exo asks on stdin otherwise.
 *   A thread resumes (`--thread`) only under the definition file it was created with, so a Bridge
 *   session keeps one file. The key is a vault secret for the turn, read from `EXO_MODEL_API_KEY`. Usage
 *   is in the thread's event log (`exo thread events`), per model call, by turn.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OneShotHarnessName } from '../config.js'
import { BackendError } from './types.js'
import type { OneShotAgent, OneShotRead } from './one-shot.js'
import { McpUrlRelay } from './mcp-url-relay.js'

const run = promisify(execFile)

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const count = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}
const json = (line: string): Record<string, unknown> | null => {
  try { return record(JSON.parse(line)) } catch { return null }
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

const EXO_KEY_ENV = 'EXO_MODEL_API_KEY'
const relay = new McpUrlRelay()

const exo: OneShotAgent = {
  envPassthroughKeys: ['EXO_HOME', 'EXO_SECRET_BACKEND', 'EXO_MASTER_KEY_PATH', 'EXO_CONFIG_DIR'],
  async launch(turn) {
    const model = turn.model ?? process.env.EXO_MODEL
    const baseUrl = process.env.EXO_MODEL_BASE_URL
    if (!model || !baseUrl || !process.env[EXO_KEY_ENV]) {
      throw new BackendError(`exo needs EXO_MODEL_BASE_URL and ${EXO_KEY_ENV}, and a model: request exo/<model> or set EXO_MODEL`, 'not_configured')
    }
    const home = process.env.EXO_HOME || join(homedir(), '.exo')
    const env = { EXO_HOME: home }
    const exoCli = (args: string[], extra: Record<string, string> = {}) =>
      run(turn.bin, args, { cwd: turn.cwd, env: { ...process.env, ...env, ...extra }, timeout: 30_000, maxBuffer: 16 << 20 })
    // A thread resumes only under the definition it was created with; a turn outside a session gets its own.
    const slug = `bridge-${createHash('sha256').update(turn.sessionKey ?? randomBytes(16).toString('hex')).digest('hex').slice(0, 16)}`
    const file = join(home, 'bridge-agents', `${slug}.md`)
    const credential = `bridge-${randomBytes(8).toString('hex')}`
    let served: Awaited<ReturnType<McpUrlRelay['serve']>> | null = null
    let secret = false
    const cleanup = async (): Promise<void> => {
      await served?.close()
      if (secret) await exoCli(['vault', 'secret', 'delete', 'global', credential]).catch(() => undefined)
    }
    try {
      served = turn.mcp ? await relay.serve(turn.mcp, turn.cwd, turn.sessionKey) : null
      await exoCli(['vault', 'secret', 'create', 'global', credential, '--token-env', EXO_KEY_ENV, '--allow-origin', new URL(baseUrl).origin])
        .catch((error: { stderr?: string }) => { throw new BackendError(`exo vault secret create failed: ${String(error.stderr ?? '').slice(-300)}`, 'not_configured') })
      secret = true
      await mkdir(join(home, 'bridge-agents'), { recursive: true, mode: 0o700 })
      // JSON strings are YAML scalars, so no value can break the front matter.
      await writeFile(file, [
        '---', 'harness: basic', 'model:', `  name: ${JSON.stringify(model)}`, `  base_url: ${JSON.stringify(baseUrl)}`, `  credential: ${credential}`,
        ...(served ? ['mcp_servers:', ...Object.entries(served.urls).flatMap(([name, url]) => [
          '  - type: url', `    name: ${JSON.stringify(name)}`, `    url: ${JSON.stringify(url)}`, '    permission_policy:', '      type: always_allow'])] : []),
        '---', '', 'You are a coding agent working in this directory.', '',
      ].join('\n'), { mode: 0o600 })
    } catch (error) {
      await cleanup()
      throw error
    }
    let agentId: string | null = null
    let replying = false
    const args = ['run', file, '--sandbox', 'local-process', '--mount', `${turn.cwd}:/workspace:rw`, '--verbosity', 'minimal']
    if (turn.resume) args.push('--thread', turn.resume)
    args.push(`--prompt=${turn.prompt}`)
    return {
      args,
      env,
      // stdout: `agent: <slug> (<id>)` and `thread: <slug> (<id>)` headers, then `[HH:MM:SS] agent: <reply>`
      // and a closing `duration:` stats line.
      stdout(line): OneShotRead | null {
        const reply = /^\[\d\d:\d\d:\d\d\] agent: (.*)$/u.exec(line)
        if (reply) { replying = true; return { line: reply[1] ?? '' } }
        if (/^(ttft: \S+, )?duration: \d/u.test(line)) { replying = false; return null }
        if (replying) return { line }
        const named = /^(agent|thread): \S+ \(([0-9a-f-]{36})\)$/u.exec(line)
        if (named?.[1] === 'agent') agentId = named[2]!
        return named?.[1] === 'thread' ? { sessionId: named[2]! } : null
      },
      async after({ sessionId }) {
        if (!agentId || !sessionId) return null
        // The reply stands without its usage when the log cannot be read.
        const page = await exoCli(['thread', 'events', agentId, sessionId, '--type', 'messages', '--desc', '--limit', '200'])
          .then(({ stdout }) => record(JSON.parse(stdout)), () => null)
        const events = Array.isArray(page?.events) ? page.events as unknown[] : []
        // Newest first: the turn that just ran is the first event's.
        const turnId = record(events[0])?.turn_id
        let input = 0, output = 0, calls = 0
        for (const event of events.map(record)) {
          if (!event || event.turn_id !== turnId) continue
          const usage = record(record(event.data)?.usage)
          const prompt = count(usage?.prompt_tokens), completion = count(usage?.completion_tokens)
          if (prompt === null || completion === null) continue
          input += prompt; output += completion; calls += 1
        }
        return calls > 0 ? { usage: { input, output } } : null
      },
      cleanup,
    }
  },
}

export const oneShotAgents: Record<OneShotHarnessName, OneShotAgent> = { nanocode, exo }
