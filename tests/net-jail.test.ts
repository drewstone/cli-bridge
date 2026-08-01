/**
 * net-jail — deny-by-default egress for the worker process tree.
 *
 * The suite is split by what a failure would mean. The fast tests pin the
 * decision logic: what lands on the allowlist, which requests are refused, and
 * which configurations the bridge refuses to start under. The `real docker`
 * block does the only thing that can actually establish the control works —
 * provision the jail, put a container on it, and watch `git clone` and
 * `curl https://github.com` fail while the model endpoint answers.
 *
 * That split is deliberate. A suite that asserted the policy was recorded and
 * stopped there is the exact defect this feature exists to remove, and it is
 * the defect filed against the sandbox API as tangle-network/agent-dev-container#4611.
 */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { canonicalAllowList, modelEndpointsFor, parseAllowEntry, parseAllowList } from '../src/jail/net-allowlist.js'
import { resolveNetJailSpec } from '../src/jail/resolve-net-spec.js'
import { assertNetJailEnforced, type NetJailRegistry } from '../src/jail/enforce-net-jail.js'
import { provisionNetJail, NetJailProvisionError } from '../src/executors/net-jail-network.js'
import { dockerCli, type DockerCli } from '../src/executors/docker-cli.js'
import { parseAllowlist, readHttpHost, readSni, startRelay } from '../src/jail/net-relay.mjs'

const execFileAsync = promisify(execFile)

describe('net-jail allowlist derivation', () => {
  it('extracts the host and port of a configured base URL so the caller never types it', () => {
    const entries = modelEndpointsFor('opencode', { TANGLE_ROUTER_URL: 'https://router.tangle.tools/v1' })
    expect(canonicalAllowList(entries)).toEqual(['router.tangle.tools:443'])
    expect(entries[0]!.source).toBe('TANGLE_ROUTER_URL')
  })

  it('uses a backend default only when nothing is configured, and never both', () => {
    expect(canonicalAllowList(modelEndpointsFor('claude', {}))).toEqual(['api.anthropic.com:443'])
    // A configured base URL means the operator routed away from the default;
    // keeping the default would widen the jail back to the provider.
    expect(canonicalAllowList(modelEndpointsFor('claude', { ANTHROPIC_BASE_URL: 'https://router.tangle.tools/v1' })))
      .toEqual(['router.tangle.tools:443'])
  })

  it('carries a non-default port through from the base URL', () => {
    expect(canonicalAllowList(modelEndpointsFor('codex', { OPENAI_BASE_URL: 'http://gw.internal:8080/v1' })))
      .toEqual(['gw.internal:8080'])
  })

  it('derives nothing for a multi-provider CLI with no base URL, rather than guessing an endpoint', () => {
    expect(modelEndpointsFor('pi', {})).toEqual([])
  })

  it('rejects allowlist tokens that are not a single safe host:port', () => {
    for (const bad of ['-lead.example', 'has space', 'a,b', 'host:0', 'host:99999', 'host:abc']) {
      expect(() => parseAllowEntry(bad, 'test')).toThrow(/invalid net-jail allowlist/)
    }
    expect(parseAllowEntry('Api.Example.COM', 'test')).toEqual({ host: 'api.example.com', port: 443, source: 'test' })
  })

  it('defaults a bare host to 443 rather than 80', () => {
    expect(canonicalAllowList(parseAllowList('a.example, b.example:8443', 'test')))
      .toEqual(['a.example:443', 'b.example:8443'])
  })
})

