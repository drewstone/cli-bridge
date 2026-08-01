/**
 * net-jail provisioning — build the network topology that makes deny-by-default
 * egress a property of the kernel rather than a request to the agent.
 *
 * Three Docker objects per jailed backend:
 *
 *   <prefix>-netjail          an `--internal` network. Docker gives it no
 *                             gateway, so a container on it has no default
 *                             route off the bridge.
 *   <prefix>-netjail-egress   an ordinary bridge network, reachable only by the
 *                             relay.
 *   <prefix>-netjail-relay    a container on BOTH, running `net-relay.mjs`,
 *                             pinned to a fixed address on the internal
 *                             network. It is registered there under a
 *                             network-scoped alias for every allowlisted
 *                             hostname, and it verifies the name each
 *                             connection claims (TLS SNI / HTTP Host) before
 *                             forwarding. This is the allow.
 *
 * plus, in every jailed container's own network namespace, the deny: a packet
 * filter whose default policy is DROP and whose only exceptions are loopback
 * and the relay's pinned address (see `net-jail-egress.ts`). The network alone
 * is not the control — `--internal` leaves the Docker host's gateway address
 * and every peer container on-link, and a jailed worker used exactly that to
 * pull 339,594 bytes of github.com through a service on the host.
 *
 * Why this and not proxy environment variables: `HTTPS_PROXY` is a request the
 * worker can decline with `unset`. Here there is nothing to unset — the worker
 * never learns a proxy exists, its clients dial what they believe is the
 * origin, and removing every variable in its environment changes nothing about
 * what it can reach.
 *
 * The filter is state of a NETWORK NAMESPACE, and Docker gives a container a
 * brand-new, empty one every time it restarts. So the filter is scoped to a
 * container START, not to a container, and the pool treats it that way (see
 * `ContainerPoolOptions.afterCreate`): a jailed slot carries no Docker restart
 * policy, and every handout re-runs the install if the container's `StartedAt`
 * has moved. Both halves are needed — the policy covers revivals Docker performs
 * on its own, the handout gate covers the restart this bridge performs itself to
 * kill a worker's process tree when the worker's command exits non-cleanly,
 * which is a restart any worker can cause by exiting non-zero.
 *
 * Provisioning ends by PROVING the jail on a throwaway container drawn from the
 * same image, the same network and the same filter a worker gets: the host
 * gateway unreachable, a peer container unreachable, link-local unreachable,
 * the relay reachable, a name that must not resolve, a name that must, and a
 * real TLS handshake through the relay — and then all of it again after
 * restarting that container. A provisioner that returned success without taking
 * that path would be the control this feature exists to replace.
 */

import { fileURLToPath } from 'node:url'
import { dockerCli, type DockerCli } from './docker-cli.js'
import { assertDockerNetworkName } from './docker-network.js'
import {
  applyNetJailEgressFilter,
  containerAddressOn,
  relayAddressFor,
  withJailedContainer,
  type ContainerNetworkAddress,
} from './net-jail-egress.js'
import { canonicalAllowList, type NetJailAllowEntry } from '../jail/net-allowlist.js'

/** Host path of the relay program, bind-mounted read-only into the relay container. */
const RELAY_SOURCE_PATH = fileURLToPath(new URL('../jail/net-relay.mjs', import.meta.url))
const RELAY_CONTAINER_PATH = '/opt/cli-bridge-net-relay.mjs'

/**
 * Names probed to prove the jail denies. The first one NOT on the allowlist is
 * used; `github.com` leads because a worker cloning the public upstream of the
 * repository it is graded on is the concrete leak this feature closes.
 */
const CANARY_HOSTS = ['github.com', 'example.com', 'www.iana.org']

export class NetJailProvisionError extends Error {
  readonly code = 'net_jail_unenforceable' as const
  constructor(message: string) {
    super(message)
    this.name = 'NetJailProvisionError'
  }
}

