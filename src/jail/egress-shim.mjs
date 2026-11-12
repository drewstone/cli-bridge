/**
 * In-jail egress shim: the only path off a `router` or `relay` jail's network.
 *
 * The jail runs in a fresh network namespace (`bwrap --unshare-net`) that holds
 * nothing but loopback, so a jailed process has no route anywhere. This shim
 * runs first inside that namespace, listens on loopback, and forwards every
 * connection to the host egress relay's unix socket, which the jail binds in.
 * The jail points HTTPS_PROXY at the listener. Trusted host services also use
 * private capability URLs at this listener; only the host relay interprets them.
 * A client that ignores the proxy
 * still has no route, so the relay's allowlist is the enforcement point, not
 * the client's cooperation.
 *
 * Plain Node with no dependencies, and .mjs rather than .ts, because the jail
 * runs it with the bridge's own `node` binary before the CLI starts, without
 * the bridge's TypeScript loader.
 *
 * argv: <relay socket> <loopback port> <bin> [...args]
 */

import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'

const [socketPath, port, bin, ...args] = process.argv.slice(2)
if (!socketPath || !port || !bin) {
  process.stderr.write('egress-shim: usage: <relay socket> <loopback port> <bin> [...args]\n')
  process.exit(2)
}

const server = createServer((client) => {
  const upstream = connect(socketPath)
  const close = () => { client.destroy(); upstream.destroy() }
  client.on('error', close)
  upstream.on('error', close)
  client.pipe(upstream).pipe(client)
})

server.on('error', (error) => {
  process.stderr.write(`egress-shim: ${error.message}\n`)
  process.exit(1)
})

server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(bin, args, { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('error', (error) => {
    process.stderr.write(`egress-shim: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    server.close()
    // Re-raise the child's signal; the forwarding handlers would swallow it.
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
    else process.exit(code ?? 1)
  })
})
