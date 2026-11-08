/**
 * Host egress relay for a `router` or `relay` jail.
 *
 * The jailed process has no network of its own (see egress-shim.mjs); every
 * connection it makes arrives here as an HTTP CONNECT over a per-spawn unix
 * socket. The relay authorizes the CONNECT target, then requires the TLS
 * ClientHello's SNI to name the same host before a byte leaves the machine, so
 * a client cannot tunnel to an allowed address while naming another origin.
 *
 *   - Allowed, not intercepted: TLS is never terminated. The relay splices raw
 *     bytes, so the certificate is still checked end to end and the relay holds
 *     no key material.
 *   - Intercepted (a profile `proxySecrets` host): the tunnel is handed to the
 *     per-spawn iron-proxy, which terminates TLS with its own CA and swaps the
 *     placeholder credential for the real one.
 *
 * Only port 443 is reachable unless an allow entry names `host:port`. Resolved
 * addresses in private, loopback, link-local and metadata ranges are refused;
 * an allow entry that is itself a literal address is an operator naming the
 * target directly and is exempt.
 */

import { lookup } from 'node:dns/promises'
import { connect, createServer, isIP, type Server, type Socket } from 'node:net'

/** Bytes buffered while waiting for the CONNECT head or the ClientHello. */
const MAX_HEAD_BYTES = 16_384
/** Deadline for a client to name its target before the connection is dropped. */
const NAME_DEADLINE_MS = 10_000
const HTTPS_PORT = 443

export interface EgressRelayOptions {
  socketPath: string
  /** Reachable targets as `host` (port 443) or `host:port`. */
  allow: readonly string[]
  /** Hosts whose tunnels go to iron-proxy's CONNECT listener instead of the origin. */
  intercept?: { hosts: readonly string[]; tunnel: { host: string; port: number } }
  log?: (line: string) => void
}

export interface EgressRelay {
  close(): Promise<void>
}