export interface NetJailProvision {
  backend: string
  /** Internal network worker containers must join. Carries no route off itself. */
  network: string
  /** Pinned relay address — the ONLY destination a jailed container may send to. */
  relayIp: string
  /** Relay's IPv6 address on the jail network, when the network carries IPv6. */
  relayIp6?: string
  /** Canonical `host:port` list proven to be the enforced allowlist. */
  allow: string[]
  /** The same list with provenance, for the startup log and for refusals. */
  entries: NetJailAllowEntry[]
  /**
   * Install the egress filter into a container that has just joined
   * {@link NetJailProvision.network}. The pool calls this for every slot it
   * creates; it throws rather than returning a container without the filter.
   */
  applyFilter(containerId: string, label: string): Promise<void>
  destroy(): Promise<void>
}

export interface ProvisionNetJailOptions {
  backend: string
  /** Docker object name prefix, shared with the container pool so two bridges
   * with distinct pool prefixes do not fight over one network. */
  namePrefix: string
  /** Image used for the relay and the verification probe — the same runtime
   * image the workers run, so no additional image is a prerequisite. */
  image: string
  allow: NetJailAllowEntry[]
  cli?: DockerCli
  onProgress?: (message: string) => void
  /** Test seam: host path of the relay program. */
  relaySourcePath?: string
  /**
   * Calibration seam: provision the verification probe WITHOUT the egress
   * filter. The only supported use is proving that verification fails when the
   * filter is absent — a guard nobody has watched fail is a guard nobody knows
   * fires.
   */
  skipEgressFilterForVerification?: boolean
  /**
   * Calibration seam: restart the verification probe and DO NOT re-arm it, so
   * the second probe runs in exactly the namespace Docker hands back — which is
   * the configuration that leaked 339,598 bytes of github.com from a real pool
   * slot. Provisioning must fail; if it does not, the restart check is
   * decoration.
   */
  skipRestartRearmForVerification?: boolean
}

