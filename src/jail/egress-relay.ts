/**
 * Host egress relay for a network policy and explicitly admitted host services.
 *
 * The jailed process has no network of its own (see egress-shim.mjs); every
 * connection arrives over a per-spawn UNIX socket. Parsed capability HTTP
 * requests reach only host-registered endpoints. HTTPS CONNECT authorizes its
 * target and requires the TLS
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

import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
  createServer,
  request,
  validateHeaderName,
  validateHeaderValue,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect, isIP, type Server, type Socket } from 'node:net'

/** Bytes buffered while waiting for the CONNECT head or the ClientHello. */
const MAX_HEAD_BYTES = 16_384
/** Deadline for a client to name its target before the connection is dropped. */
const NAME_DEADLINE_MS = 10_000
const HTTPS_PORT = 443
const MAX_SERVICE_BODY_BYTES = 1024 * 1024
const SERVICE_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'] as const
const RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
  'cache-control',
  'retry-after',
] as const
declare const trustedHostService: unique symbol
declare const trustedHostServiceOwner: unique symbol
/** Host-only authority. JSON and object copies cannot manufacture a registration. */
export interface TrustedHostServiceRegistration {
  readonly [trustedHostService]: true
}
export interface TrustedHostServiceOwner {
  readonly [trustedHostServiceOwner]: true
}
interface HostServiceOwner {
  target: URL
  paths: ReadonlyMap<string, ReadonlySet<string>>
  headers: Readonly<Record<string, string>>
  revoked: boolean
  claims: Set<HostService>
}
interface HostService {
  owner: HostServiceOwner
  cap: string
  claimed: boolean
  revoked: boolean
  active: Set<() => void>
}
const services = new WeakMap<TrustedHostServiceRegistration, HostService>()
const owners = new WeakMap<TrustedHostServiceOwner, HostServiceOwner>()
type ServiceMethod = 'GET' | 'POST' | 'DELETE'
type ServiceRoute = {
  service: HostService
  target: URL
  methods: ReadonlySet<string>
}

/** Register only an actual host-owned scope/listener. Never derive this authority from wire input. */
export function registerTrustedHostService(input: {
  url: string
  paths: Readonly<Record<string, readonly ServiceMethod[]>>
  headers?: Readonly<Record<string, string>>
}): { owner: TrustedHostServiceOwner; revoke(): void } {
  const target = new URL(input.url)
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error('trusted host service requires an exact HTTP loopback endpoint with a port')
  const paths = new Map<string, ReadonlySet<string>>()
  for (const [suffix, methods] of Object.entries(input.paths)) {
    if (
      !/^(?:\/[a-z0-9_-]+)*$/iu.test(suffix) ||
      !methods.length ||
      methods.some((method) => !['GET', 'POST', 'DELETE'].includes(method))
    )
      throw new Error('trusted host service requires exact suffixes and MCP methods')
    if (target.search && suffix) throw new Error('trusted host service cannot append a suffix to a query endpoint')
    paths.set(suffix, new Set(methods))
  }
  if (!paths.size) throw new Error('trusted host service has no admitted paths')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    validateHeaderName(name)
    validateHeaderValue(name, value)
    if (
      /^(host|connection|upgrade|content-length|transfer-encoding|expect|trailer|proxy-.*)$/iu.test(name) ||
      value.length > MAX_HEAD_BYTES
    )
      throw new Error('trusted host service header is not an endpoint credential or protocol header')
    if (headers[name.toLowerCase()] !== undefined) throw new Error('duplicate trusted host service header')
    headers[name.toLowerCase()] = value
  }
  const value: HostServiceOwner = {
    target,
    paths,
    headers,
    revoked: false,
    claims: new Set(),
  }
  const owner = Object.freeze({}) as TrustedHostServiceOwner
  owners.set(owner, value)
  return {
    owner,
    revoke() {
      value.revoked = true
      for (const claim of value.claims) revokeService(claim)
    },
  }
}

/** Fresh private routing capability per turn, before native parsing, copying, or output redaction. */
export function claimTrustedHostService(owner: TrustedHostServiceOwner): {
  registration: TrustedHostServiceRegistration
  nativeUrl: string
  protectedValues: readonly string[]
  revoke(): void
} {
  const value = owners.get(owner)
  if (!value || value.revoked) throw new Error('unavailable trusted host service owner')
  const cap = randomBytes(32).toString('base64url')
  const service: HostService = {
    owner: value,
    cap,
    claimed: false,
    revoked: false,
    active: new Set(),
  }
  value.claims.add(service)
  const registration = Object.freeze({}) as TrustedHostServiceRegistration
  services.set(registration, service)
  return {
    registration,
    nativeUrl: `http://127.0.0.1:3128/${cap}`,
    protectedValues: Object.freeze([cap, ...Object.values(value.headers)]),
    revoke: () => revokeService(service),
  }
}