describe('net-jail spec resolution', () => {
  it('treats the env setting as a floor a request may raise but never lower', () => {
    expect(resolveNetJailSpec({ env: {} })).toBeNull()
    expect(resolveNetJailSpec({ execMode: 'net-jail', env: {} })?.mode).toBe('net-jail')
    // The whole point of a floor: an untrusted caller cannot opt its own run out.
    expect(resolveNetJailSpec({ execMode: 'off', env: { WORKER_NET_JAIL: '1' } })?.mode).toBe('net-jail')
    expect(resolveNetJailSpec({ execMode: 'off', env: { BRIDGE_NET_JAIL_MODE: 'net-jail' } })?.mode).toBe('net-jail')
  })

  it('reads WORKER_NET_JAIL with the same truthiness as WORKER_FS_JAIL', () => {
    for (const on of ['1', 'true', 'YES', 'on']) {
      expect(resolveNetJailSpec({ env: { WORKER_NET_JAIL: on } })).not.toBeNull()
    }
    for (const off of ['0', '', 'no', 'maybe']) {
      expect(resolveNetJailSpec({ env: { WORKER_NET_JAIL: off } })).toBeNull()
    }
  })

  it('ignores an unrecognized mode instead of confining on a typo', () => {
    expect(resolveNetJailSpec({ execMode: 'net-jai1', env: {} })).toBeNull()
  })

  it('canonicalizes a requested allowlist assertion', () => {
    expect(resolveNetJailSpec({ execMode: 'net-jail', execAllow: ['b.example', 'a.example:443', 'b.example'], env: {} }))
      .toEqual({ mode: 'net-jail', assertedAllow: ['a.example:443', 'b.example:443'] })
  })
})

describe('net-jail request gate', () => {
  const registry: NetJailRegistry = new Map([
    ['opencode', { network: 'cli-bridge-opencode-pool-netjail', allow: ['router.tangle.tools:443'] }],
  ])
  const spec = { mode: 'net-jail' as const, assertedAllow: [] }

  it('returns the enforced jail when one is in force', () => {
    expect(assertNetJailEnforced({ backend: 'opencode', executionKind: 'host', spec, registry }).allow)
      .toEqual(['router.tangle.tools:443'])
  })

  it('refuses when the backend has no provisioned jail, naming what to set', () => {
    expect(() => assertNetJailEnforced({ backend: 'claude', executionKind: 'host', spec, registry }))
      .toThrow(/has no net-jail in force.*WORKER_NET_JAIL=1 and CLAUDE_EXECUTOR=docker/s)
  })

  it('refuses a net-jail asked of an execution mode that cannot deliver it, naming the mode', () => {
    expect(() => assertNetJailEnforced({ backend: 'opencode', executionKind: 'sandbox', spec, registry }))
      .toThrow(/execution\.kind=sandbox/)
  })

  it('refuses an allowlist assertion that differs from what is enforced', () => {
    // Silently running under a WIDER allowlist than the caller demanded is the
    // failure mode; the request states a requirement, not a preference.
    expect(() => assertNetJailEnforced({
      backend: 'opencode',
      executionKind: 'host',
      spec: { mode: 'net-jail', assertedAllow: ['router.tangle.tools:443', 'github.com:443'] },
      registry,
    })).toThrow(/allowlist mismatch/)
  })

  it('accepts an assertion that matches exactly', () => {
    expect(() => assertNetJailEnforced({
      backend: 'opencode',
      executionKind: 'host',
      spec: { mode: 'net-jail', assertedAllow: ['router.tangle.tools:443'] },
      registry,
    })).not.toThrow()
  })
})