export async function provisionNetJail(opts: ProvisionNetJailOptions): Promise<NetJailProvision> {
  const cli = opts.cli ?? dockerCli
  const onProgress = opts.onProgress ?? (() => {})
  const network = assertDockerNetworkName(`${opts.namePrefix}-netjail`, 'net-jail network name')
  const egressNetwork = assertDockerNetworkName(`${opts.namePrefix}-netjail-egress`, 'net-jail egress network name')
  const relay = `${opts.namePrefix}-netjail-relay`
  const allow = canonicalAllowList(opts.allow)
  if (allow.length === 0) {
    throw new NetJailProvisionError(
      `backend ${opts.backend}: net-jail is enabled but no model endpoint could be derived and ` +
        'BRIDGE_NET_JAIL_ALLOW is empty — the worker would be unable to reach any model. Set a base URL ' +
        '(ANTHROPIC_BASE_URL / OPENAI_BASE_URL / TANGLE_ROUTER_URL) or name the endpoint in BRIDGE_NET_JAIL_ALLOW.',
    )
  }
  const hosts = [...new Set(opts.allow.map((e) => e.host))].sort()

  const probeName = `${opts.namePrefix}-netjail-probe`
  const peerName = `${opts.namePrefix}-netjail-peer`

  const destroy = async (): Promise<void> => {
    // The probe and peer are removed by their own `finally`; naming them here
    // too is what makes a hard-killed process's leftovers reclaimable.
    await cli(['rm', '-f', relay, probeName, peerName], { timeoutMs: 30_000 })
    await cli(['network', 'rm', network], { timeoutMs: 30_000 })
    await cli(['network', 'rm', egressNetwork], { timeoutMs: 30_000 })
  }

  // A previous process may have exited without running its shutdown hook. The
  // objects are bridge-owned and named after this pool, so reclaiming them is
  // safe and keeps a restart from failing on "already exists".
  await destroy()

  try {
    for (const [name, extraArgs] of [[network, ['--internal']], [egressNetwork, []]] as const) {
      const created = await cli(['network', 'create', ...extraArgs, name], { timeoutMs: 30_000 })
      if (created.code !== 0) {
        throw new NetJailProvisionError(
          `backend ${opts.backend}: could not create net-jail network ${name} — ${firstLine(created)}`,
        )
      }
    }

    const relaySource = opts.relaySourcePath ?? RELAY_SOURCE_PATH
    const started = await cli([
      'run', '-d',
      '--name', relay,
      '--network', egressNetwork,
      '--restart', 'on-failure:3',
      '--memory', '256m', '--memory-swap', '256m',
      // The relay reads bytes from an untrusted worker. It needs no filesystem
      // of its own beyond the read-only program, and no privileges at all.
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${relaySource}:${RELAY_CONTAINER_PATH}:ro`,
      '-e', `NET_JAIL_ALLOW=${allow.join(',')}`,
      '--entrypoint', 'node',
      opts.image,
      RELAY_CONTAINER_PATH,
    ], { timeoutMs: 60_000 })
    if (started.code !== 0) {
      throw new NetJailProvisionError(
        `backend ${opts.backend}: could not start the net-jail relay — ${firstLine(started)}`,
      )
    }

    // One alias per allowlisted hostname, scoped to the internal network: those
    // names resolve to the relay inside the jail and nowhere else. The address
    // is PINNED rather than assigned, because it is about to become a literal
    // rule in every worker's network namespace.
    const { subnet, gateway } = await readNetworkIpam(cli, network, opts.backend)
    const pinnedRelayIp = relayAddressFor(subnet, gateway)
    const aliasArgs = hosts.flatMap((host) => ['--alias', host])
    const connected = await cli(
      ['network', 'connect', '--ip', pinnedRelayIp, ...aliasArgs, network, relay],
      { timeoutMs: 30_000 },
    )
    if (connected.code !== 0) {
      throw new NetJailProvisionError(
        `backend ${opts.backend}: could not attach the net-jail relay to ${network} at ${pinnedRelayIp} — ` +
          firstLine(connected),
      )
    }
    const relayAddress = await containerAddressOn(cli, network, relay)
    if (relayAddress.ip !== pinnedRelayIp) {
      throw new NetJailProvisionError(
        `backend ${opts.backend}: the net-jail relay was pinned to ${pinnedRelayIp} but Docker reports ` +
          `${relayAddress.ip}; the address every worker is filtered towards must be the relay's.`,
      )
    }

    const applyFilter = (containerId: string, label: string): Promise<void> => applyNetJailEgressFilter({
      containerId,
      relayIp: relayAddress.ip,
      ...(relayAddress.ip6 ? { relayIp6: relayAddress.ip6 } : {}),
      image: opts.image,
      cli,
      label,
    })

    onProgress(`net-jail ${network} relay=${relay}@${relayAddress.ip} allow=${allow.join(',')}`)
    await verifyNetJail({
      backend: opts.backend,
      network,
      image: opts.image,
      allow,
      cli,
      relayAddress,
      gateway,
      probeName,
      peerName,
      skipEgressFilter: opts.skipEgressFilterForVerification === true,
      skipRestartRearm: opts.skipRestartRearmForVerification === true,
      onProgress,
    })
    return {
      backend: opts.backend,
      network,
      relayIp: relayAddress.ip,
      ...(relayAddress.ip6 ? { relayIp6: relayAddress.ip6 } : {}),
      allow,
      entries: opts.allow,
      applyFilter,
      destroy,
    }
  } catch (error) {
    await destroy()
    throw error
  }
}

/** The subnet and gateway Docker's IPAM chose for a network it just created. */
async function readNetworkIpam(
  cli: DockerCli,
  network: string,
  backend: string,
): Promise<{ subnet: string; gateway: string }> {
  const result = await cli(
    ['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}', network],
    { timeoutMs: 30_000 },
  )
  const [subnet = '', gateway = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || !subnet || !gateway) {
    throw new NetJailProvisionError(
      `backend ${backend}: could not read the IPAM configuration of ${network} — ${firstLine(result)}`,
    )
  }
  return { subnet, gateway }
}