function revokeService(service: HostService): void {
  service.revoked = true
  service.owner.claims.delete(service)
  for (const drop of service.active) drop()
  service.active.clear()
}

export interface EgressRelayOptions {
  socketPath: string
  /** Reachable targets as `host` (port 443) or `host:port`. */
  allow: readonly string[]
  /** Hosts whose tunnels go to iron-proxy's CONNECT listener instead of the origin. */
  intercept?: {
    hosts: readonly string[]
    tunnel: { host: string; port: number }
  }
  trustedHostServices?: readonly TrustedHostServiceRegistration[]
  log?: (line: string) => void
}

export interface EgressRelay {
  close(): Promise<void>
}

export async function startEgressRelay(options: EgressRelayOptions): Promise<EgressRelay> {
  const admitted = (options.trustedHostServices ?? []).map((registration) => {
    const service = services.get(registration)
    if (!service || service.revoked || service.claimed) throw new Error('unavailable trusted host service registration')
    return service
  })
  if (new Set(admitted).size !== admitted.length) throw new Error('duplicate trusted host service registration')
  for (const service of admitted) service.claimed = true
  const routes = new Map<string, ServiceRoute>()
  for (const service of admitted) {
    for (const [suffix, methods] of service.owner.paths) {
      const target = new URL(service.owner.target)
      target.pathname += suffix
      routes.set(`/${service.cap}${suffix}`, { service, target, methods })
    }
  }
  const allow = new Set(options.allow.map(normalizeTarget))
  const intercepted = new Set((options.intercept?.hosts ?? []).map((host) => host.toLowerCase()))
  const sink = options.log ?? ((line: string) => process.stderr.write(`[jail-egress] ${line}\n`))
  const protectedValues = admitted.flatMap((service) => [service.cap, ...Object.values(service.owner.headers)]).filter(Boolean)
  const log = (line: string) => sink(protectedValues.reduce((value, secret) => value.split(secret).join('[redacted]'), line))

  const permitted = (host: string, port: number): boolean => {
    if (intercepted.has(host)) return port === HTTPS_PORT
    return allow.has(port === HTTPS_PORT ? host : `${host}:${port}`)
  }

  const open = new Set<Socket>()
  const used = new WeakSet<Socket>()
  const server = createServer(
    {
      maxHeaderSize: MAX_HEAD_BYTES,
      requestTimeout: NAME_DEADLINE_MS,
      headersTimeout: NAME_DEADLINE_MS,
    },
    (req, res) => {
      // A connection authorizes one parsed request, never a raw HTTP tunnel.
      res.setHeader('connection', 'close')
      if (used.has(req.socket)) return void req.socket.destroy()
      used.add(req.socket)
      void serveHostService(req, res, routes).catch(() => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
    },
  )
  server.maxRequestsPerSocket = 1
  server.on('dropRequest', (_req, socket) => socket.destroy())
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('checkContinue', (_req, res) => {
    res.writeHead(417, { connection: 'close' })
    res.end()
  })
  server.on('checkExpectation', (_req, res) => {
    res.writeHead(417, { connection: 'close' })
    res.end()
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connection', (client) => {
    open.add(client)
    client.once('close', () => open.delete(client))
    client.setNoDelay(true)
  })
  server.on('connect', (req, socket, rest) => {
    const client = socket as Socket
    if (used.has(client)) return void client.destroy()
    used.add(client)
    client.pause()
    const timer = setTimeout(() => client.destroy(), NAME_DEADLINE_MS)
    timer.unref()
    client.on('error', () => clearTimeout(timer))
    void Promise.resolve()
      .then(async () => {
        const target = parseConnect(req.url ?? '')
        if (!target) return deny(client, 405, 'only HTTPS CONNECT is relayed', log, '<not-connect>')
        const { host, port } = target
        if (!permitted(host, port))
          return deny(client, 403, `egress to ${host}:${port} is not allowed`, log, `${host}:${port}`)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const hello = await readUntil(client, (buf) => clientHelloEnd(buf), rest)
        const sni = readSni(hello.head)
        if (sni !== host) {
          log(`deny host=${host}:${port} reason=sni-mismatch sni=${sni ?? '<none>'}`)
          return void client.destroy()
        }
        const upstream = intercepted.has(host)
          ? await openTunnel(options.intercept!.tunnel, host, port)
          : await dial(host, port, allow)
        clearTimeout(timer)
        if (client.destroyed) return void upstream.destroy()
        log(`allow host=${host}:${port}${intercepted.has(host) ? ' via=iron-proxy' : ''}`)
        upstream.write(Buffer.concat([hello.head, hello.rest]))
        const drop = () => {
          upstream.destroy()
          client.destroy()
        }
        client.once('close', () => upstream.destroy())
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
  try {
    await listen(server, options.socketPath)
  } catch (error) {
    for (const service of admitted) revokeService(service)
    throw error
  }
  // Close ends live tunnels too, so a held connection cannot delay the proxy kill and revoke.
  return {
    close: () =>
      new Promise((resolve) => {
        for (const service of admitted) revokeService(service)
        server.close(() => resolve())
        for (const socket of open) socket.destroy()
      }),
  }
}

async function serveHostService(
  req: IncomingMessage,
  res: ServerResponse,
  routes: ReadonlyMap<string, ServiceRoute>,
): Promise<void> {
  const route = routes.get(req.url ?? '')
  if (!route || req.headers.host !== '127.0.0.1:3128' || route.service.revoked || route.service.owner.revoked) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!route.methods.has(req.method ?? '')) {
    res.writeHead(405)
    res.end()
    return
  }
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_SERVICE_BODY_BYTES) {
    res.writeHead(413)
    res.end()
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_SERVICE_BODY_BYTES) {
      res.writeHead(413)
      res.end()
      return
    }
    chunks.push(chunk)
  }
  if (route.service.revoked || route.service.owner.revoked || req.aborted || res.destroyed) return void res.destroy()
  const headers: Record<string, string> = {}
  for (const name of SERVICE_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  Object.assign(headers, route.service.owner.headers)
  headers['content-length'] = String(size)
  headers.connection = 'close'
  await new Promise<void>((resolve) => {
    const upstream = request(route.target, {
      method: req.method,
      headers,
      // Host proxy settings cannot redirect a scoped loopback credential.
      createConnection: () => connect(Number(route.target.port), '127.0.0.1'),
    })
    const drop = () => {
      upstream.destroy()
      res.destroy()
      done()
    }
    route.service.active.add(drop)
    const done = () => {
      route.service.active.delete(drop)
      res.off('close', drop)
      resolve()
    }
    res.once('close', drop)
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
      done()
    })
    upstream.once('response', (response) => {
      const retained: Record<string, string | string[]> = {}
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers[name]
        if (value !== undefined) retained[name] = value
      }
      res.writeHead(response.statusCode ?? 502, retained)
      response.on('error', drop)
      res.once('finish', done)
      response.pipe(res)
    })
    upstream.end(Buffer.concat(chunks, size))
  })
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
function parseConnect(target: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-f:.]+\]|[^\s:]+):(\d{1,5})$/iu.exec(target)
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
    const onEnd = () => reject(new Error('peer-closed'))
    if (check()) return
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onEnd)
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

