/**
 * Serves a turn's stdio MCP servers by URL, for an agent that takes MCP servers only by URL (Exo). The
 * relay starts each server as its own child for the turn and answers MCP Streamable HTTP at
 * `http://127.0.0.1:<port>/<token>/<name>` with `application/json`, one JSON-RPC response per request.
 * One listener serves every turn of this process, and a Bridge session's token is derived from its key,
 * so its servers keep their URLs across its turns: Exo refuses to resume a thread whose MCP destinations
 * changed. The unguessable token is the credential. A request the server sends to its client is refused,
 * and its notifications are dropped: the relay carries the client's requests and their answers only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline'
import type { McpServerSpec } from './types.js'
import { BackendError } from './types.js'

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** One stdio server: the requests sent to it, by the relay's own id, waiting for their answers. */
class Relayed {
  private readonly waiting = new Map<number, { id: string | number; answer: (message: Message) => void }>()
  private next = 1
  private exited: string | null = null

  constructor(readonly name: string, private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => this.fromServer(line))
    child.on('exit', (code, signal) => {
      this.exited = `MCP server ${JSON.stringify(name)} exited (${signal ?? code})`
      for (const { id, answer } of this.waiting.values()) answer({ jsonrpc: '2.0', id, error: { code: -32603, message: this.exited } })
      this.waiting.clear()
    })
    child.on('error', () => undefined)
  }

  /** Sends one message from the client; a request resolves with its answer, anything else with null. */
  send(message: Message): Promise<Message | null> {
    if (this.exited) {
      return Promise.resolve(message.method && message.id !== undefined && message.id !== null
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: this.exited } } : null)
    }
    if (!message.method || message.id === undefined || message.id === null) {
      // A notification, or the client's answer to a request the relay already refused.
      if (message.method) this.write(message)
      return Promise.resolve(null)
    }
    const own = this.next++
    const id = message.id
    return new Promise((resolve) => {
      this.waiting.set(own, { id, answer: resolve })
      this.write({ ...message, id: own })
    })
  }

  private fromServer(line: string): void {
    let message: Message
    try { message = JSON.parse(line) as Message } catch { return }
    if (message.method) {
      if (message.id !== undefined && message.id !== null) {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'the client takes no requests from this server' } })
      }
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = this.waiting.get(message.id)
    if (!waiter) return
    this.waiting.delete(message.id)
    waiter.answer({ ...message, id: waiter.id })
  }

  private write(message: Message): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  stop(): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 2_000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
      this.child.stdin?.end()
      this.child.kill('SIGTERM')
    })
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** One listener for the process, started on first use; it holds no turn's servers between turns. */
export class McpUrlRelay {
  private server: Server | null = null
  private port = 0
  private readonly secret = randomBytes(32)
  private readonly turns = new Map<string, Map<string, Relayed>>()

  private async listen(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((request, response) => { void this.answer(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    server.unref()
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
    return this.port
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const [, token, name] = (request.url ?? '').split('/')
      const target = token && name ? this.turns.get(token)?.get(decodeURIComponent(name)) : undefined
      if (!target) { response.writeHead(404).end(); return }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return }
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return }
      let parsed: unknown
      try { parsed = await body(request) } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
        return
      }
      const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
      const answers = (await Promise.all(messages.map((message) => target.send(message as Message))))
        .filter((answer): answer is Message => answer !== null)
      if (answers.length === 0) { response.writeHead(202).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
    } catch {
      if (!response.headersSent) response.writeHead(500).end()
    }
  }

  /**
   * Starts the stdio servers in `servers` and serves them by URL until `close`. A server already given by
   * URL keeps its URL. Each child gets PATH, HOME and the locale from the Bridge, and its own `env`,
   * nothing else.
   */
  async serve(servers: Record<string, McpServerSpec>, cwd: string, sessionKey: string | null): Promise<{ urls: Record<string, string>; close(): Promise<void> }> {
    const urls: Record<string, string> = {}
    const stdio: Array<[string, McpServerSpec & { command: string }]> = []
    // Every entry is checked before any server starts, so a refusal leaves nothing running.
    for (const [name, spec] of Object.entries(servers)) {
      if (spec.type === 'http' || spec.type === 'sse' || spec.url) {
        if (!spec.url) throw new BackendError(`MCP server ${JSON.stringify(name)} names no URL`, 'parse_error')
        if (spec.headers && Object.keys(spec.headers).length > 0) {
          throw new BackendError(`MCP server ${JSON.stringify(name)}: this agent takes a URL server without headers`, 'capability_denied')
        }
        urls[name] = spec.url
      } else if (spec.command) {
        stdio.push([name, { ...spec, command: spec.command }])
      } else {
        throw new BackendError(`MCP server ${JSON.stringify(name)} names no command`, 'parse_error')
      }
    }
    if (stdio.length === 0) return { urls, close: async () => undefined }
    const port = await this.listen()
    const token = sessionKey === null ? randomBytes(24).toString('hex')
      : createHmac('sha256', this.secret).update(sessionKey).digest('hex').slice(0, 48)
    // A Bridge session runs one turn at a time, so servers still held under its token are its previous
    // turn's, which ended or is being torn down: they stop, and this turn takes the URLs.
    const previous = this.turns.get(token)
    if (previous) await Promise.all([...previous.values()].map((entry) => entry.stop()))
    const relayed = new Map<string, Relayed>()
    this.turns.set(token, relayed)
    const inherited = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap((key) => {
      const value = process.env[key]
      return value ? [[key, value] as const] : []
    })
    for (const [name, spec] of stdio) {
      const child = spawn(spec.command, spec.args ?? [], { cwd, env: { ...Object.fromEntries(inherited), ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'] })
      relayed.set(name, new Relayed(name, child))
      urls[name] = `http://127.0.0.1:${port}/${token}/${encodeURIComponent(name)}`
    }
    return {
      urls,
      close: async () => {
        if (this.turns.get(token) === relayed) this.turns.delete(token)
        await Promise.all([...relayed.values()].map((entry) => entry.stop()))
      },
    }
  }
}
