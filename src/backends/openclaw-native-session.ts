/**
 * One retained OpenClaw session on a Gateway the session owns. OpenClaw steers a running turn only
 * through its Gateway; measured on 2026.11.5:
 *
 * - `/steer <text>` (alias `/tell`) is "Gateway-backed" (docs/tools/steer.md): sent as a message on
 *   the session while a run is active, it reaches the run at its next runtime boundary (after the
 *   running tool call) and gets its own delivered answer, after the run's. Through
 *   `openclaw agent --session-id <id>` against the Gateway: the running turn finished its 25 s tool and
 *   answered with its result, and the `/steer` call answered with the steered reply right after.
 * - `openclaw acp`, the Gateway's ACP bridge, cannot steer: a `session/prompt` during an active one
 *   resolves the active prompt as `cancelled` and the new text runs as its own turn (`/steer` too).
 * - The embedded agent (`agent --local`) takes no input mid-turn; its steering exists only in the
 *   interactive terminal UI.
 *
 * So the session starts `openclaw gateway run` with a per-session copy of the operator's config that
 * names its own loopback port and token and the session's MCP servers, and its own state directory
 * (a Gateway holds its state database, which a one-shot `agent --local` on the same state would find
 * busy). Each turn is one `openclaw agent --json` call on the session; a steer is one `/steer` call,
 * whose answer joins the running turn. The turn settles once every call it made has answered.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { SpawnOpts, Spawner } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { readProcessLines, waitForHarnessExit } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { openclawConfigOverlay, openclawTurnUsage, parseOpenclawResult } from './openclaw.js'
import type { McpServerSpec } from './types.js'

/** Bridge-made frame ending a turn; OpenClaw never sends this type. */
export const OPENCLAW_TURN_SETTLED = 'cli-bridge.openclaw.turn_settled'
/** One answered `openclaw agent` call of the turn: its reply text and usage. */
export const OPENCLAW_REPLY = 'cli-bridge.openclaw.reply'
const GATEWAY_READY = '[gateway] ready'
const STOP_GRACE_MS = 5_000

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export interface OpenclawNativeSessionOptions {
  bin: string
  spawner: Spawner
  capabilities: AgentEnvironmentCapabilities
  cwd: string
  /** The OpenClaw session every call of this Bridge session names with `--session-id`. */
  sessionKey: string
  mcpServers: Record<string, McpServerSpec> | null
  /** Spawn settings every process of the session shares: jail, lineage, admission. */
  spawn: Pick<SpawnOpts, 'jail' | 'lineageEnv' | 'sessionId' | 'acquireDeadlineMs'>
  /** Bound on the Gateway's start and on a `/stop`. */
  requestTimeoutMs: number
}

interface TurnState {
  /** `openclaw agent` calls of this turn that have not answered. */
  calls: Set<Awaited<ReturnType<Spawner>>>
  failure: string | null
  settled: boolean
}