/**
 * Prove the jail on the real path before any request can use it.
 *
 * The probe runs in a container drawn from the same image, the same network AND
 * the same egress filter a worker gets, with a peer container alongside it on
 * the bridge. Every fact below has to hold for the control to mean anything:
 *
 *   - no default route (the network denies routing off the bridge)
 *   - the Docker host's gateway address is unreachable
 *   - a peer container on the same bridge is unreachable, while it listens
 *   - link-local, where cloud metadata lives, is unreachable
 *   - the relay IS reachable — the control that makes the four denials evidence
 *     of a filter rather than of a container with no working network at all
 *   - the worker cannot install or flush filter rules itself
 *   - a host that is not allowlisted does not resolve
 *   - an allowlisted host resolves and completes a TLS handshake through the
 *     relay to the true origin
 *
 * AND THEN ALL OF IT AGAIN, ACROSS A RESTART. The filter is state of a network
 * namespace, and Docker destroys and recreates that namespace every time a
 * container restarts — so a jail that is airtight while it exists is not a jail
 * if a worker can get its container restarted, and it can: the executor restarts
 * a slot to kill the process tree whenever a worker's command exits non-cleanly.
 * So the probe is restarted with the same `docker restart --time 0` that path
 * uses, re-armed by the same `applyNetJailEgressFilter` the pool's `afterCreate`
 * calls, and every assertion above is re-run against the new incarnation.
 * Measured before that existed: 339,598 bytes of github.com pulled from a real
 * pool slot, through the Docker host, after the worker exited non-zero.
 *
 * Anything less is a configuration that reports a policy it has not
 * demonstrated. This function has now missed two escapes by checking the wrong
 * thing — first the route table alone, then the filter's presence at one instant
 * — so each round's fix is added as a DIRECT probe of the escape rather than of
 * something adjacent to it, and every one of them FAILS provisioning.
 */