describe('net-jail startup configuration', () => {
  const dockerEnv = {
    HOME: '/home/test',
    BRIDGE_BACKENDS: 'opencode',
    OPENCODE_EXECUTOR: 'docker',
  }

  it('loads with a docker-only backend set', () => {
    const config = loadConfig({ ...dockerEnv, WORKER_NET_JAIL: '1' })
    expect(config.netJailMode).toBe('net-jail')
  })

  it('refuses to start when a backend would run on the host execution mode', () => {
    expect(() => loadConfig({ HOME: '/home/test', BRIDGE_BACKENDS: 'claude,opencode', OPENCODE_EXECUTOR: 'docker', WORKER_NET_JAIL: '1' }))
      .toThrow(/claude run[s]? on the host execution mode, which cannot enforce it/)
  })

  it('names every offending backend and the setting that fixes each', () => {
    expect(() => loadConfig({ HOME: '/home/test', BRIDGE_BACKENDS: 'claude,kimi', WORKER_NET_JAIL: '1' }))
      .toThrow(/CLAUDE_EXECUTOR=docker \/ KIMI_EXECUTOR=docker/)
  })

  it('allows remote and proxy backends alongside a net-jail, since they never spawn locally', () => {
    expect(() => loadConfig({ ...dockerEnv, BRIDGE_BACKENDS: 'opencode,passthrough', WORKER_NET_JAIL: '1' })).not.toThrow()
  })

  it('refuses a net-jail alongside an operator-pinned worker network', () => {
    expect(() => loadConfig({ ...dockerEnv, OPENCODE_DOCKER_NETWORK: 'research-services', WORKER_NET_JAIL: '1' }))
      .toThrow(/OPENCODE_DOCKER_NETWORK=research-services pins its workers to a routable network/)
  })

  it('rejects an unrecognized BRIDGE_NET_JAIL_MODE rather than defaulting it off', () => {
    expect(() => loadConfig({ ...dockerEnv, BRIDGE_NET_JAIL_MODE: 'net-jai1' }))
      .toThrow(/invalid BRIDGE_NET_JAIL_MODE/)
  })

  it('validates BRIDGE_NET_JAIL_ALLOW at startup, not at provisioning time', () => {
    expect(() => loadConfig({ ...dockerEnv, WORKER_NET_JAIL: '1', BRIDGE_NET_JAIL_ALLOW: 'good.example, bad host' }))
      .toThrow(/invalid net-jail allowlist host/)
    expect(loadConfig({ ...dockerEnv, WORKER_NET_JAIL: '1', BRIDGE_NET_JAIL_ALLOW: 'reg.example:8443' }).netJailAllow)
      .toEqual(['reg.example:8443'])
  })

  it('leaves the fs-jail settings untouched — the two are independent resources', () => {
    const config = loadConfig({ ...dockerEnv, WORKER_NET_JAIL: '1', WORKER_FS_JAIL: '1' })
    expect(config.netJailMode).toBe('net-jail')
    expect(loadConfig({ ...dockerEnv, WORKER_NET_JAIL: '1' }).jailMode).toBe('off')
  })
})

describe('net-jail relay authorization', () => {
  it('parses a host:port allowlist into per-port host sets and refuses an empty one', () => {
    const parsed = parseAllowlist('a.example:443,b.example:443,c.example:80')
    expect([...parsed.keys()].sort((a, b) => a - b)).toEqual([80, 443])
    expect([...parsed.get(443)!].sort()).toEqual(['a.example', 'b.example'])
    expect(() => parseAllowlist('')).toThrow(/allowlist is empty/)
    expect(() => parseAllowlist('nohost')).toThrow(/must be host:port/)
  })

  it('reads the SNI out of a real ClientHello and reports an incomplete record as incomplete', () => {
    const hello = clientHello('router.tangle.tools')
    expect(readSni(hello)).toBe('router.tangle.tools')
    // A short read must not be mistaken for "this connection named no host",
    // which would deny a legitimate client whose ClientHello spanned segments.
    expect(readSni(hello.subarray(0, 20))).toBeNull()
  })

  it('reads the Host header of a cleartext request and drops the port', () => {
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: Api.Example.com:8080\r\n\r\n'))).toBe('api.example.com')
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: a.example\r\n'))).toBeNull()
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nX: y\r\n\r\n'))).toBeUndefined()
  })

  it('refuses a TLS connection whose SNI is not on the allowlist, before dialing anything', async () => {
    const relay = startRelay({ allowlist: new Map([[0, new Set(['allowed.example'])]]), listenHost: '127.0.0.1' })
    const port = await relayPort(relay)
    try {
      await expect(speak(port, clientHello('github.com'))).resolves.toEqual({ closed: true, body: '' })
    } finally {
      await relay.close()
    }
  })

  it('refuses a cleartext request for a host it was not given, with a readable 403', async () => {
    const relay = startRelay({ allowlist: new Map([[0, new Set(['allowed.example'])]]), listenHost: '127.0.0.1' })
    const port = await relayPort(relay)
    try {
      const spoken = await speak(port, Buffer.from('GET / HTTP/1.1\r\nHost: github.com\r\n\r\n'))
      expect(spoken.body).toContain('403 Forbidden')
      expect(spoken.body).toContain('not on the allowlist')
    } finally {
      await relay.close()
    }
  })

  it('refuses a connection that names no target at all', async () => {
    const relay = startRelay({ allowlist: new Map([[0, new Set(['allowed.example'])]]), listenHost: '127.0.0.1' })
    const port = await relayPort(relay)
    try {
      // A raw byte stream with no SNI and no Host header: the relay must not
      // guess a destination from the address it was dialed on.
      const spoken = await speak(port, Buffer.from('\r\n\r\n'))
      expect(spoken.body).toContain('403 Forbidden')
    } finally {
      await relay.close()
    }
  })
})

