/** Provision and prove the Docker network used by the outbound allowlist. */

import { fileURLToPath } from 'node:url'
import { dockerCli, type DockerCli } from './docker-cli.js'
import { assertDockerNetworkName } from './docker-network.js'
import { dockerOwnerLabels, removeOwnedDockerResource } from './docker-resource-owner.js'
import {
  applyNetJailEgressFilter,
  containerAddressOn,
  relayAddressFor,
  type ContainerNetworkAddress,
} from './net-jail-egress.js'
import { verifyNetJail, firstLine } from './net-jail-probe.js'
import { canonicalAllowList, type NetJailAllowEntry } from '../jail/net-allowlist.js'

const RELAY_SOURCE_PATH = fileURLToPath(new URL('../jail/net-relay.mjs', import.meta.url))
const RELAY_CONTAINER_PATH = '/opt/cli-bridge-net-relay.mjs'

export class NetJailProvisionError extends Error {
  readonly code = 'net_jail_unenforceable' as const
  constructor(message: string) { super(message); this.name = 'NetJailProvisionError' }
}

export interface NetJailProvision {
  backend: string
  network: string
  relayIp: string
  relayIp6?: string
  allow: string[]
  entries: NetJailAllowEntry[]
  applyFilter(containerId: string, label: string): Promise<void>
  destroy(): Promise<void>
}

export interface ProvisionNetJailOptions {
  backend: string
  namePrefix: string
  resourceOwner: string
  image: string
  allow: NetJailAllowEntry[]
  cli?: DockerCli
  onProgress?: (message: string) => void
  relaySourcePath?: string
  skipEgressFilterForVerification?: boolean
  skipRestartRearmForVerification?: boolean
}

export async function provisionNetJail(opts: ProvisionNetJailOptions): Promise<NetJailProvision> {
  const cli = opts.cli ?? dockerCli
  const onProgress = opts.onProgress ?? (() => {})
  const network = assertDockerNetworkName(`${opts.namePrefix}-netjail`, 'net-jail network name')
  const egressNetwork = assertDockerNetworkName(`${opts.namePrefix}-netjail-egress`, 'net-jail egress network name')
  const relay = `${opts.namePrefix}-netjail-relay`
  const allow = canonicalAllowList(opts.allow)
  if (allow.length === 0) throw new NetJailProvisionError(
    `backend ${opts.backend}: net-jail is enabled but no model endpoint could be derived and ` +
    'BRIDGE_NET_JAIL_ALLOW is empty — the worker would be unable to reach any model. Set a base URL ' +
    '(ANTHROPIC_BASE_URL / OPENAI_BASE_URL / TANGLE_ROUTER_URL) or name the endpoint in BRIDGE_NET_JAIL_ALLOW.',
  )
  const probeName = `${opts.namePrefix}-netjail-probe`
  const peerName = `${opts.namePrefix}-netjail-peer`
  const destroy = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const name of [relay, probeName, peerName]) try { await removeOwnedDockerResource(cli, 'container', name, opts.resourceOwner) } catch (error) { failures.push(error) }
    for (const name of [network, egressNetwork]) try { await removeOwnedDockerResource(cli, 'network', name, opts.resourceOwner) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `could not remove net-jail resources for ${opts.backend}`)
  }
  await destroy()
  try {
    for (const [name, extraArgs] of [[network, ['--internal']], [egressNetwork, []]] as const) {
      const created = await cli(['network', 'create', ...dockerOwnerLabels(opts.resourceOwner, 'net-jail-network'), ...extraArgs, name], { timeoutMs: 30_000 })
      if (created.code !== 0) throw new NetJailProvisionError(`backend ${opts.backend}: could not create net-jail network ${name} — ${firstLine(created)}`)
    }
    const relaySource = opts.relaySourcePath ?? RELAY_SOURCE_PATH
    const started = await cli([
      'run', '-d', '--name', relay, ...dockerOwnerLabels(opts.resourceOwner, 'net-jail-relay'), '--network', egressNetwork,
      '--restart', 'on-failure:3', '--memory', '256m', '--memory-swap', '256m', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-v', `${relaySource}:${RELAY_CONTAINER_PATH}:ro`, '-e', `NET_JAIL_ALLOW=${allow.join(',')}`,
      '--entrypoint', 'node', opts.image, RELAY_CONTAINER_PATH,
    ], { timeoutMs: 60_000 })
    if (started.code !== 0) throw new NetJailProvisionError(`backend ${opts.backend}: could not start the net-jail relay — ${firstLine(started)}`)
    const { subnet, gateway } = await readNetworkIpam(cli, network, opts.backend)
    const pinnedRelayIp = relayAddressFor(subnet, gateway)
    const hosts = [...new Set(opts.allow.map(entry => entry.host))].sort()
    const connected = await cli(['network', 'connect', '--ip', pinnedRelayIp, ...hosts.flatMap(host => ['--alias', host]), network, relay], { timeoutMs: 30_000 })
    if (connected.code !== 0) throw new NetJailProvisionError(`backend ${opts.backend}: could not attach the net-jail relay to ${network} at ${pinnedRelayIp} — ${firstLine(connected)}`)
    const relayAddress = await containerAddressOn(cli, network, relay)
    if (relayAddress.ip !== pinnedRelayIp) throw new NetJailProvisionError(`backend ${opts.backend}: the net-jail relay was pinned to ${pinnedRelayIp} but Docker reports ${relayAddress.ip}; the address every worker is filtered towards must be the relay's.`)
    const applyFilter = (containerId: string, label: string): Promise<void> => applyNetJailEgressFilter({
      containerId, relayIp: relayAddress.ip, ...(relayAddress.ip6 ? { relayIp6: relayAddress.ip6 } : {}), image: opts.image, cli, label,
    })
    onProgress(`net-jail ${network} relay=${relay}@${relayAddress.ip} allow=${allow.join(',')}`)
    await verifyNetJail({
      backend: opts.backend, network, image: opts.image, allow, cli, relayAddress, gateway, probeName, peerName,
      resourceOwner: opts.resourceOwner, skipEgressFilter: opts.skipEgressFilterForVerification === true,
      skipRestartRearm: opts.skipRestartRearmForVerification === true, onProgress,
    })
    return { backend: opts.backend, network, relayIp: relayAddress.ip, ...(relayAddress.ip6 ? { relayIp6: relayAddress.ip6 } : {}), allow, entries: opts.allow, applyFilter, destroy }
  } catch (error) {
    try { await destroy() } catch (cleanupError) { throw new AggregateError([error, cleanupError], `net-jail provisioning and cleanup failed for ${opts.backend}`) }
    throw error
  }
}

async function readNetworkIpam(cli: DockerCli, network: string, backend: string): Promise<{ subnet: string; gateway: string }> {
  const result = await cli(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}', network], { timeoutMs: 30_000 })
  const [subnet = '', gateway = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || !subnet || !gateway) throw new NetJailProvisionError(`backend ${backend}: could not read the IPAM configuration of ${network} — ${firstLine(result)}`)
  return { subnet, gateway }
}

export type { ContainerNetworkAddress }
