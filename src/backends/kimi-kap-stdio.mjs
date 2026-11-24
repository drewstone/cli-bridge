/**
 * Runs Kimi Code's local server (`kimi web`) and carries its API over stdio.
 *
 * A jailed process runs in its own network namespace (`bwrap --unshare-net`), so the loopback port the
 * server listens on is unreachable from the Bridge. This shim runs inside the jail beside the server:
 * it holds the server's bearer token, makes each HTTP call the Bridge asks for, and relays the
 * server's WebSocket frames. Nothing but JSON lines crosses the jail boundary.
 *
 * Plain Node with no dependencies, and .mjs, because the jail runs it with the Bridge's own `node`
 * before Kimi starts, without the Bridge's TypeScript loader (as `jail/egress-shim.mjs`).
 *
 * argv:   <kimi> web [...args]. Kimi Code 2.7 announces the server as one JSON line under `--json`, with an
 *         ephemeral token; 2.6 has no `--json` and prints a banner whose Local URL carries its token as `#token=`.
 *         The CLI's own `web --help` says which it speaks, and the shim adds `--json` or `--no-open` to match.
 * stdin:  one request per line: `{"id":n,"method":"POST","path":"sessions","body":{...}}` for HTTP under
 *         `/api/v1/`, or `{"id":n,"send":{...}}` for a frame to send on the WebSocket.
 * stdout: `{"type":"ready","protocol":"<KAP version>"}` once the server and its WebSocket are open, then
 *         `{"id":n,"status":<http status>,"body":<json>}` per request and `{"frame":<json>}` per server frame.
 * End of stdin stops the server with SIGTERM, so it saves its own state, and the shim exits with it.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const [bin, ...args] = process.argv.slice(2)
if (!bin) {
  process.stderr.write('kimi-kap-stdio: usage: <kimi> web [...args]\n')
  process.exit(2)
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const help = spawnSync(bin, [args[0] ?? 'web', '--help'], { encoding: 'utf8', timeout: 30_000 })
const json = /^\s+--json\b/mu.test(help.stdout ?? '')
const child = spawn(bin, [...args, json ? '--json' : '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('error', (error) => {
  process.stderr.write(`kimi-kap-stdio: ${error.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  // Re-raise the server's signal; the forwarding handlers would swallow it.
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
  else process.exit(code ?? 1)
})

/** 2.6's banner line `Local:    http://127.0.0.1:<port>/#token=<token>`, possibly coloured. */
function bannerReady(line) {
  const local = /\bLocal:\s+(http:\/\/[^\s/#]+)\/?#token=([A-Za-z0-9_-]+)/u.exec(line.replace(/\x1b\[[0-9;]*m/gu, ''))
  return local ? { origin: local[1], token: local[2] } : undefined
}

/** The ready line names the server's private loopback origin, WebSocket and token: JSON under `--json`, else the banner. */
async function serverReady() {
  for await (const line of createInterface({ input: child.stdout })) {
    const ready = json ? (line.startsWith('{') ? JSON.parse(line) : undefined) : bannerReady(line)
    if (!ready) continue
    const origin = new URL(ready.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || typeof ready.token !== 'string' || !ready.token)
      throw new Error('the local server did not confirm a private loopback endpoint')
    const socket = new URL(typeof ready.ws_url === 'string' ? ready.ws_url : `ws://${origin.host}/api/v1/ws`)
    if (socket.protocol !== 'ws:' || socket.host !== origin.host) throw new Error('the local server named another WebSocket host')
    return { origin: origin.origin, socket: socket.href, token: ready.token, protocol: String(ready.kimi_agent_protocol_version ?? '') }
  }
  throw new Error('the local server exited before it was ready')
}

try {
  const server = await serverReady()
  child.stdout.resume()
  const headers = { authorization: `Bearer ${server.token}` }
  const socket = new WebSocket(server.socket, { headers })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('the local server refused its WebSocket')), { once: true })
  })
  socket.addEventListener('message', (message) => {
    let frame
    try { frame = JSON.parse(String(message.data)) } catch { return }
    // A server ping is answered here; the Bridge has nothing to add to it.
    if (frame?.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return }
    write({ frame })
  })
  socket.addEventListener('close', () => child.kill('SIGTERM'))
  write({ type: 'ready', protocol: server.protocol })

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let request
    try { request = JSON.parse(line) } catch { return }
    if (!Number.isSafeInteger(request?.id)) return
    if (request.send !== undefined) {
      socket.send(JSON.stringify(request.send))
      write({ id: request.id, status: 0, body: null })
      return
    }
    const path = String(request.path ?? '')
    // Only the server's own API, by a relative path: never another origin or a path outside `/api/v1/`.
    if (!/^[A-Za-z0-9_:.\-/?=&%]+$/u.test(path) || path.startsWith('/') || path.includes('..')) {
      write({ id: request.id, status: 400, body: { code: -1, msg: 'path refused by the stdio bridge' } })
      return
    }
    void fetch(`${server.origin}/api/v1/${path}`, {
      method: request.method === 'GET' ? 'GET' : 'POST', redirect: 'error',
      headers: { ...headers, 'content-type': 'application/json' },
      ...(request.method === 'GET' ? {} : { body: JSON.stringify(request.body ?? {}) }),
    }).then(async (response) => {
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { code: -1, msg: text.slice(0, 500) } }
      write({ id: request.id, status: response.status, body })
    }, (error) => write({ id: request.id, status: 502, body: { code: -1, msg: error instanceof Error ? error.message : String(error) } }))
  })
  lines.on('close', () => {
    socket.close()
    child.kill('SIGTERM')
  })
} catch (error) {
  process.stderr.write(`kimi-kap-stdio: ${error instanceof Error ? error.message : String(error)}\n`)
  child.kill('SIGTERM')
  process.exitCode = 1
}
