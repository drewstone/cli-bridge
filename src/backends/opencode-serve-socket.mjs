/**
 * Runs `opencode serve` and offers its HTTP API on a unix socket the Bridge can reach.
 *
 * A jailed process runs in its own network namespace (`bwrap --unshare-net`), so the loopback port
 * `opencode serve` listens on is unreachable from the Bridge. A unix socket ignores network
 * namespaces: this shim, inside the jail, listens on a socket in a directory bound into the jail
 * and forwards each connection to the server's loopback port. Unjailed, it keeps the server off
 * a host port other local users could reach without its password.
 *
 * Plain Node with no dependencies, and .mjs, because the jail runs it with the Bridge's own `node`
 * before opencode starts, without the Bridge's TypeScript loader (as `jail/egress-shim.mjs`).
 *
 * argv: <socket> -- <opencode> serve [...args]
 * stdout: opencode's own lines, then one `{"type":"cli-bridge.opencode-serve","state":"ready"}`
 * line once the socket accepts connections.
 */

import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const socketPath = argv[0]
const [bin, ...args] = argv.slice(split + 1)
if (split !== 1 || !socketPath || !bin) {
  process.stderr.write('opencode-serve-socket: usage: <socket> -- <opencode> serve [...args]\n')
  process.exit(2)
}

const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] })
let server = null
let buffered = ''
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  if (server) return
  buffered += chunk.toString('utf8')
  const listening = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(buffered)
  if (!listening) {
    buffered = buffered.slice(-4096)
    return
  }
  const port = Number(listening[1])
  // Half-open: a client that ends its request side still receives the reply.
  server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect(port, '127.0.0.1')
    const close = () => { client.destroy(); upstream.destroy() }
    client.on('error', close)
    upstream.on('error', close)
    client.pipe(upstream).pipe(client)
  })
  server.on('error', (error) => {
    process.stderr.write(`opencode-serve-socket: ${error.message}\n`)
    child.kill('SIGTERM')
    process.exitCode = 1
  })
  server.listen(socketPath, () => {
    process.stdout.write(`${JSON.stringify({ type: 'cli-bridge.opencode-serve', state: 'ready' })}\n`)
  })
})

child.on('error', (error) => {
  process.stderr.write(`opencode-serve-socket: ${error.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  server?.close()
  // Re-raise the child's signal; the forwarding handlers would swallow it.
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
  else process.exit(code ?? 1)
})
