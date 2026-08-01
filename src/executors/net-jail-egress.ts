/**
 * The per-container egress filter — the control that makes the relay the ONLY
 * next hop a jailed worker has.
 *
 * `--internal` denies routing OFF the bridge. It does not deny the bridge
 * itself: Docker still puts the host's gateway address on that subnet, on-link
 * in the worker's own network, and every other container on the same network is
 * on-link too. Neither is on the allowlist, neither goes through the relay, and
 * reaching the Docker host is reaching every service the host runs and, through
 * any of them, the internet. Measured on the shipped jail before this file
 * existed: 339,594 bytes of github.com with `ssl_verify_result=0`, pulled from a
 * jailed container via `172.20.0.1`. `--internal` alone is not deny-by-default.
 *
 * So the deny is moved into the worker's OWN network namespace, as a packet
 * filter with a default policy of DROP and exactly two exceptions: loopback
 * (Docker's embedded resolver lives at 127.0.0.11 inside the namespace) and the
 * relay's pinned address. Everything else — the host gateway, peer containers,
 * link-local metadata addresses, every IPv6 destination — is rejected by the
 * kernel before it reaches an interface.
 *
 * Where the capability lives, and why not in the worker. Installing rules needs
 * `CAP_NET_ADMIN`; a worker holding it could flush them. So the rules are
 * installed by a throwaway sidecar that JOINS the worker's network namespace
 * (`--network container:<id>`), holds `CAP_NET_ADMIN` and nothing else, writes
 * the rules and exits. The worker keeps Docker's default capability set, which
 * does not include `CAP_NET_ADMIN`, so its own `iptables` call fails with
 * `Permission denied` even as uid 0. The filter outlives the sidecar because it
 * is state of the namespace, not of the process.
 *
 * Alternatives that were measured and rejected:
 *
 *   - Host `DOCKER-USER` rules. That chain hangs off FORWARD. Container→host
 *     traffic is delivered locally and traverses INPUT, so the chain never sees
 *     the escape at all; same-bridge peer traffic only reaches it when
 *     `bridge-nf-call-iptables` happens to be on. It also needs root on the host
 *     and mutates firewall state shared with everything else on the machine.
 *   - Docker network options. `--internal`, `enable_ip_masquerade`,
 *     `enable_icc` and an explicit subnet/gateway all still leave the bridge's
 *     address configured on the host and on-link for members; there is no option
 *     that removes the host from a bridge network's reachable set.
 *   - Moving the deny OUTSIDE the namespace so a restart cannot clear it. There
 *     is nowhere to put it that is both outside the namespace and on the path:
 *     the only such place is the host's own firewall, which is the DOCKER-USER
 *     option above with its FORWARD-chain blind spot, needs root on the host,
 *     and would have to name the container by an address Docker is free to
 *     reassign on the very restart the rule is supposed to survive. The property
 *     is instead obtained by scoping the filter to a container START and
 *     re-installing it before the container is used again — see
 *     `ContainerPoolOptions.afterCreate`.
 *
 * The filter needs `iptables` in the image the sidecar runs. That is the same
 * runtime image the workers use (see `docker/Dockerfile.cli-runtime`), so no
 * additional image is a prerequisite; an image without it fails provisioning
 * with the rebuild command rather than running a jail that does not deny.
 */

import { isIP } from 'node:net'
import type { DockerCli } from './docker-cli.js'

/** Printed by the sidecar only after every rule is in place. */
const APPLIED_MARK = 'netjail-egress-applied'

/** `iptables` absent from the enforcer image — reported as itself, not as a rule failure. */
const MISSING_TOOL_MARK = 'netjail-egress-missing-iptables'

/** IPv6 is routable in the namespace but `ip6tables` cannot filter it. */
const UNFILTERED_V6_MARK = 'netjail-egress-v6-unfiltered'

export class NetJailEgressError extends Error {
  readonly code = 'net_jail_egress_unenforceable' as const
  constructor(message: string) {
    super(message)
    this.name = 'NetJailEgressError'
  }
}

export interface NetJailEgressTarget {
  /** Container whose network namespace receives the filter. */
  containerId: string
  /** Only IPv4 destination a jailed container may send to. */
  relayIp: string
  /** Relay's address on the same network when the network carries IPv6. */
  relayIp6?: string
  /** Image the enforcer sidecar runs; must contain `iptables`. */
  image: string
  cli: DockerCli
  /** Names the target in failure messages, e.g. `slot 2` or `verification probe`. */
  label: string
}

/**
 * Install the deny-by-default filter into a container's network namespace.
 *
 * Throws on anything other than a fully applied ruleset. A caller that swallows
 * this is running an unjailed container, which is the defect the whole feature
 * exists to remove — so every call site treats it as fatal for that container.
 */
