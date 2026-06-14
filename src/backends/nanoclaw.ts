/**
 * NanoClaw backend — a Unix-socket CLIENT to a running NanoClaw daemon.
 *
 * NanoClaw is not a one-shot CLI like the others: it's a long-lived multi-channel
 * agent daemon (Claude Code under the @onecli-sh Chat SDK). It exposes a CLI channel
 * over a Unix socket (`<nanoclaw>/data/cli.sock`). The protocol (mirrors NanoClaw's own
 * `scripts/chat.ts`):
 *
 *   connect(socket) → write `{"text": "<prompt>"}\n`
 *   ← stream `{"text": "<reply>"}\n` lines  → ChatDelta.content
 *   completion is SILENCE-based — NanoClaw sends no explicit done event, so the turn
 *   ends after `silenceMs` of quiet following the first reply (or socket close / hard cap).
 *
 * Because the daemon owns its own workspace, NanoClaw does NOT honor a per-request cwd —
 * profile/skill materialization into the request cwd does not reach it (documented
 * limitation; configure skills on the NanoClaw side). Set NANOCLAW_SOCKET to the
 * daemon's `data/cli.sock`; health reports `unavailable` when the daemon isn't running.
 */

import net from 'node:net'

import type { Backend, BackendHealth, ChatDelta, ChatMessage, ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { contentToText } from './content.js'
import { resolvePromptMessages } from './profile-support.js'

export interface NanoclawBackendOptions {
  name?: string
  /** Unix socket path of the running daemon's CLI channel (NanoClaw `data/cli.sock`). */
  socketPath: string
  /** Hard per-request cap (ms). */
  timeoutMs: number
  /** Quiet period after the first reply that ends the turn (NanoClaw has no done event;
   *  see scripts/chat.ts, default 2s there). Default 3000ms. */
  silenceMs?: number
}

function renderPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
  return messages
    .map((m) => (m.role === 'user' ? contentToText(m.content) : `[${m.role}] ${contentToText(m.content)}`))
    .join('\n\n')
}

export class NanoclawBackend implements Backend {
  readonly name: string
  private readonly socketPath: string
  private readonly timeoutMs: number
  private readonly silenceMs: number

  constructor(opts: NanoclawBackendOptions) {
    this.name = opts.name ?? 'nanoclaw'
    this.socketPath = opts.socketPath
    this.timeoutMs = opts.timeoutMs
    this.silenceMs = opts.silenceMs ?? 3000
  }

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    if (!this.socketPath) return { name: this.name, state: 'unavailable', detail: 'NANOCLAW_SOCKET not set' }
    return new Promise<BackendHealth>((resolve) => {
      const s = net.connect(this.socketPath)
      const done = (h: BackendHealth): void => { try { s.destroy() } catch { /* ignore */ } resolve(h) }
      const t = setTimeout(() => done({ name: this.name, state: 'error', detail: 'connect timed out' }), 3000)
      s.on('connect', () => { clearTimeout(t); done({ name: this.name, state: 'ready', version: `nanoclaw @ ${this.socketPath}` }) })
      s.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(t)
        const offline = e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        done({ name: this.name, state: 'unavailable', detail: offline ? 'nanoclaw daemon not running' : e.message })
      })
    })
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.socketPath) throw new BackendError('nanoclaw: NANOCLAW_SOCKET not configured', 'upstream')
    const prompt = renderPrompt(resolvePromptMessages(req, session))
    const socket = net.connect(this.socketPath)

    const queue: ChatDelta[] = []
    let wake: (() => void) | null = null
    let finished = false
    let pendingError: Error | null = null
    let sawReply = false
    let silenceTimer: NodeJS.Timeout | null = null

    const push = (d: ChatDelta): void => { queue.push(d); wake?.() }
    const finish = (reason: ChatDelta['finish_reason'] = 'stop'): void => {
      if (finished) return
      finished = true
      push({ finish_reason: reason })
    }
    const scheduleSilence = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => finish('stop'), this.silenceMs)
    }

    const hardTimer = setTimeout(() => finish('timeout'), this.timeoutMs)
    const onAbort = (): void => { pendingError = new BackendError('nanoclaw request aborted', 'upstream'); try { socket.destroy() } catch { /* ignore */ } wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })

    let buf = ''
    socket.on('connect', () => { socket.write(JSON.stringify({ text: prompt }) + '\n') })
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line) as { text?: unknown }
          if (typeof m.text === 'string' && m.text.length > 0) { sawReply = true; push({ content: m.text }) }
        } catch { /* ignore non-JSON */ }
      }
      if (sawReply) scheduleSilence()
    })
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const offline = e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
      pendingError = new BackendError(`nanoclaw socket: ${offline ? 'daemon not running' : e.message}`, 'upstream')
      wake?.()
    })
    socket.on('close', () => finish('stop'))
    socket.on('end', () => finish('stop'))

    try {
      while (true) {
        while (queue.length) {
          const d = queue.shift()!
          yield d
          if (d.finish_reason) return
        }
        if (pendingError) throw pendingError
        await new Promise<void>((resolve) => { wake = () => { wake = null; resolve() } })
      }
    } finally {
      clearTimeout(hardTimer)
      if (silenceTimer) clearTimeout(silenceTimer)
      signal.removeEventListener('abort', onAbort)
      try { socket.destroy() } catch { /* ignore */ }
    }
  }
}