/**
 * Real Docker. These are the tests that can fail in a way that means something:
 * everything above is decision logic, and decision logic has passed before on
 * controls that enforced nothing.
 */
describe('net-jail enforcement on real Docker', () => {
  const image = 'cli-bridge-cli-runtime:latest'
  const namePrefix = `cli-bridge-test-netjail-${process.pid}`
  const allow = [parseAllowEntry('router.tangle.tools:443', 'test')]
  let available = false
  let provision: Awaited<ReturnType<typeof provisionNetJail>> | null = null

  beforeAll(async () => {
    const daemon = await dockerCli(['image', 'inspect', image])
    available = daemon.code === 0
    if (!available) {
      console.warn(`[net-jail tests] SKIPPED: ${image} is not available on this host — enforcement is unproven here`)
      return
    }
    provision = await provisionNetJail({ backend: 'test', namePrefix, image, allow })
  }, 180_000)

  afterAll(async () => {
    await provision?.destroy()
  }, 60_000)

  it('denies `git clone` of a public repository', async () => {
    if (!available) return
    const out = await inJail(provision!.network, image, 'git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/hw 2>&1; echo rc=$?')
    expect(out).not.toContain('rc=0')
    expect(out).toMatch(/Could not resolve host|unable to access|Could not connect/i)
  }, 120_000)

  it('denies `curl https://github.com`', async () => {
    if (!available) return
    const out = await inJail(provision!.network, image, 'curl -sS -o /dev/null https://github.com 2>&1; echo rc=$?')
    expect(out).not.toContain('rc=0')
  }, 120_000)

  it('denies a raw-IP connection, so removing DNS from the picture changes nothing', async () => {
    if (!available) return
    const out = await inJail(provision!.network, image, 'curl -sS -k -m 10 -o /dev/null https://140.82.121.4/ 2>&1; echo rc=$?')
    expect(out).not.toContain('rc=0')
  }, 120_000)

  it('denies a host pinned to the relay by the worker itself, so DNS aliasing is not the only control', async () => {
    if (!available) return
    const relayIp = await jailAddress(provision!.network, namePrefix)
    const out = await inJail(
      provision!.network,
      image,
      `curl -sS -m 15 -o /dev/null --resolve github.com:443:${relayIp} https://github.com 2>&1; echo rc=$?`,
    )
    expect(out).not.toContain('rc=0')
  }, 120_000)

  it('gives the worker no proxy variable to unset, because there is no proxy to bypass', async () => {
    if (!available) return
    const out = await inJail(provision!.network, image, 'env | grep -ci proxy')
    expect(out.trim()).toBe('0')
  }, 120_000)

  it('allows the derived model endpoint, so a jailed agent still works', async () => {
    if (!available) return
    const out = await inJail(
      provision!.network,
      image,
      'curl -sS -m 25 -o /dev/null -w "http=%{http_code}\\n" https://router.tangle.tools/v1/models 2>&1',
    )
    // 401 is a pass: the request reached the real origin and was answered by it.
    expect(out).toMatch(/http=(200|401|403)/)
  }, 120_000)

  it('fails provisioning when the network is not actually isolating — the guard is calibrated', async () => {
    if (!available) return
    // Same code path, one primitive removed. If this passes provisioning, the
    // verification step is decoration and every green run above means nothing.
    const leakyCli: DockerCli = (args, opts) => dockerCli(args.filter((a) => a !== '--internal'), opts)
    await expect(provisionNetJail({
      backend: 'test-leaky',
      namePrefix: `${namePrefix}-leaky`,
      image,
      allow,
      cli: leakyCli,
    })).rejects.toThrow(NetJailProvisionError)
  }, 180_000)

  it('refuses to provision a jail with nothing on its allowlist', async () => {
    await expect(provisionNetJail({ backend: 'test-empty', namePrefix: `${namePrefix}-empty`, image, allow: [] }))
      .rejects.toThrow(/no model endpoint could be derived/)
  }, 60_000)
})