export async function applyNetJailEgressFilter(target: NetJailEgressTarget): Promise<void> {
  if (isIP(target.relayIp) !== 4) {
    throw new NetJailEgressError(
      `net-jail egress filter for ${target.label}: relay address '${target.relayIp}' is not an IPv4 literal`,
    )
  }
  if (target.relayIp6 !== undefined && isIP(target.relayIp6) !== 6) {
    throw new NetJailEgressError(
      `net-jail egress filter for ${target.label}: relay IPv6 address '${target.relayIp6}' is not an IPv6 literal`,
    )
  }
  const result = await target.cli([
    'run', '--rm',
    // Joining the worker's namespace is what makes these rules the WORKER's
    // rules. The sidecar contributes only the capability to write them.
    '--network', `container:${target.containerId}`,
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_ADMIN',
    '--security-opt', 'no-new-privileges',
    '--entrypoint', 'sh',
    target.image,
    '-c', egressFilterScript(target.relayIp, target.relayIp6),
  ], { timeoutMs: 60_000 })

  const output = `${result.stdout}${result.stderr}`
  if (output.includes(MISSING_TOOL_MARK)) {
    throw new NetJailEgressError(
      `net-jail egress filter for ${target.label}: image ${target.image} has no 'iptables', so a jailed ` +
        'container cannot be prevented from reaching the Docker host and its peers. Rebuild the runtime ' +
        'image (docker build -f docker/Dockerfile.cli-runtime -t ' + target.image + ' .), which installs it. ' +
        'Refusing to run a jail that does not deny.',
    )
  }
  if (output.includes(UNFILTERED_V6_MARK)) {
    throw new NetJailEgressError(
      `net-jail egress filter for ${target.label}: the container has routable IPv6 addresses but ip6tables ` +
        'is unusable in this kernel/namespace, so IPv6 egress would be unrestricted.',
    )
  }
  if (result.code !== 0 || !output.includes(APPLIED_MARK)) {
    const detail = result.stderr.trim() || result.spawnError || `docker exited ${result.code}`
    throw new NetJailEgressError(
      `net-jail egress filter for ${target.label}: could not install egress rules in the container's ` +
        `network namespace — ${detail.split('\n')[0] ?? detail}`,
    )
  }
}

/**
 * The ruleset, as a shell program run inside the target namespace.
 *
 * `-j REJECT --reject-with icmp-admin-prohibited` sits ahead of the DROP policy
 * on purpose. A DROP-only jail makes every denied dial hang until the client's
 * own timeout, which an agent experiences as a wedged tool call rather than a
 * refusal; REJECT returns EHOSTUNREACH in under a millisecond. The policy stays
 * DROP underneath so a kernel without the REJECT target still fails closed.
 *
 * Both directions are set, not just OUTPUT: INPUT DROP keeps a peer container on
 * the same bridge from reaching a service a worker happens to expose. Loopback
 * is exempted in both because Docker's embedded DNS resolver answers on
 * 127.0.0.11 inside this namespace — dropping it would break name resolution for
 * the allowlist itself.
 */
function egressFilterScript(relayIp: string, relayIp6: string | undefined): string {
  const v4 = [
    'iptables -w 5 -F OUTPUT', 'iptables -w 5 -F INPUT', 'iptables -w 5 -F FORWARD',
    'iptables -w 5 -A OUTPUT -o lo -j ACCEPT',
    `iptables -w 5 -A OUTPUT -d ${relayIp}/32 -j ACCEPT`,
    'iptables -w 5 -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited',
    'iptables -w 5 -P OUTPUT DROP',
    'iptables -w 5 -A INPUT -i lo -j ACCEPT',
    `iptables -w 5 -A INPUT -s ${relayIp}/32 -j ACCEPT`,
    'iptables -w 5 -P INPUT DROP',
    'iptables -w 5 -P FORWARD DROP',
  ]
  const v6 = [
    'ip6tables -w 5 -F OUTPUT', 'ip6tables -w 5 -F INPUT', 'ip6tables -w 5 -F FORWARD',
    'ip6tables -w 5 -A OUTPUT -o lo -j ACCEPT',
    ...(relayIp6 ? [`ip6tables -w 5 -A OUTPUT -d ${relayIp6}/128 -j ACCEPT`] : []),
    'ip6tables -w 5 -A OUTPUT -j REJECT --reject-with adm-prohibited',
    'ip6tables -w 5 -P OUTPUT DROP',
    'ip6tables -w 5 -A INPUT -i lo -j ACCEPT',
    ...(relayIp6 ? [`ip6tables -w 5 -A INPUT -s ${relayIp6}/128 -j ACCEPT`] : []),
    'ip6tables -w 5 -P INPUT DROP',
    'ip6tables -w 5 -P FORWARD DROP',
  ]
  return [
    'set -eu',
    `command -v iptables >/dev/null 2>&1 || { echo ${MISSING_TOOL_MARK}; exit 90; }`,
    ...v4,
    // A namespace with no IPv6 stack at all needs no IPv6 rules; one that has
    // global addresses and no way to filter them is an open jail, so it fails.
    'if ip6tables -w 5 -S >/dev/null 2>&1; then',
    ...v6.map((line) => `  ${line}`),
    'else',
    `  routable6=$(awk '$6 != "lo"' /proc/net/if_inet6 2>/dev/null | wc -l || true)`,
    `  if [ "\${routable6:-0}" != "0" ]; then echo ${UNFILTERED_V6_MARK}; exit 91; fi`,
    'fi',
    `echo ${APPLIED_MARK}`,
  ].join('\n')
}

