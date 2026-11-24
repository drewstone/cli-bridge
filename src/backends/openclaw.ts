/**
 * OpenClaw backend: one embedded agent turn per request, `openclaw agent --local --json`.
 *
 * Why not `openclaw acp`: on OpenClaw 2026.11.5 it is "an ACP bridge backed by the Gateway"
 * (`openclaw acp --help`). It dials a separately running Gateway (`connect ECONNREFUSED
 * 127.0.0.1:18789` without one), and its own reference (docs/cli/acp.md, compatibility matrix) lists
 * per-session `mcpServers` as Unsupported in bridge mode. `agent --local` runs the embedded agent
 * from the operator's config with no Gateway.
 *
 * Measured on 2026.11.5 against the Router's scripted model:
 * - stdout is one JSON document. `payloads[].text` is the reply and `meta.agentMeta.usage` the turn's
 *   tokens (`input`, `output`, `cacheRead`, `cacheWrite`); a refused turn exits 1 with
 *   `{ error: { type, message } }`.
 * - `--session-id <id>` creates that session or continues it. A turn killed mid-run leaves a lease
 *   the next turn reclaims ("stale lease: owner-pid-dead").
 * - MCP servers come only from config (`mcp.servers`), so a request's servers ride a per-run copy of
 *   the operator's config, named by OPENCLAW_CONFIG_PATH.
 *
 * Model ids: `openclaw` runs the config's default model; `openclaw/<model>` passes `--model <model>`
 * (`openclaw/tangle/tangle/canary-echo` → the config's `tangle` provider, model `tangle/canary-echo`).
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend, BackendHealth, ChatDelta, ChatRequest, McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import type { Spawner } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { contentToText } from './content.js'
import { resolveMcpServers } from './profile-mcp.js'
import { resolvePromptMessages } from './profile-prompt.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { versionHealth } from './health.js'
import { readProcessLines, waitForHarnessExit } from './process-lines.js'
import { registerJailReadable } from '../jail/index.js'

export interface OpenclawBackendOptions {
  bin: string
  /** Operator fallback when the caller omits `execution.timeoutMs`; zero means none. */
  timeoutMs: number
  spawner?: Spawner
}

/** The session ids this backend passes to `--session-id`: the CLI files sessions under them. */
const OPENCLAW_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export class OpenclawBackend implements Backend {
  readonly name = 'openclaw'
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner

  constructor(private readonly opts: OpenclawBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()
    // `openclaw agent` has no system-prompt control; a profile prompt intent is refused here, and the
    // profile summary and any prior messages fold into the one message.
    const messages = resolvePromptMessages(req, session, this.name)
    const message = messages.length === 1 ? contentToText(messages[0]!.content)
      : messages.map((m) => (m.role === 'user' ? contentToText(m.content) : `[${m.role}] ${contentToText(m.content)}`)).join('\n\n')
    if (!message.trim()) throw new BackendError('backend openclaw received no message text', 'parse_error')
    const sessionId = openclawSessionId(req.session_id, session?.internalId)
    const model = req.model === this.name ? null : req.model.slice(`${this.name}/`.length)
    const args = ['agent', '--local', '--json', '--session-id', sessionId, ...(model ? ['--model', model] : []), '--message-file', '-']

    const overlay = mcpConfigOverlay(resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true }))
    if (overlay) registerJailReadable(req.jailSpec, overlay.dir)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_NONINTERACTIVE: '1',
      // openclaw's file and exec tools resolve against its agent workspace, not the process cwd.
      OPENCLAW_WORKSPACE_DIR: cwd,
      ...(overlay ? { OPENCLAW_CONFIG_PATH: overlay.path } : {}),
    }
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env,
        // The host allowlist drops unlisted names; OpenClaw's own settings pass by exact name.
        envPassthroughKeys: Object.keys(env).filter((key) => key.startsWith('OPENCLAW_')),
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      })
    } catch (error) {
      overlay?.cleanup()
      throw error
    }
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const spawnError = spawned.spawnError?.()
      if (spawnError) throw new BackendError(`openclaw spawn failed: ${spawnError.message}`, 'upstream')
      if (!spawned.child.stdin || !spawned.child.stdout) throw new BackendError('openclaw subprocess has no stdio pipes', 'upstream')
      const stderr = new BoundedDiagnosticBuffer()
      spawned.child.stderr?.on('data', (chunk) => { stderr.append(chunk) })
      spawned.child.stdin.end(message)
      yield { internal_session_id: sessionId }
      const lines: string[] = []
      for await (const next of readProcessLines({ child: spawned.child, stdout: spawned.child.stdout, progressIntervalMs: 30_000 })) {
        if (next.kind === 'progress') yield { keepalive: { source: 'openclaw', elapsedMs: next.elapsedMs } }
        else lines.push(next.line)
      }
      const exit = await waitForHarnessExit(spawned)
      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }
      const result = parseResult(lines.join('\n'))
      const failure = record(result?.error)
      if (failure || exit.code !== 0 || !result) {
        const detail = typeof failure?.message === 'string' ? failure.message : stderr.render(600) || `exit ${exit.code ?? exit.signal}`
        throw new BackendError(`openclaw turn failed${typeof failure?.type === 'string' ? ` (${failure.type})` : ''}: ${detail}`, 'upstream')
      }
      const text = (Array.isArray(result.payloads) ? result.payloads : [])
        .map((payload) => record(payload)?.text).filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n\n')
      if (text) yield { content: text }
      const usage = turnUsage(record(record(record(result.meta)?.agentMeta)?.usage))
      if (usage) yield { usage }
      yield { finish_reason: 'stop' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await terminateSpawned(spawned)
      spawned.release()
      overlay?.cleanup()
    }
  }
}

