/**
 * net-jail egress relay — the process that turns an isolated Docker network
 * into a deny-by-default allowlist.
 *
 * It runs INSIDE a container that is attached to two networks: the worker's
 * `--internal` network (no gateway, no external DNS, no route off it) and a
 * normal bridge network that does reach the internet. Worker containers join
 * only the internal network, so nothing they emit can leave it except through
 * this process.
 *
 * Two independent mechanisms, both required:
 *
 *   1. Reachability. The relay is registered on the internal network under a
 *      network-scoped Docker alias for every allowlisted hostname, so those
 *      names — and only those names — resolve inside the worker, to this
 *      process. Every other name is NXDOMAIN and every IP is unroutable.
 *      This is what an agent cannot undo: there is no proxy variable to unset,
 *      because the worker's clients are talking to what they believe is the
 *      origin.
 *
 *   2. Authorization. DNS aliasing alone is not a control — a worker can pin a
 *      name to this address itself (`curl --resolve`, a Host header, a raw
 *      socket). So every accepted connection must NAME its target in-band and
 *      that name is checked against the allowlist before a single byte is
 *      forwarded: TLS SNI for TLS, the Host header for cleartext HTTP. A
 *      connection that names nothing is refused.
 *
 * TLS is never terminated. The relay reads the ClientHello to learn the SNI and
 * then splices raw bytes, so certificate validation still happens end-to-end
 * against the real origin and the relay holds no key material.
 *
 * Plain Node with no dependencies, and .mjs rather than .ts, because it is
 * executed by `node` inside the worker runtime image — the bridge's TypeScript
 * is never built or installed there.
 */

import { createServer, connect, isIP } from 'node:net'
import { Resolver } from 'node:dns/promises'

/** Bytes of client head buffered while waiting to learn the target name. */
const MAX_HEAD_BYTES = 16_384
/** Deadline for a client to name its target before the connection is dropped. */
const NAME_DEADLINE_MS = 10_000

/**
 * Public resolvers, used INSTEAD of /etc/resolv.conf.
 *
 * The relay is itself attached to the internal network, so Docker's embedded
 * resolver answers every allowlisted hostname with the relay's own alias
 * address. Resolving through the container's configured nameserver would
 * therefore make the relay dial itself. Explicit external servers are the only
 * resolution path that returns the true origin address.
 */
const UPSTREAM_DNS = (process.env.NET_JAIL_DNS || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Address ranges the relay refuses to dial even when an allowlisted hostname
 * resolves to them. The relay sits on a network with a route to the Docker
 * host and its other bridges; without this, a hostile or hijacked DNS answer
 * for an allowlisted name turns the relay into a path to the operator's LAN,
 * the Docker gateway, or a cloud metadata endpoint. A literal address in the
 * allowlist is exempt, because that is an operator naming the target directly.
 */
function isBlockedAddress(ip) {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    return v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')
  }
  const [a, b] = ip.split('.').map(Number)
  if (a === undefined || b === undefined) return true
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Parse `host:port,host:port` into a port → Set(host) map.
 *
 * Ports are explicit by construction: the bridge resolves every allowlist entry
 * to `host:port` before it reaches the relay, so a defaulting rule here cannot
 * disagree with the ports the relay was told to listen on.
 */
export function parseAllowlist(raw) {
  const byPort = new Map()
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.lastIndexOf(':')
    if (idx <= 0) throw new Error(`net-jail allowlist entry must be host:port, got '${entry}'`)
    const host = entry.slice(0, idx).toLowerCase()
    const port = Number(entry.slice(idx + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`net-jail allowlist entry has an invalid port: '${entry}'`)
    }
    if (!byPort.has(port)) byPort.set(port, new Set())
    byPort.get(port).add(host)
  }
  if (byPort.size === 0) throw new Error('net-jail allowlist is empty — the relay would deny every connection')
  return byPort
}

/**
 * Extract the SNI hostname from a buffered TLS ClientHello.
 *
 * Returns `null` when the bytes are not a complete ClientHello yet (caller
 * buffers more) and `undefined` when the record is complete but carries no
 * server_name extension — an unnamed target, which is refused rather than
 * guessed.
 */
export function readSni(buf) {
  if (buf.length < 5) return null
  if (buf[0] !== 0x16) return undefined
  const recordEnd = 5 + buf.readUInt16BE(3)
  if (buf.length < recordEnd) return null
  let p = 5
  if (buf[p] !== 0x01) return undefined
  p += 4 // handshake type + 3-byte length
  p += 2 + 32 // client_version + random
  if (p >= recordEnd) return undefined
  p += 1 + buf[p] // session_id
  if (p + 2 > recordEnd) return undefined
  p += 2 + buf.readUInt16BE(p) // cipher_suites
  if (p + 1 > recordEnd) return undefined
  p += 1 + buf[p] // compression_methods
  if (p + 2 > recordEnd) return undefined
  const extensionsEnd = Math.min(p + 2 + buf.readUInt16BE(p), recordEnd)
  p += 2
  while (p + 4 <= extensionsEnd) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    const body = p + 4
    if (body + len > extensionsEnd) return undefined
    if (type === 0x0000) {
      let q = body + 2 // server_name_list length
      while (q + 3 <= body + len) {
        const nameType = buf[q]
        const nameLen = buf.readUInt16BE(q + 1)
        if (nameType === 0 && q + 3 + nameLen <= body + len) {
          return buf.toString('utf8', q + 3, q + 3 + nameLen).toLowerCase()
        }
        q += 3 + nameLen
      }
      return undefined
    }
    p = body + len
  }
  return undefined
}

