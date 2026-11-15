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
 * A host loopback service the jail must reach at its own address (Pi's scoped
 * inference proxy) gets a pair of its own: the shim listens on that port and
 * forwards to the service's per-spawn socket.
 *
 * argv: <socket> <loopback port> [<socket> <loopback port>]... -- <bin> [...args]
 */

import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const pairs = argv.slice(0, Math.max(split, 0))
const [bin, ...args] = argv.slice(split + 1)
if (split < 2 || pairs.length % 2 || !bin) {
  process.stderr.write('egress-shim: usage: <socket> <loopback port> [...] -- <bin> [...args]\n')
  process.exit(2)
}

const listening = []
const servers = []
for (let i = 0; i < pairs.length; i += 2) {
  const socketPath = pairs[i]
  // Half-open: a client that ends its request side still receives the relay reply.
  const server = createServer({ allowHalfOpen: true }, (client) => {
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
  servers.push(server)
  listening.push(new Promise((resolve) => server.listen(Number(pairs[i + 1]), '127.0.0.1', resolve)))
}

void Promise.all(listening).then(() => {
  const child = spawn(bin, args, { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('error', (error) => {
    process.stderr.write(`egress-shim: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    for (const server of servers) server.close()
    // Re-raise the child's signal; the forwarding handlers would swallow it.
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
    else process.exit(code ?? 1)
  })
})