async function verifyNetJail(opts: {
  backend: string
  network: string
  image: string
  allow: string[]
  cli: DockerCli
  relayAddress: ContainerNetworkAddress
  gateway: string
  probeName: string
  peerName: string
  skipEgressFilter: boolean
  skipRestartRearm: boolean
  onProgress: (message: string) => void
}): Promise<void> {
  const first = opts.allow[0]!
  const [allowHost, allowPortText] = splitHostPort(first)
  const canary = CANARY_HOSTS.find((host) => !opts.allow.some((entry) => splitHostPort(entry)[0] === host))

  // A peer that LISTENS. Probing a silent address cannot tell "filtered" from
  // "nothing there", and the interesting case is precisely a worker dialling a
  // service its neighbour exposes.
  await opts.cli(['rm', '-f', opts.peerName], { timeoutMs: 30_000 })
  const peerStarted = await opts.cli([
    'run', '-d', '--name', opts.peerName, '--network', opts.network, '--entrypoint', 'node', opts.image,
    '-e', `require('node:net').createServer((s) => s.end('peer\\n')).listen(${PEER_PORT})`,
  ], { timeoutMs: 60_000 })
  if (peerStarted.code !== 0) {
    throw new NetJailProvisionError(
      `backend ${opts.backend}: could not start the net-jail verification peer — ${firstLine(peerStarted)}`,
    )
  }

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

    /** Run the probe program inside the jailed container and read its answers. */
    const probeOnce = async (containerId: string, phase: string): Promise<void> => {
      const probe = await opts.cli(
        ['exec', '-e', `NETJAIL_PROBE=${JSON.stringify(spec)}`, containerId, 'node', '-e', PROBE_PROGRAM],
        { timeoutMs: 120_000 },
      )
      const observed = Object.fromEntries(
        probe.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )
      const fail = (detail: string): never => {
        throw new NetJailProvisionError(
          `backend ${opts.backend}: net-jail on ${opts.network} did not verify ${phase} — ${detail}. ` +
            `Probe output: ${probe.stdout.trim().replace(/\n/gu, '; ') || firstLine(probe)}`,
        )
      }

      // The control comes first. If the probe cannot reach the relay, every
      // "blocked" line below is worthless — a container with a broken network
      // stack denies everything and proves nothing.
      if (observed['relay-reachable'] !== 'yes') {
        fail(
          `the probe could not reach the relay at ${spec.relay} (${observed['relay-reachable'] ?? 'no result'}), ` +
            'so the jail denies its own model endpoint and no other denial in this probe is evidence of anything',
        )
      }
      if (observed['default-routes'] !== '0') {
        fail(
          `a jailed container still has ${observed['default-routes'] ?? 'an unknown number of'} default route(s), ` +
            'so it can route off the network',
        )
      }
      if (observed['gateway-reachable'] !== 'no') {
        fail(
          `the Docker host is reachable from inside the jail at ${opts.gateway} ` +
            `(${observed['gateway-detail'] ?? observed['gateway-reachable'] ?? 'unknown'}). An address that ` +
            'answers on the worker\'s own subnet is a next hop that never passes the relay and is on no ' +
            'allowlist — every service on the host, and the internet behind them, is one connect() away',
        )
      }
      if (observed['peer-reachable'] !== 'no') {
        fail(
          `another container on ${opts.network} is reachable from inside the jail at ${spec.peer} ` +
            `(${observed['peer-detail'] ?? 'unknown'}), so the relay is not the only next hop`,
        )
      }
      if (observed['linklocal-reachable'] !== 'no') {
        fail(
          `link-local is reachable from inside the jail (${observed['linklocal-detail'] ?? 'unknown'}); ` +
            'cloud instance metadata, and the credentials it hands out, live there',
        )
      }
      if (observed['net-admin'] !== 'denied') {
        fail(
          `a jailed container can run iptables itself (${observed['net-admin'] ?? 'unknown'}), so the worker ` +
            'can flush the very rules that confine it',
        )
      }
      if (observed['canary-resolves'] === 'yes') fail(`${canary} still resolves inside the jail`)
      if (observed['allow-resolves'] !== 'yes') fail(`the allowlisted host ${allowHost} does not resolve inside the jail`)
      if (observed['allow-tls'] !== undefined && !['yes', 'skipped-non-443'].includes(observed['allow-tls'])) {
        fail(`the allowlisted endpoint ${first} did not complete a TLS handshake through the relay (${observed['allow-tls']})`)
      }
    }

    await withJailedContainer({
      network: opts.network,
      image: opts.image,
      relayIp: opts.relayAddress.ip,
      ...(opts.relayAddress.ip6 ? { relayIp6: opts.relayAddress.ip6 } : {}),
      cli: opts.cli,
      label: 'verification probe',
      name: opts.probeName,
      skipFilter: opts.skipEgressFilter,
    }, async (containerId) => {
      await probeOnce(containerId, 'as provisioned')
      await restartAndRearm(containerId, opts)
      await probeOnce(containerId, 'after the container restarted')
      opts.onProgress(
        `net-jail ${opts.network} verified twice — once as provisioned and once after a ` +
          '`docker restart`, the restart a worker triggers by exiting non-cleanly',
      )
    })
  } finally {
    await opts.cli(['rm', '-f', opts.peerName], { timeoutMs: 30_000 })
  }
}

/**
 * Restart the probe the way a worker gets its own slot restarted, then put the
 * filter back the way the pool does.
 *
 * `terminateDockerExecution` runs `docker restart --time 0` against a slot
 * whenever the command inside it exits non-cleanly, because killing the local
 * `docker exec` client does not stop the process tree in the container. A worker
 * reaches that path by exiting non-zero, and Docker gives the container back
 * with brand-new, empty namespaces. So this is the escape, reproduced exactly.
 *
 * The re-arm calls the SAME function the pool's `afterCreate` calls. Verifying
 * through a second implementation would prove a jail no worker ever runs in,
 * which is the failure this whole file is written against.
 *
 * The restart must be observable — `StartedAt` has to move. A "restart" that
 * changed nothing would make the second probe a re-run of the first and the
 * whole check theatre, so provisioning fails rather than reporting a property it
 * did not test.
 */