/**
 * Extract the Host header from a buffered cleartext HTTP request head.
 *
 * Same three-state contract as {@link readSni}: `null` while the head is
 * incomplete, `undefined` when the head is complete and names no host.
 */
export function readHttpHost(buf) {
  const end = buf.indexOf('\r\n\r\n')
  if (end === -1) return buf.length >= MAX_HEAD_BYTES ? undefined : null
  const head = buf.toString('latin1', 0, end)
  const match = /^host:[ \t]*([^\r\n]+)/im.exec(head)
  if (!match) return undefined
  // A Host header may carry a port; the port is already fixed by which
  // listener accepted the connection, so only the name is authoritative here.
  return match[1].trim().replace(/:\d+$/u, '').toLowerCase()
}

function log(decision, detail) {
  process.stderr.write(`[net-jail-relay] ${decision} ${detail}\n`)
}

/**
 * Bind one listener per allowlisted port. Each listener enforces the allowlist
 * for ITS port, so `host:443` never implies `host:22`.
 */
export function startRelay({ allowlist, listenHost = '0.0.0.0', resolver }) {
  const dns = resolver ?? new Resolver()
  if (!resolver) dns.setServers(UPSTREAM_DNS)
  const servers = []

  for (const [port, allowedHosts] of allowlist) {
    const server = createServer((client) => {
      client.setNoDelay(true)
      let head = Buffer.alloc(0)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        log('deny', `port=${port} reason=no-target-named-within-${NAME_DEADLINE_MS}ms`)
        client.destroy()
      }, NAME_DEADLINE_MS)
      timer.unref()

      const refuse = (name, reason) => {
        settled = true
        clearTimeout(timer)
        log('deny', `host=${name ?? '<unnamed>'} port=${port} reason=${reason}`)
        // Cleartext clients get a status line so the failure reads as a policy
        // decision in the agent's own output rather than a bare reset.
        if (head.length > 0 && head[0] !== 0x16) {
          client.end(
            'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' +
            `net-jail: egress to ${name ?? 'an unnamed host'}:${port} is not on the allowlist\n`,
          )
          return
        }
        client.destroy()
      }

      client.on('error', () => { settled = true; clearTimeout(timer) })
      client.on('data', function onData(chunk) {
        if (settled) return
        head = Buffer.concat([head, chunk])
        const target = head[0] === 0x16 ? readSni(head) : readHttpHost(head)
        if (target === null) {
          if (head.length > MAX_HEAD_BYTES) refuse(null, 'head-too-large')
          return
        }
        if (target === undefined) return refuse(null, 'no-sni-or-host-header')
        if (!allowedHosts.has(target)) return refuse(target, 'not-on-allowlist')

        settled = true
        clearTimeout(timer)
        client.pause()
        client.removeListener('data', onData)
        void dial(target, port, allowedHosts).then(
          (upstream) => {
            log('allow', `host=${target} port=${port} -> ${upstream.remoteAddress}`)
            upstream.write(head)
            client.pipe(upstream)
            upstream.pipe(client)
            const drop = () => { upstream.destroy(); client.destroy() }
            upstream.on('error', drop)
            client.on('error', drop)
            client.resume()
          },
          (error) => {
            log('deny', `host=${target} port=${port} reason=upstream-${error.message}`)
            client.destroy()
          },
        )
      })
    })
    server.listen(port, listenHost)
    servers.push(server)
  }

  async function dial(host, port, allowedHosts) {
    // A literal address on the allowlist was named by an operator; a resolved
    // one is only as trustworthy as the answer, hence the range check.
    const addresses = isIP(host) ? [host] : await dns.resolve4(host)
    const usable = addresses.filter((ip) => (isIP(host) && allowedHosts.has(host)) || !isBlockedAddress(ip))
    const address = usable[0]
    if (!address) throw new Error(`resolves-only-to-blocked-addresses(${addresses.join(',')})`)
    return await new Promise((resolvePromise, rejectPromise) => {
      const socket = connect({ host: address, port }, () => resolvePromise(socket))
      socket.setNoDelay(true)
      socket.once('error', (error) => rejectPromise(error))
    })
  }

  return {
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
    ports: [...allowlist.keys()],
    // Exposed so a test can bind on port 0 and learn where it landed; nothing
    // in the running relay reads it.
    servers,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowlist = parseAllowlist(process.env.NET_JAIL_ALLOW)
  const relay = startRelay({ allowlist })
  log('ready', `ports=${relay.ports.join(',')} allow=${process.env.NET_JAIL_ALLOW}`)
}