export interface JailedContainerOptions {
  /** Jail network the container joins. */
  network: string
  image: string
  relayIp: string
  relayIp6?: string
  cli: DockerCli
  label: string
  /** Container name; must be unique on the host for the call's duration. */
  name: string
  /** Command the container runs. Defaults to an idle sleep. */
  command?: string[]
  /** Skip filter installation. Only for calibration: proves the verifier catches an unfiltered jail. */
  skipFilter?: boolean
}

/**
 * Run a throwaway container on the jail network under the SAME egress filter a
 * worker gets, hand its id to `fn`, and remove it.
 *
 * Provisioning verification and the enforcement tests both need "a container
 * exactly as a worker sees it". Two implementations of that would drift, and
 * the direction it drifts is a probe proving a jail no worker actually runs in.
 *
 * The container is started before the filter is installed — a namespace has to
 * exist before rules can be written into it. Nothing runs in that window: the
 * command is an idle sleep and no work is dispatched until this function
 * returns, which is also the contract at the pool's slot-provisioning seam.
 */
export async function withJailedContainer<T>(
  opts: JailedContainerOptions,
  fn: (containerId: string) => Promise<T>,
): Promise<T> {
  await opts.cli(['rm', '-f', opts.name], { timeoutMs: 30_000 })
  const started = await opts.cli([
    'run', '-d', '--name', opts.name,
    '--network', opts.network,
    '--entrypoint', 'sh',
    opts.image,
    '-c', 'sleep 900',
  ], { timeoutMs: 60_000 })
  if (started.code !== 0) {
    throw new NetJailEgressError(
      `net-jail ${opts.label}: could not start a container on ${opts.network} — ` +
        `${started.stderr.trim().split('\n')[0] ?? `docker exited ${started.code}`}`,
    )
  }
  const containerId = started.stdout.trim()
  try {
    if (!opts.skipFilter) {
      await applyNetJailEgressFilter({
        containerId,
        relayIp: opts.relayIp,
        ...(opts.relayIp6 ? { relayIp6: opts.relayIp6 } : {}),
        image: opts.image,
        cli: opts.cli,
        label: opts.label,
      })
    }
    return await fn(containerId)
  } finally {
    await opts.cli(['rm', '-f', opts.name], { timeoutMs: 30_000 })
  }
}

export interface ContainerNetworkAddress {
  ip: string
  ip6?: string
}

/** A container's addresses on one network, as its neighbours on that network see them. */
export async function containerAddressOn(
  cli: DockerCli,
  network: string,
  container: string,
): Promise<ContainerNetworkAddress> {
  const format = `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}} {{.GlobalIPv6Address}}{{end}}`
  const result = await cli(['inspect', '-f', format, container], { timeoutMs: 30_000 })
  const [ip = '', ip6 = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || isIP(ip) !== 4) {
    throw new NetJailEgressError(
      `net-jail: container ${container} has no IPv4 address on ${network} — ` +
        `${result.stderr.trim().split('\n')[0] || result.stdout.trim() || `docker exited ${result.code}`}`,
    )
  }
  return isIP(ip6) === 6 ? { ip, ip6 } : { ip }
}

/**
 * The address to pin the relay to: the one immediately after the gateway.
 *
 * Pinned rather than observed because it becomes a rule in every worker's
 * namespace. A relay that came back on a different address after a restart
 * would leave every worker filtered towards an address nothing answers on —
 * fail-closed, but a jail that silently denies its own model endpoint is the
 * failure operators mistake for a broken bridge.
 */
export function relayAddressFor(subnet: string, gateway: string): string {
  const [base, prefixText] = subnet.split('/')
  const prefix = Number(prefixText)
  if (isIP(base ?? '') !== 4 || isIP(gateway) !== 4 || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new NetJailEgressError(
      `net-jail: cannot pin a relay address inside subnet '${subnet}' with gateway '${gateway}' — ` +
        'expected an IPv4 subnet no larger than /30 with an IPv4 gateway',
    )
  }
  const size = 2 ** (32 - prefix)
  // `>>> 0` because JS bitwise operands are signed 32-bit: every address above
  // 127.255.255.255 masks to a negative number without it, and the range check
  // below would then reject the private ranges Docker actually uses.
  const network = (toUint32(base!) & (0xffffffff - (size - 1))) >>> 0
  const candidate = toUint32(gateway) + 1
  // Excludes the network and broadcast addresses of the subnet.
  if (candidate <= network || candidate >= network + size - 1) {
    throw new NetJailEgressError(
      `net-jail: the address after gateway ${gateway} falls outside usable range of ${subnet}`,
    )
  }
  return toDotted(candidate)
}

function toUint32(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0)
}

function toDotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}