async function restartAndRearm(containerId: string, opts: {
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
  if (restarted.code !== 0) {
    throw new NetJailProvisionError(
      `backend ${opts.backend}: could not restart the verification probe, so the jail's survival of a ` +
        `container restart is untested — ${firstLine(restarted)}`,
    )
  }
  const after = await startedAt()
  if (!after || after === before) {
    throw new NetJailProvisionError(
      `backend ${opts.backend}: the verification probe reported the same start time (${before || 'unknown'}) ` +
        'after `docker restart`, so no restart was actually observed and the jail\'s survival of one cannot be ' +
        'claimed',
    )
  }
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

/** Port the verification peer listens on, purely so the probe has a live target. */
const PEER_PORT = 9

/**
 * Link-local addresses the probe must not reach. `169.254.169.254` is the
 * instance-metadata endpoint on EC2/GCP/Azure/DigitalOcean and `169.254.170.2`
 * is the ECS task-credential endpoint; both hand out cloud credentials to
 * anything that can dial them.
 */
const LINK_LOCAL_TARGETS = ['169.254.169.254:80', '169.254.170.2:80']

/**
 * The probe, run by `node -e` inside the jailed container.
 *
 * Reachability is decided by the ERROR, not by whether something answered.
 * `ECONNREFUSED` means a RST came back, which proves the address is reachable
 * and merely has nothing listening — on an unfiltered jail that is the usual
 * answer from the host gateway, and reading it as "blocked" is exactly how a
 * verifier passes a jail that leaks. Only an administratively-prohibited,
 * unreachable or timed-out result counts as denied.
 */
const PROBE_PROGRAM = `
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
  const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\\n')
    .filter((line) => /^[^\\s]+\\s+00000000\\s/.test(line)).length
  say('default-routes', routes)

  const gateway = []
  for (const port of [22, 80, 443, 2375, 2376, 8080]) gateway.push(await dial(spec.gateway + ':' + port, 4000))
  say('gateway-reachable', verdict(gateway))
  say('gateway-detail', gateway.join(' | '))

  const peer = [await dial(spec.peer, 4000)]
  say('peer-reachable', verdict(peer))
  say('peer-detail', peer.join(' | '))

  const linkLocal = []
  for (const target of spec.linkLocal) linkLocal.push(await dial(target, 3000))
  say('linklocal-reachable', verdict(linkLocal))
  say('linklocal-detail', linkLocal.join(' | '))

  const relay = await dial(spec.relay, 10000)
  say('relay-reachable', relay.split(' ')[1] === 'open' ? 'yes' : relay)

  const ipt = spawnSync('iptables', ['-w', '2', '-S'], { encoding: 'utf8' })
  say('net-admin', ipt.error ? 'absent:' + ipt.error.code : ipt.status === 0 ? 'granted' : 'denied')

  if (spec.canary) {
    say('canary-resolves', await dns.lookup(spec.canary).then(() => 'yes', () => 'no'))
  } else {
    say('canary-resolves', 'skipped')
  }
  say('allow-resolves', await dns.lookup(spec.allowHost).then(() => 'yes', () => 'no'))

  if (spec.allowPort !== 443) {
    say('allow-tls', 'skipped-non-443')
    return
  }
  await new Promise((resolve) => {
    const socket = tls.connect({ host: spec.allowHost, port: 443, servername: spec.allowHost }, () => {
      say('allow-tls', socket.authorized ? 'yes' : 'unauthorized')
      socket.destroy(); resolve()
    })
    socket.setTimeout(20000, () => { say('allow-tls', 'timeout'); socket.destroy(); resolve() })
    socket.on('error', (error) => { say('allow-tls', 'error:' + error.message); socket.destroy(); resolve() })
  })
}

main().catch((error) => { say('probe-error', error && error.message); process.exitCode = 1 })
`

function splitHostPort(entry: string): [string, string] {
  const idx = entry.lastIndexOf(':')
  return [entry.slice(0, idx), entry.slice(idx + 1)]
}

function firstLine(result: { stderr: string; spawnError?: string; code: number }): string {
  const text = result.stderr.trim() || result.spawnError || `docker exited ${result.code}`
  return text.split('\n')[0] ?? text
}
