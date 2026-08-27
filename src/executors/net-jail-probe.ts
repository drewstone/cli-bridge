import {
  applyNetJailEgressFilter,
  containerAddressOn,
  type ContainerNetworkAddress,
  withJailedContainer,
} from './net-jail-egress.js'
import type { DockerCli } from './docker-cli.js'
import { dockerOwnerLabels, removeOwnedDockerResource } from './docker-resource-owner.js'
import { NetJailProvisionError } from './net-jail-errors.js'

const CANARY_HOSTS = ['github.com', 'example.com', 'www.iana.org']

export async function verifyNetJail(opts: {
  backend: string
  network: string
  image: string
  allow: string[]
  cli: DockerCli
  relayAddress: ContainerNetworkAddress
  gateway: string
  probeName: string
  peerName: string
  resourceOwner: string
  skipEgressFilter: boolean
  skipRestartRearm: boolean
  onProgress: (message: string) => void
}): Promise<void> {
  const first = opts.allow[0]!
  const [allowHost, allowPortText] = splitHostPort(first)
  const canary = CANARY_HOSTS.find(host => !opts.allow.some(entry => splitHostPort(entry)[0] === host))
  await removeOwnedDockerResource(opts.cli, 'container', opts.peerName, opts.resourceOwner)
  const peerStarted = await opts.cli([
    'run', '-d', '--name', opts.peerName, ...dockerOwnerLabels(opts.resourceOwner, 'net-jail-verification-peer'),
    '--network', opts.network, '--entrypoint', 'node', opts.image,
    '-e', `require('node:net').createServer((s) => s.end('peer\\n')).listen(${PEER_PORT})`,
  ], { timeoutMs: 60_000 })
  if (peerStarted.code !== 0) throw new NetJailProvisionError(`backend ${opts.backend}: could not start the net-jail verification peer — ${firstLine(peerStarted)}`)
  try {
    const peer = await containerAddressOn(opts.cli, opts.network, opts.peerName)
    const spec = {
      gateway: opts.gateway,
      peer: `${peer.ip}:${PEER_PORT}`,
      relay: `${opts.relayAddress.ip}:${allowPortText}`,
      linkLocal: LINK_LOCAL_TARGETS,
      allowHost,
      allowPort: Number(allowPortText),
      canary: canary ?? null,
    }
    const probeOnce = async (containerId: string, phase: string): Promise<void> => {
      const probe = await opts.cli(['exec', '-e', `NETJAIL_PROBE=${JSON.stringify(spec)}`, containerId, 'node', '-e', PROBE_PROGRAM], { timeoutMs: 120_000 })
      const observed = Object.fromEntries(probe.stdout.split('\n').map(line => line.trim()).filter(Boolean).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      const fail = (detail: string): never => { throw new NetJailProvisionError(`backend ${opts.backend}: net-jail on ${opts.network} did not verify ${phase} — ${detail}. Probe output: ${probe.stdout.trim().replace(/\n/gu, '; ') || firstLine(probe)}`) }
      if (observed['relay-reachable'] !== 'yes') fail(`the probe could not reach the relay at ${spec.relay} (${observed['relay-reachable'] ?? 'no result'}), so the jail denies its own model endpoint`)
      if (observed['default-routes'] !== '0') fail(`a jailed container still has ${observed['default-routes'] ?? 'an unknown number of'} default route(s)`)
      if (observed['gateway-reachable'] !== 'no') fail(`the Docker host is reachable from inside the jail at ${opts.gateway} (${observed['gateway-detail'] ?? 'unknown'})`)
      if (observed['peer-reachable'] !== 'no') fail(`another container on ${opts.network} is reachable from inside the jail at ${spec.peer} (${observed['peer-detail'] ?? 'unknown'})`)
      if (observed['linklocal-reachable'] !== 'no') fail(`link-local is reachable from inside the jail (${observed['linklocal-detail'] ?? 'unknown'})`)
      if (observed['net-admin'] !== 'denied') fail(`a jailed container can run iptables itself (${observed['net-admin'] ?? 'unknown'})`)
      if (observed['canary-resolves'] === 'yes') fail(`${canary} still resolves inside the jail`)
      if (observed['allow-resolves'] !== 'yes') fail(`the allowlisted host ${allowHost} does not resolve inside the jail`)
      if (observed['allow-tls'] !== undefined && !['yes', 'skipped-non-443'].includes(observed['allow-tls'])) fail(`the allowlisted endpoint ${first} did not complete a TLS handshake through the relay (${observed['allow-tls']})`)
    }
    await withJailedContainer({
      network: opts.network, image: opts.image, relayIp: opts.relayAddress.ip,
      ...(opts.relayAddress.ip6 ? { relayIp6: opts.relayAddress.ip6 } : {}),
      cli: opts.cli, label: 'verification probe', name: opts.probeName, resourceOwner: opts.resourceOwner, skipFilter: opts.skipEgressFilter,
    }, async containerId => {
      await probeOnce(containerId, 'as provisioned')
      await restartAndRearm(containerId, opts)
      await probeOnce(containerId, 'after the container restarted')
      opts.onProgress(`net-jail ${opts.network} verified twice — once as provisioned and once after a \`docker restart\``)
    })
  } finally {
    await removeOwnedDockerResource(opts.cli, 'container', opts.peerName, opts.resourceOwner)
  }
}

export async function restartAndRearm(containerId: string, opts: {
  backend: string
  image: string
  cli: DockerCli
  relayAddress: ContainerNetworkAddress
  skipRestartRearm: boolean
}): Promise<void> {
  const startedAt = async (): Promise<string> => {
    const result = await opts.cli(['inspect', '-f', '{{.State.StartedAt}}', containerId], { timeoutMs: 30_000 })
    return result.stdout.trim()
  }
  const before = await startedAt()
  const restarted = await opts.cli(['restart', '--time', '0', containerId], { timeoutMs: 60_000 })
  if (restarted.code !== 0) throw new NetJailProvisionError(`backend ${opts.backend}: could not restart the verification probe, so the jail's survival of a container restart is untested — ${firstLine(restarted)}`)
  const after = await startedAt()
  if (!after || after === before) throw new NetJailProvisionError(`backend ${opts.backend}: the verification probe reported the same start time (${before || 'unknown'}) after \`docker restart\`, so no restart was actually observed and the jail's survival of one cannot be claimed`)
  if (opts.skipRestartRearm) return
  await applyNetJailEgressFilter({
    containerId,
    relayIp: opts.relayAddress.ip,
    ...(opts.relayAddress.ip6 ? { relayIp6: opts.relayAddress.ip6 } : {}),
    image: opts.image,
    cli: opts.cli,
    label: 'verification probe after restart',
  })
}

export const PEER_PORT = 9
export const LINK_LOCAL_TARGETS = ['169.254.169.254:80', '169.254.170.2:80']

export const PROBE_PROGRAM = `
const net = require('node:net')
const tls = require('node:tls')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const dns = require('node:dns').promises
const spec = JSON.parse(process.env.NETJAIL_PROBE)
const say = (k, v) => process.stdout.write(k + '=' + v + '\\n')
const DENIED = ['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM', 'ETIMEDOUT', 'timeout']
function dial(target, timeoutMs) {
  const idx = target.lastIndexOf(':')
  const host = target.slice(0, idx)
  const port = Number(target.slice(idx + 1))
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result) => { socket.destroy(); resolve(target + ' ' + result) }
    socket.setTimeout(timeoutMs, () => done('timeout'))
    socket.on('connect', () => done('open'))
    socket.on('error', (error) => done(error.code || 'error'))
  })
}
const verdict = (results) => results.some((r) => !DENIED.includes(r.split(' ')[1])) ? 'yes' : 'no'
async function main() {
  const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\\n').filter((line) => /^[^\\s]+\\s+00000000\\s/.test(line)).length
  say('default-routes', routes)
  const gateway = []
  for (const port of [22, 80, 443, 2375, 2376, 8080]) gateway.push(await dial(spec.gateway + ':' + port, 4000))
  say('gateway-reachable', verdict(gateway)); say('gateway-detail', gateway.join(' | '))
  const peer = [await dial(spec.peer, 4000)]
  say('peer-reachable', verdict(peer)); say('peer-detail', peer.join(' | '))
  const linkLocal = []
  for (const target of spec.linkLocal) linkLocal.push(await dial(target, 3000))
  say('linklocal-reachable', verdict(linkLocal)); say('linklocal-detail', linkLocal.join(' | '))
  const relay = await dial(spec.relay, 10000)
  say('relay-reachable', relay.split(' ')[1] === 'open' ? 'yes' : relay)
  const ipt = spawnSync('iptables', ['-w', '2', '-S'], { encoding: 'utf8' })
  say('net-admin', ipt.error ? 'absent:' + ipt.error.code : ipt.status === 0 ? 'granted' : 'denied')
  if (spec.canary) say('canary-resolves', await dns.lookup(spec.canary).then(() => 'yes', () => 'no'))
  else say('canary-resolves', 'skipped')
  say('allow-resolves', await dns.lookup(spec.allowHost).then(() => 'yes', () => 'no'))
  if (spec.allowPort !== 443) { say('allow-tls', 'skipped-non-443'); return }
  await new Promise((resolve) => {
    const socket = tls.connect({ host: spec.allowHost, port: 443, servername: spec.allowHost }, () => { say('allow-tls', socket.authorized ? 'yes' : 'unauthorized'); socket.destroy(); resolve() })
    socket.setTimeout(20000, () => { say('allow-tls', 'timeout'); socket.destroy(); resolve() })
    socket.on('error', (error) => { say('allow-tls', 'error:' + error.message); socket.destroy(); resolve() })
  })
}
main().catch((error) => { say('probe-error', error && error.message); process.exitCode = 1 })
`

export function splitHostPort(entry: string): [string, string] {
  const index = entry.lastIndexOf(':')
  return [entry.slice(0, index), entry.slice(index + 1)]
}

export function firstLine(result: { stderr: string; spawnError?: string; code: number }): string {
  const text = result.stderr.trim() || result.spawnError || `docker exited ${result.code}`
  return text.split('\n')[0] ?? text
}