export async function startEgressRelay(options: EgressRelayOptions): Promise<EgressRelay> {
  const allow = new Set(options.allow.map(normalizeTarget))
  const intercepted = new Set((options.intercept?.hosts ?? []).map((host) => host.toLowerCase()))
  const log = options.log ?? ((line: string) => process.stderr.write(`[jail-egress] ${line}\n`))

  const permitted = (host: string, port: number): boolean => {
    if (intercepted.has(host)) return port === HTTPS_PORT
    return allow.has(port === HTTPS_PORT ? host : `${host}:${port}`)
  }

  const server = createServer((client) => {
    client.setNoDelay(true)
    const timer = setTimeout(() => client.destroy(), NAME_DEADLINE_MS)
    timer.unref()
    client.on('error', () => clearTimeout(timer))
    void readUntil(client, (buf) => buf.indexOf('\r\n\r\n') >= 0 ? buf.indexOf('\r\n\r\n') + 4 : null)
      .then(async ({ head, rest }) => {
        const target = parseConnect(head)
        if (!target) return deny(client, 405, 'only HTTPS CONNECT is relayed', log, '<not-connect>')
        const { host, port } = target
        if (!permitted(host, port)) return deny(client, 403, `egress to ${host}:${port} is not allowed`, log, `${host}:${port}`)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const hello = await readUntil(client, (buf) => clientHelloEnd(buf), rest)
        const sni = readSni(hello.head)
        if (sni !== host) {
          log(`deny host=${host}:${port} reason=sni-mismatch sni=${sni ?? '<none>'}`)
          return void client.destroy()
        }
        clearTimeout(timer)
        const upstream = intercepted.has(host)
          ? await openTunnel(options.intercept!.tunnel, host, port)
          : await dial(host, port, allow)
        log(`allow host=${host}:${port}${intercepted.has(host) ? ' via=iron-proxy' : ''}`)
        upstream.write(Buffer.concat([hello.head, hello.rest]))
        const drop = () => { upstream.destroy(); client.destroy() }
        upstream.on('error', drop)
        client.on('error', drop)
        client.pipe(upstream).pipe(client)
      })
      .catch((error: Error) => {
        clearTimeout(timer)
        log(`deny reason=${error.message}`)
        client.destroy()
      })
  })
  await listen(server, options.socketPath)
  return { close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function normalizeTarget(entry: string): string {
  const value = entry.trim().toLowerCase()
  return value.endsWith(`:${HTTPS_PORT}`) ? value.slice(0, -`:${HTTPS_PORT}`.length) : value
}

function deny(client: Socket, status: 403 | 405, message: string, log: (line: string) => void, target: string): void {
  log(`deny host=${target} status=${status}`)
  const reason = status === 403 ? 'Forbidden' : 'Method Not Allowed'
  client.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\njail egress: ${message}\n`)
}

/** `CONNECT host:port HTTP/1.x` → lower-cased host and port, else null. */
function parseConnect(head: Buffer): { host: string; port: number } | null {
  const line = head.toString('latin1', 0, head.indexOf('\r\n'))
  const match = /^CONNECT (\[[0-9a-f:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/iu.exec(line)
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: match[1]!.replace(/^\[|\]$/gu, '').toLowerCase(), port }
}

/** Reads from `socket` until `complete` returns the head length; the remainder is returned too. */
function readUntil(
  socket: Socket,
  complete: (buf: Buffer) => number | null,
  initial: Buffer = Buffer.alloc(0),
): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = initial
    const check = (): boolean => {
      let end: number | null
      try { end = complete(buf) } catch (error) {
        socket.off('data', onData)
        reject(error as Error)
        return true
      }
      if (end !== null) {
        socket.pause()
        socket.off('data', onData)
        socket.off('end', onEnd)
        resolve({ head: buf.subarray(0, end), rest: buf.subarray(end) })
        return true
      }
      if (buf.length > MAX_HEAD_BYTES) {
        socket.off('data', onData)
        reject(new Error('head-too-large'))
        return true
      }
      return false
    }
    const onData = (chunk: Buffer) => { buf = Buffer.concat([buf, chunk]); check() }
    const onEnd = () => reject(new Error('client-closed'))
    if (check()) return
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.resume()
  })
}

/** Length of a complete TLS handshake record, or null while incomplete. Non-TLS is refused. */
function clientHelloEnd(buf: Buffer): number | null {
  if (buf.length < 5) return null
  if (buf[0] !== 0x16) throw new Error('not-tls')
  const end = 5 + buf.readUInt16BE(3)
  return buf.length >= end ? end : null
}

/** SNI host name from one complete ClientHello record, or undefined when it names none. */
function readSni(buf: Buffer): string | undefined {
  const recordEnd = 5 + buf.readUInt16BE(3)
  let p = 5
  if (buf[p] !== 0x01) return undefined
  p += 4 + 2 + 32 // handshake header, client_version, random
  if (p >= recordEnd) return undefined
  p += 1 + buf[p]! // session_id
  if (p + 2 > recordEnd) return undefined
  p += 2 + buf.readUInt16BE(p) // cipher_suites
  if (p + 1 > recordEnd) return undefined
  p += 1 + buf[p]! // compression_methods
  if (p + 2 > recordEnd) return undefined
  const extensionsEnd = Math.min(p + 2 + buf.readUInt16BE(p), recordEnd)
  p += 2
  while (p + 4 <= extensionsEnd) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    const body = p + 4
    if (body + len > extensionsEnd) return undefined
    if (type === 0x0000) {
      const nameType = buf[body + 2]
      const nameLen = buf.readUInt16BE(body + 3)
      if (nameType !== 0 || body + 5 + nameLen > body + len) return undefined
      return buf.toString('latin1', body + 5, body + 5 + nameLen).toLowerCase()
    }
    p = body + len
  }
  return undefined
}

async function dial(host: string, port: number, allow: ReadonlySet<string>): Promise<Socket> {
  const literal = isIP(host) !== 0
  const addresses = literal ? [host] : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
  const operatorNamed = literal && (allow.has(host) || allow.has(`${host}:${port}`))
  const address = addresses.find((ip) => operatorNamed || !isBlockedAddress(ip))
  if (!address) throw new Error(`blocked-address host=${host}`)
  return await connectTo(address, port)
}

/** CONNECT through iron-proxy's tunnel listener; resolves once it answers 200. */
async function openTunnel(tunnel: { host: string; port: number }, host: string, port: number): Promise<Socket> {
  const socket = await connectTo(tunnel.host, tunnel.port)
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
  const { head, rest } = await readUntil(socket, (buf) => buf.indexOf('\r\n\r\n') >= 0 ? buf.indexOf('\r\n\r\n') + 4 : null)
  if (!/^HTTP\/1\.[01] 200 /u.test(head.toString('latin1'))) {
    socket.destroy()
    throw new Error(`iron-proxy-refused host=${host}`)
  }
  if (rest.length) socket.unshift(rest)
  socket.resume()
  return socket
}

function connectTo(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => { socket.off('error', reject); resolve(socket) })
    socket.setNoDelay(true)
    socket.once('error', reject)
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
}

/** Private, loopback, link-local, CGNAT and metadata ranges a resolved name must not reach. */
function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6.startsWith('::ffff:')) return isBlockedAddress(v6.slice(7))
    return v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')
  }
  const [a, b] = ip.split('.').map(Number)
  if (a === undefined || b === undefined) return true
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
}