export class OpenclawNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private life: NativeChild | null = null
  private env: NodeJS.ProcessEnv = {}
  private readonly cleanups: Array<() => void> = []
  private turnState: TurnState | null = null
  private completedTurns = 0
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private readyWaiter: Waiter<void> | null = null

  constructor(private readonly options: OpenclawNativeSessionOptions) {
    this.capabilities = options.capabilities
  }

  providerSessionId(): string | null { return this.options.sessionKey }
  isClosed(): boolean { return this.life?.closed ?? true }
  onClose(listener: (reason: Error) => void): () => void { return this.gateway().onClose(listener) }
  whenClosed(): Promise<void> { return this.gateway().whenClosed() }

  /** Start the session's Gateway on a free loopback port and wait until it reports ready. */
  async start(signal?: AbortSignal): Promise<void> {
    const port = await freeLoopbackPort()
    const overlay = openclawConfigOverlay(this.options.mcpServers, {
      mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: randomBytes(24).toString('hex') },
    })!
    this.cleanups.push(overlay.cleanup)
    const state = mkdtempSync(join(tmpdir(), 'cli-bridge-openclaw-state-'))
    this.cleanups.push(() => { try { rmSync(state, { recursive: true, force: true }) } catch { /* best effort */ } })
    this.env = { ...process.env, OPENCLAW_NONINTERACTIVE: '1', OPENCLAW_WORKSPACE_DIR: this.options.cwd,
      OPENCLAW_CONFIG_PATH: overlay.path, OPENCLAW_STATE_DIR: state }
    const ready = new Promise<void>((resolve, reject) => { this.readyWaiter = { resolve, reject } })
    ready.catch(() => {})
    const spawned = await this.spawn(['gateway', 'run'], signal)
    let seen = ''
    const watch = (chunk: string): void => {
      if (!this.readyWaiter) return
      seen = (seen + chunk).slice(-4_096)
      if (seen.includes(GATEWAY_READY)) { this.readyWaiter.resolve(); this.readyWaiter = null }
    }
    spawned.child.stderr?.on('data', (chunk: Buffer) => watch(chunk.toString()))
    this.life = new NativeChild(spawned, {
      names: { process: 'openclaw gateway', session: 'openclaw native session' },
      onStdout: watch,
      onEnd: (error) => {
        this.readyWaiter?.reject(error)
        this.readyWaiter = null
        for (const reader of this.readers.splice(0)) reader.reject(error)
      },
      cleanup: () => { for (const cleanup of this.cleanups.splice(0)) cleanup() },
    })
    await bounded(ready, `the openclaw Gateway did not report ready within ${this.options.requestTimeoutMs}ms`,
      this.options.requestTimeoutMs, signal)
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.isClosed()) throw new BackendError('openclaw native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('openclaw native session already has an active turn', 'upstream')
    const state: TurnState = { calls: new Set(), failure: null, settled: false }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.call(state, prompt)
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === OPENCLAW_TURN_SETTLED) return
      }
    } catch (error) {
      if (signal.aborted) await this.abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.turnState === state) this.turnState = null
      this.queue.length = 0
    }
  }

  /**
   * Sends `/steer <text>` on the session once the turn's call is running. Its answer joins the
   * turn, which settles after it; the turn carries `{ type: 'steer', operationId, state: 'applied' }`
   * when it arrives.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    if (this.isClosed() || !state || state.settled) throw new BackendError('openclaw native session has no running turn to steer', 'upstream')
    await this.call(state, `/steer ${prompt}`, operationId ?? '')
  }

  /** `/stop` aborts the session's run on the Gateway; then the Gateway and every call stop. */
  async abort(): Promise<void> {
    const state = this.turnState
    if (state && !this.isClosed()) {
      const stop = await this.spawn(['agent', '--json', '--session-id', this.options.sessionKey, '--message', '/stop']).catch(() => null)
      if (stop) await Promise.race([waitForHarnessExit(stop), delay(STOP_GRACE_MS)]).finally(() => terminateSpawned(stop).finally(() => stop.release()))
    }
    for (const call of state?.calls ?? []) await terminateSpawned(call)
    await this.close()
  }

  async respondToNativeInteraction(): Promise<void> {
    throw new BackendError('openclaw native sessions publish no interactions', 'capability_denied')
  }

  /** The OpenClaw session and the turns this Gateway has completed in it, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.isClosed() || this.turnState || this.completedTurns === 0) return null
    const revision = `openclaw:${this.options.sessionKey}:${this.completedTurns}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    const life = this.life
    if (!life) { for (const cleanup of this.cleanups.splice(0)) cleanup(); return }
    life.end(new Error('openclaw native session closed'))
    await life.closing
  }

  /** One `openclaw agent --json` call on the session; its answer is queued into the turn. */
  private async call(state: TurnState, message: string, steerOperation?: string): Promise<void> {
    const spawned = await this.spawn(['agent', '--json', '--session-id', this.options.sessionKey, '--message-file', '-'])
    state.calls.add(spawned)
    const stderr = new BoundedDiagnosticBuffer()
    spawned.child.stderr?.on('data', (chunk) => { stderr.append(chunk) })
    spawned.child.stdin?.end(message)
    void (async () => {
      const lines: string[] = []
      try {
        if (!spawned.child.stdout) throw new Error('openclaw agent has no stdout')
        for await (const next of readProcessLines({ child: spawned.child, stdout: spawned.child.stdout })) if (next.kind === 'line') lines.push(next.line)
        const exit = await waitForHarnessExit(spawned)
        // Through a Gateway the document wraps the embedded one: `{ runId, status, summary, result }`.
        const document = parseOpenclawResult(lines.join('\n'))
        const result = record(document?.result) ?? document
        const error = record(document?.error) ?? record(result?.error)
          ?? (typeof document?.status === 'string' && document.status !== 'ok' ? { message: String(document.summary ?? document.status) } : undefined)
        if (error || exit.code !== 0 || !result) {
          state.failure ??= typeof error?.message === 'string' ? error.message : stderr.render(600) || `openclaw agent exit ${exit.code ?? exit.signal}`
        } else {
          const text = (Array.isArray(result.payloads) ? result.payloads : [])
            .map((payload) => record(payload)?.text).filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n\n')
          if (!state.settled) {
            if (steerOperation !== undefined) this.enqueue({ type: 'steer', ...(steerOperation ? { operationId: steerOperation } : {}), state: 'applied' })
            this.enqueue({ type: OPENCLAW_REPLY, text, usage: openclawTurnUsage(record(record(record(result.meta)?.agentMeta)?.usage)) ?? null })
          }
        }
      } catch (error) {
        state.failure ??= error instanceof Error ? error.message : String(error)
      } finally {
        state.calls.delete(spawned)
        await terminateSpawned(spawned)
        spawned.release()
        if (state.calls.size === 0 && !state.settled && this.turnState === state) {
          state.settled = true
          if (!state.failure) this.completedTurns += 1
          this.enqueue({ type: OPENCLAW_TURN_SETTLED, ...(state.failure ? { error: state.failure } : {}) })
        }
      }
    })()
  }

  private async spawn(args: string[], signal?: AbortSignal): Promise<Awaited<ReturnType<Spawner>>> {
    const spawned = await this.options.spawner(this.options.bin, args, {
      ...(signal ? { signal } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: this.env,
      envPassthroughKeys: Object.keys(this.env).filter((key) => key.startsWith('OPENCLAW_')),
      ...this.options.spawn,
    })
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdout) {
      await terminateSpawned(spawned).finally(() => spawned.release())
      throw new BackendError(`openclaw ${args[0]} failed to start: ${spawnError?.message ?? 'no stdout'}`, 'upstream', spawnError)
    }
    return spawned
  }

  private gateway(): NativeChild {
    if (!this.life) throw new BackendError('openclaw native session has not started', 'upstream')
    return this.life
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.isClosed()) return Promise.reject(this.life?.error ?? new Error('openclaw gateway closed'))
    if (signal.aborted) return Promise.reject(new Error('openclaw native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('openclaw native turn aborted'))
      }
      const reader: Waiter<Record<string, unknown>> = {
        resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
      }
      this.readers.push(reader)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free loopback port'))))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

async function bounded<T>(promise: Promise<T>, failure: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BackendError(failure, 'timeout')), timeoutMs)
        timer.unref?.()
        onAbort = () => reject(new BackendError('openclaw native session start was cancelled', 'aborted'))
        if (signal?.aborted) onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