/**
 * SNI host name from one complete ClientHello record, or undefined when it
 * names none. A hello carrying ECH or ESNI is refused: its outer name is not
 * the origin the encrypted inner hello selects.
 */
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
  let name: string | undefined
  while (p + 4 <= extensionsEnd) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    const body = p + 4
    if (body + len > extensionsEnd || type === 0xfe0d || type === 0xffce) return undefined
    if (type === 0x0000) {
      if (name !== undefined) return undefined
      const nameType = buf[body + 2]
      const nameLen = buf.readUInt16BE(body + 3)
      if (nameType !== 0 || body + 5 + nameLen > body + len) return undefined
      name = buf.toString('latin1', body + 5, body + 5 + nameLen).toLowerCase()
    }
    p = body + len
  }
  return name
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
  socket.on('error', () => socket.destroy())
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
    const socket = connect({ host, port, timeout: NAME_DEADLINE_MS }, () => { socket.off('error', reject); socket.setTimeout(0); resolve(socket) })
    socket.setNoDelay(true)
    socket.once('error', reject)
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`connect-timeout ${host}:${port}`)) })
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
}

/** Private, loopback, link-local, CGNAT, benchmark, multicast, reserved, NAT64/6to4 and metadata ranges. */
function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6.startsWith('::ffff:')) return isBlockedAddress(v6.slice(7))
    return v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')
      || v6.startsWith('64:ff9b:') || v6.startsWith('2002:') || v6.startsWith('ff')
  }
  const [a, b] = ip.split('.').map(Number)
  if (a === undefined || b === undefined) return true
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}
