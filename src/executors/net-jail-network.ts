/**
 * net-jail provisioning — build the network topology that makes deny-by-default
 * egress a property of the kernel rather than a request to the agent.
 *
 * Three Docker objects per jailed backend:
 *
 *   <prefix>-netjail          an `--internal` network. Docker gives it no
 *                             gateway, so a container on it has no default
 *                             route and no external DNS. This is the deny.
 *   <prefix>-netjail-egress   an ordinary bridge network, reachable only by the
 *                             relay.
 *   <prefix>-netjail-relay    a container on BOTH, running `net-relay.mjs`. It
 *                             is registered on the internal network under a
 *                             network-scoped alias for every allowlisted
 *                             hostname, and it verifies the name each
 *                             connection claims (TLS SNI / HTTP Host) before
 *                             forwarding. This is the allow.
 *
 * Why this and not proxy environment variables: `HTTPS_PROXY` is a request the
 * worker can decline with `unset`. Here there is nothing to unset — the worker
 * never learns a proxy exists, its clients dial what they believe is the
 * origin, and removing every variable in its environment changes nothing about
 * what it can reach.
 *
 * Provisioning ends by PROVING the jail on a throwaway container drawn from the
 * same image and the same network a worker gets: a name that must not resolve,
 * a name that must, and a real TLS handshake through the relay. A provisioner
 * that returned success without taking that path would be the control this
 * feature exists to replace.
 */

import { fileURLToPath } from 'node:url'
import { dockerCli, type DockerCli } from './docker-cli.js'
import { assertDockerNetworkName } from './docker-network.js'
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
  /** Canonical `host:port` list proven to be the enforced allowlist. */
  allow: string[]
  /** The same list with provenance, for the startup log and for refusals. */
  entries: NetJailAllowEntry[]
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

  const destroy = async (): Promise<void> => {
    await cli(['rm', '-f', relay], { timeoutMs: 30_000 })
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
    // names resolve to the relay inside the jail and nowhere else.
    const aliasArgs = hosts.flatMap((host) => ['--alias', host])
    const connected = await cli(['network', 'connect', ...aliasArgs, network, relay], { timeoutMs: 30_000 })
    if (connected.code !== 0) {
      throw new NetJailProvisionError(
        `backend ${opts.backend}: could not attach the net-jail relay to ${network} — ${firstLine(connected)}`,
      )
    }

    onProgress(`net-jail ${network} relay=${relay} allow=${allow.join(',')}`)
    await verifyNetJail({ backend: opts.backend, network, image: opts.image, allow, cli })
    return { backend: opts.backend, network, allow, entries: opts.allow, destroy }
  } catch (error) {
    await destroy()
    throw error
  }
}

/**
 * Prove the jail on the real path before any request can use it.
 *
 * Three facts, each of which has to hold for the control to mean anything:
 * a jailed container has no default route, a host that is not allowlisted does
 * not resolve, and an allowlisted host completes a TLS handshake through the
 * relay to the true origin. Anything less is a configuration that reports a
 * policy it has not demonstrated.
 */
async function verifyNetJail(opts: {
  backend: string
  network: string
  image: string
  allow: string[]
  cli: DockerCli
}): Promise<void> {
  const first = opts.allow[0]!
  const [allowHost, allowPortText] = splitHostPort(first)
  const canary = CANARY_HOSTS.find((host) => !opts.allow.some((entry) => splitHostPort(entry)[0] === host))
  const script = [
    'routes=$(grep -cE "^[a-z0-9]+[[:space:]]+00000000[[:space:]]" /proc/net/route 2>/dev/null || true)',
    'echo "default-routes=${routes:-0}"',
    canary
      ? `if getent hosts ${canary} >/dev/null 2>&1; then echo "canary-resolves=yes"; else echo "canary-resolves=no"; fi`
      : 'echo "canary-resolves=skipped"',
    `if getent hosts ${allowHost} >/dev/null 2>&1; then echo "allow-resolves=yes"; else echo "allow-resolves=no"; fi`,
    allowPortText === '443'
      ? `node -e 'const t=require("node:tls");const s=t.connect({host:"${allowHost}",port:443,servername:"${allowHost}"},`
        + `()=>{console.log("allow-tls="+(s.authorized?"yes":"unauthorized"));s.destroy()});`
        + `s.setTimeout(15000,()=>{console.log("allow-tls=timeout");s.destroy()});`
        + `s.on("error",e=>{console.log("allow-tls=error:"+e.message);s.destroy()})'`
      : 'echo "allow-tls=skipped-non-443"',
  ].join('\n')

  const probe = await opts.cli(
    ['run', '--rm', '--network', opts.network, '--entrypoint', 'sh', opts.image, '-c', script],
    { timeoutMs: 90_000 },
  )
  const observed = Object.fromEntries(
    probe.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  const fail = (detail: string): never => {
    throw new NetJailProvisionError(
      `backend ${opts.backend}: net-jail on ${opts.network} did not verify — ${detail}. ` +
        `Probe output: ${probe.stdout.trim().replace(/\n/gu, '; ') || firstLine(probe)}`,
    )
  }
  if (observed['default-routes'] !== '0') {
    fail(`a jailed container still has ${observed['default-routes'] ?? 'an unknown number of'} default route(s), so it can route off the network`)
  }
  if (observed['canary-resolves'] === 'yes') fail(`${canary} still resolves inside the jail`)
  if (observed['allow-resolves'] !== 'yes') fail(`the allowlisted host ${allowHost} does not resolve inside the jail`)
  if (observed['allow-tls'] !== undefined && !['yes', 'skipped-non-443'].includes(observed['allow-tls'])) {
    fail(`the allowlisted endpoint ${first} did not complete a TLS handshake through the relay (${observed['allow-tls']})`)
  }
}

function splitHostPort(entry: string): [string, string] {
  const idx = entry.lastIndexOf(':')
  return [entry.slice(0, idx), entry.slice(idx + 1)]
}

function firstLine(result: { stderr: string; spawnError?: string; code: number }): string {
  const text = result.stderr.trim() || result.spawnError || `docker exited ${result.code}`
  return text.split('\n')[0] ?? text
}