/**
 * The `--session-id` for this turn: the one the Bridge session recorded, else one derived from the
 * Bridge session id (so its turns share one OpenClaw session), else a fresh one.
 */
function openclawSessionId(requestSessionId: string | undefined, recorded: string | undefined): string {
  if (recorded && OPENCLAW_SESSION_ID.test(recorded)) return recorded
  if (requestSessionId) return `cli-bridge-${createHash('sha256').update(requestSessionId).digest('hex').slice(0, 32)}`
  return `cli-bridge-${randomUUID()}`
}

/**
 * A per-run copy of the operator's config (OPENCLAW_CONFIG_PATH, else ~/.openclaw/openclaw.json)
 * with the request's MCP servers added to `mcp.servers`, or null when none are requested. The copy
 * lives in its own directory, so a config that names files by relative path is refused.
 */
function mcpConfigOverlay(specs: Record<string, McpServerSpec> | null): { dir: string; path: string; cleanup: () => void } | null {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs ?? {})) {
    if (spec.enabled === false) continue
    if (spec.command) {
      servers[name] = { command: spec.command, ...(spec.args?.length ? { args: spec.args } : {}), ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}) }
    } else if (spec.url) {
      servers[name] = { url: spec.url, transport: spec.type === 'sse' ? 'sse' : 'streamable-http',
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}) }
    } else throw new BackendError(`backend openclaw cannot mount MCP server ${JSON.stringify(name)}: it names neither a command nor a url`, 'not_configured')
    if (spec.timeout !== undefined) servers[name]!.requestTimeoutMs = spec.timeout
  }
  if (Object.keys(servers).length === 0) return null
  const source = process.env.OPENCLAW_CONFIG_PATH || join(process.env.HOME || homedir(), '.openclaw', 'openclaw.json')
  let config: Record<string, unknown> = {}
  if (existsSync(source)) {
    const text = readFileSync(source, 'utf8')
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      throw new BackendError(`backend openclaw cannot add MCP servers to ${source}: it is not plain JSON`, 'not_configured')
    }
    if (!record(parsed)) throw new BackendError(`backend openclaw cannot add MCP servers to ${source}: it is not a JSON object`, 'not_configured')
    if (text.includes('$include')) throw new BackendError(`backend openclaw cannot add MCP servers to ${source}: it includes other files by relative path`, 'not_configured')
    config = parsed as Record<string, unknown>
  }
  const mcp = record(config.mcp) ?? {}
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-openclaw-'))
  const path = join(dir, 'openclaw.json')
  writeFileSync(path, `${JSON.stringify({ ...config, mcp: { ...mcp, servers: { ...(record(mcp.servers) ?? {}), ...servers } } }, null, 2)}\n`, { mode: 0o600 })
  return { dir, path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } }
}

function parseResult(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try { return record(JSON.parse(stdout.slice(start))) ?? null } catch { return null }
}

/** `meta.agentMeta.usage`, the turn's model calls together: `input` is the uncached prompt; cache reads and writes are counted apart. */
function turnUsage(usage: Record<string, unknown> | undefined): ChatDelta['usage'] | undefined {
  const count = (key: string): number => (typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] as number : 0)
  const fresh = count('input'), cacheRead = count('cacheRead'), cacheWrite = count('cacheWrite'), output = count('output')
  if (fresh + cacheRead + cacheWrite + output === 0) return undefined
  return { input_tokens: fresh + cacheRead + cacheWrite, fresh_input_tokens: fresh,
    cache_read_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite, output_tokens: output }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