/** Run a shell line inside a throwaway container on the jailed network. */
async function inJail(network: string, image: string, script: string): Promise<string> {
  const result = await dockerCli(
    ['run', '--rm', '--network', network, '--entrypoint', 'sh', image, '-c', script],
    { timeoutMs: 90_000 },
  )
  return `${result.stdout}${result.stderr}`
}

/** The relay's address on the jailed network, as a worker would see it. */
async function jailAddress(network: string, namePrefix: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, `${namePrefix}-netjail-relay`,
  ])
  return stdout.trim()
}

/** Port the relay's single ephemeral listener ended up on. */
async function relayPort(relay: { servers?: unknown }): Promise<number> {
  const servers = (relay as { servers?: Array<{ address(): { port: number } | null }> }).servers
  const server = servers?.[0]
  if (!server) throw new Error('relay exposed no server to address')
  for (let i = 0; i < 200; i++) {
    const address = server.address()
    if (address && address.port) return address.port
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('relay never bound a port')
}

/** Send bytes to the relay and collect whatever it says before closing. */
function speak(port: number, payload: Buffer): Promise<{ closed: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload))
    const chunks: Buffer[] = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('close', () => resolve({ closed: true, body: Buffer.concat(chunks).toString('utf8') }))
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // A refused connection reads as ECONNRESET on some kernels; that is the
      // same decision as a clean close, not a test failure.
      if (error.code === 'ECONNRESET') return resolve({ closed: true, body: Buffer.concat(chunks).toString('utf8') })
      reject(error)
    })
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('relay did not answer')) })
  })
}

/** Minimal but structurally real TLS 1.2 ClientHello carrying one SNI entry. */
function clientHello(serverName: string): Buffer {
  const name = Buffer.from(serverName, 'utf8')
  const serverNameList = Buffer.concat([Buffer.from([0x00]), uint16(name.length), name])
  const sniExtension = Buffer.concat([
    uint16(0x0000), uint16(serverNameList.length + 2), uint16(serverNameList.length), serverNameList,
  ])
  const body = Buffer.concat([
    uint16(0x0303),
    Buffer.alloc(32),
    Buffer.from([0x00]), // empty session id
    uint16(2), uint16(0x1301), // one cipher suite
    Buffer.from([0x01, 0x00]), // one compression method: null
    uint16(sniExtension.length), sniExtension,
  ])
  const handshake = Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ])
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), uint16(handshake.length), handshake])
}

function uint16(value: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(value)
  return buf
}
