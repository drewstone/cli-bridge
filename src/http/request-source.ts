import type { IncomingMessage } from 'node:http'

/**
 * The Node adapter gives its fetch callback the native request separately.
 * Keep that fact out of the public HTTP body and headers while allowing routes
 * to enforce policies that are valid only for a local socket.
 */
const incomingByRequest = new WeakMap<Request, IncomingMessage>()

export function bindIncomingRequest(request: Request, incoming: IncomingMessage): void {
  incomingByRequest.set(request, incoming)
}

export function isLoopbackRequest(request: Request): boolean {
  const address = incomingByRequest.get(request)?.socket.remoteAddress
  if (!address) return false
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const octets = ipv4.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/u.test(part))) return false
  const first = Number(octets[0])
  return first === 127 && octets.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255)
}
