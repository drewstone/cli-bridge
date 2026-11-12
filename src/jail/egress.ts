/**
 * Per-spawn egress for the Linux jail. Every jailed spawn runs in a fresh
 * network namespace; its policy decides what, if anything, leaves it:
 *
 *   none    no route at all. Replays and evals: a candidate cannot fetch the
 *           published fix.
 *   router  model calls only: the egress relay admits just the declared
 *           router hosts.
 *   relay   the harness's own vendor hosts (a subscription CLI reaching its
 *           provider), the Router, and `BRIDGE_JAIL_RELAY_ALLOW` by SNI
 *           pass-through, plus the profile's `proxySecrets` hosts, which go
 *           through a per-spawn iron-proxy that swaps the placeholder in the
 *           jail's env for the real credential. The allow list's owner for a
 *           delivery graph is factory `graphs/delivery.graph.yaml`'s egress
 *           anchor (de5cc83a), including release-assets.githubusercontent.com.
 *           Every other host is refused.
 *
 * Secrets are minted per spawn by the operator's `BRIDGE_PROXY_SECRET_COMMAND`
 * and revoked when the spawn ends. The real value exists only in the bridge's
 * memory and the iron-proxy process environment. The jail sees the
 * placeholder, the CA certificate and the relay socket; the CA key, proxy
 * config and secret never enter it.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProxySecretBinding } from '@tangle-network/agent-interface'
import { startEgressRelay, type EgressRelay } from './egress-relay.js'
export { registerTrustedHostService, claimTrustedHostService } from './egress-relay.js'
export type { TrustedHostServiceOwner, TrustedHostServiceRegistration } from './egress-relay.js'
import type { JailSpec } from './types.js'

export type JailNetwork = 'none' | 'router' | 'relay'
/** Openness order; an operator floor caps a request at its own rank. */
export const JAIL_NETWORK_RANK: Record<JailNetwork, number> = { none: 0, router: 1, relay: 2 }
/** The Tangle Router: the only origin a `router` spawn reaches. */
const ROUTER_HOSTS: readonly string[] = ['router.tangle.tools']

/**
 * Hosts each subscription harness needs for a model turn and its token refresh,
 * measured by running one turn through the relay. Telemetry and MCP servers a
 * seat's own config names are refused. A harness absent here reaches only the
 * Router and its proxySecrets hosts under `relay`.
 */
const ANTHROPIC_HOSTS = ['api.anthropic.com', 'platform.claude.com', 'console.anthropic.com']
const VENDOR_HOSTS: Record<string, readonly string[]> = {
  'claude-code': ANTHROPIC_HOSTS,
  claude: ANTHROPIC_HOSTS,
  codex: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'],
  opencode: ['opencode.ai', 'models.opencode.ai'],
}

export function vendorHostsFor(backendName: string): string[] {
  return [...(VENDOR_HOSTS[backendName] ?? [])]
}

interface JailEgressIntercept {
  binding: ProxySecretBinding
  /** The value the jail sees in `binding.envName`. */
  placeholder: string
  /** The real credential, held only by iron-proxy. */
  secret: string
  expiresAt: Date
}

export interface PreparedEgress {
  /** bwrap args: the sibling-egress mask, then read-only binds for this spawn's shim and relay socket. */
  bwrapArgs: string[]
  /** Environment set inside the jail. */
  env: Record<string, string>
  /** argv placed before the CLI: the in-jail shim, when any egress is allowed. */
  prefix: string[]
  cleanup(): Promise<void>
}

/** Loopback port the shim listens on inside the jail's private namespace. */
const SHIM_PORT = '3128'
/** A unix socket path is limited to 108 bytes on Linux. */
const MAX_SOCKET_PATH = 100
const SYSTEM_CA_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem']
const UPSTREAM_DENY_CIDRS = ['169.254.0.0/16', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10']
const EGRESS_SHIM_PATH = fileURLToPath(new URL('./egress-shim.mjs', import.meta.url))

/** A placeholder in agent-container's `<base>.<salt>` shape with a 96-bit random salt. */
function proxySecretPlaceholder(envName: string): string {
  return `proxy-${envName.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}.${randomBytes(12).toString('base64url')}`
}

type EgressSpec = Pick<JailSpec, 'network' | 'vendorHosts' | 'passThroughHosts' | 'proxySecrets' | 'proxySecretCommand' | 'ironProxyBin' | 'trustedHostServices'>

/** Hosts the relay may splice. Router mode stays the Router only; pass-through is relay-only. */
export function relayAllowHosts(spec: EgressSpec): readonly string[] {
  const network = spec.network ?? 'none'
  if (network === 'none') return []
  if (network === 'router') return ROUTER_HOSTS
  const allow: string[] = []
  for (const host of [...ROUTER_HOSTS, ...(spec.vendorHosts ?? []), ...(spec.passThroughHosts ?? [])]) {
    if (!allow.includes(host)) allow.push(host)
  }
  return allow
}

/**
 * Every spawn's relay socket and proxy state live under one parent that each
 * jail covers with a fresh tmpfs before binding back only its own directory.
 * A unix socket ignores network namespaces, so without this mask a write-jail
 * (host root visible) could connect to a sibling spawn's relay and use its
 * credential. The parent must be our own 0700 directory: in a shared /tmp,
 * another account could otherwise pre-create it and swap a spawn's socket.
 */
const EGRESS_PARENT = join(tmpdir(), `cbe-${process.getuid?.() ?? 0}`)

async function egressParent(): Promise<string> {
  await mkdir(EGRESS_PARENT, { recursive: true, mode: 0o700 })
  const stat = await lstat(EGRESS_PARENT)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${EGRESS_PARENT} must be a directory owned by this user with mode 0700`)
  }
  return EGRESS_PARENT
}

export async function prepareEgress(spec: EgressSpec): Promise<PreparedEgress> {
  const network = spec.network ?? 'none'
  const bindings = spec.proxySecrets ?? []
  if (bindings.length && network !== 'relay') throw new Error('proxySecrets require execution.jail.network relay')
  // Created on every path: a write-jail cannot create the mask's mountpoint on the read-only host root.
  const mask = ['--tmpfs', await egressParent()]
  if (network === 'none' && !spec.trustedHostServices?.length) return { bwrapArgs: mask, env: {}, prefix: [], cleanup: async () => {} }

  const shared = await mkdtemp(join(EGRESS_PARENT, 's-'))
  const socketPath = join(shared, 's')
  if (socketPath.length > MAX_SOCKET_PATH) {
    await rm(shared, { recursive: true, force: true })
    throw new Error(`egress socket path exceeds ${MAX_SOCKET_PATH} bytes; set TMPDIR to a shorter directory`)
  }
  let proxy: Awaited<ReturnType<typeof startIronProxy>> | undefined
  let relay: EgressRelay | undefined
  const intercepts: JailEgressIntercept[] = []
  const cleanup = async () => {
    await relay?.close()
    if (proxy) { proxy.child.kill('SIGTERM'); await rm(proxy.dir, { recursive: true, force: true }) }
    await rm(shared, { recursive: true, force: true })
    // Revoke after the proxy is gone, so no in-flight request can still use the value.
    await Promise.allSettled(intercepts.map(({ binding, secret }) =>
      runSecretCommand(spec.proxySecretCommand!, 'revoke', { key: binding.secretRef.key, secret })))
  }
  try {
    const env: Record<string, string> = network === 'none' ? {} : proxyEnv()
    let tunnel: { host: string; port: number } | undefined
    if (bindings.length) {
      if (!spec.proxySecretCommand) throw new Error('proxySecrets require BRIDGE_PROXY_SECRET_COMMAND')
      if (!spec.ironProxyBin) throw new Error('proxySecrets require BRIDGE_IRON_PROXY_BIN')
      for (const binding of bindings) intercepts.push(await mintIntercept(spec.proxySecretCommand, binding))
      proxy = await startIronProxy(spec.ironProxyBin, intercepts)
      tunnel = proxy.tunnel
      Object.assign(env, await trustEnv(shared, proxy.caCert), credentialEnv(intercepts))
    }
    relay = await startEgressRelay({
      socketPath,
      allow: relayAllowHosts(spec),
      trustedHostServices: spec.trustedHostServices,
      ...(tunnel ? { intercept: { hosts: intercepts.flatMap((i) => i.binding.hosts), tunnel } } : {}),
    })
    return {
      bwrapArgs: [...mask, '--ro-bind', shared, shared, '--ro-bind', EGRESS_SHIM_PATH, EGRESS_SHIM_PATH],
      env,
      prefix: [process.execPath, EGRESS_SHIM_PATH, socketPath, SHIM_PORT],
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function mintIntercept(command: string, binding: ProxySecretBinding): Promise<JailEgressIntercept> {
  const { key } = binding.secretRef
  const minted = JSON.parse(await runSecretCommand(command, 'mint', {
    key, hosts: binding.hosts, methods: binding.methods, paths: binding.paths, ttlSeconds: binding.ttlSeconds,
  })) as { secret?: unknown; expiresAt?: unknown }
  const expiresAt = new Date(String(minted.expiresAt))
  if (typeof minted.secret !== 'string' || !minted.secret || Number.isNaN(expiresAt.getTime())) {
    throw new Error(`BRIDGE_PROXY_SECRET_COMMAND mint ${key} must print {"secret","expiresAt"}`)
  }
  return { binding, placeholder: proxySecretPlaceholder(binding.envName), secret: minted.secret, expiresAt }
}

/**
 * `<command> mint|revoke` with one JSON object on stdin. Its output carries a
 * credential, so neither stdout nor stderr is ever logged or put in an error.
 */
function runSecretCommand(command: string, verb: 'mint' | 'revoke', input: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [verb], { timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`BRIDGE_PROXY_SECRET_COMMAND ${verb} failed (exit ${error.code ?? 'signal'})`))
      else resolve(stdout)
    })
    child.stdin!.end(JSON.stringify(input))
  })
}

function proxyEnv(): Record<string, string> {
  const url = `http://127.0.0.1:${SHIM_PORT}`
  return {
    HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url, all_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    NODE_USE_ENV_PROXY: '1',
  }
}

/** Trust the iron-proxy CA alongside the system roots; pass-through hosts keep their real certificates. */
async function trustEnv(shared: string, caCert: string): Promise<Record<string, string>> {
  let system = ''
  for (const path of SYSTEM_CA_BUNDLES) {
    system = await readFile(path, 'utf8').catch(() => '')
    if (system) break
  }
  if (!system) throw new Error('no system CA bundle found to extend with the egress proxy CA')
  const ca = join(shared, 'ca.crt'), bundle = join(shared, 'ca-bundle.crt')
  await writeFile(ca, caCert, { mode: 0o644 })
  await writeFile(bundle, `${system.trimEnd()}\n${caCert}`, { mode: 0o644 })
  return { SSL_CERT_FILE: bundle, CURL_CA_BUNDLE: bundle, REQUESTS_CA_BUNDLE: bundle, GIT_SSL_CAINFO: bundle, NODE_EXTRA_CA_CERTS: ca }
}

/** Placeholder env, plus a git credential helper per Basic host that answers with the placeholder. */
function credentialEnv(intercepts: readonly JailEgressIntercept[]): Record<string, string> {
  const env: Record<string, string> = {}
  const git: Array<[string, string]> = []
  for (const { binding, placeholder } of intercepts) {
    env[binding.envName] = placeholder
    if (binding.presentation.type !== 'basic') continue
    for (const host of binding.hosts) {
      // The empty value clears inherited helpers, so only the placeholder is ever offered.
      git.push([`credential.https://${host}.helper`, ''])
      git.push([`credential.https://${host}.helper`, `!f() { echo username=${binding.presentation.username}; echo "password=$${binding.envName}"; }; f`])
    }
  }
  if (git.length) {
    env.GIT_CONFIG_COUNT = String(git.length)
    git.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value })
  }
  return env
}

/** One iron-proxy per spawn, in #17768's canonical secret shape, listening on an ephemeral loopback port. */
async function startIronProxy(
  bin: string,
  intercepts: readonly JailEgressIntercept[],
): Promise<{ child: ChildProcess; dir: string; tunnel: { host: string; port: number }; caCert: string }> {
  const dir = await mkdtemp(join(EGRESS_PARENT, 'p-'))
  await chmod(dir, 0o700)
  try {
    await run(bin, ['generate-ca', '-outdir', dir, '-alg', 'ed25519'])
    const secrets = intercepts.map(({ binding, placeholder, expiresAt }, i) => ({
      source: { type: 'env', var: `JAIL_EGRESS_SECRET_${i}` },
      proxy_value: placeholder,
      presentation: binding.presentation,
      expires_at: expiresAt.toISOString(),
      require: true,
      rules: binding.hosts.map((host) => ({
        host,
        ...(binding.methods ? { methods: binding.methods } : {}),
        ...(binding.paths ? { paths: binding.paths } : {}),
      })),
    }))
    const config = {
      dns: { enabled: false },
      proxy: { http_listen: '127.0.0.1:0', https_listen: '127.0.0.1:0', tunnel_listen: '127.0.0.1:0', upstream_deny_cidrs: UPSTREAM_DENY_CIDRS },
      metrics: { listen: '127.0.0.1:0' },
      tls: { mode: 'mitm', ca_cert: join(dir, 'ca.crt'), ca_key: join(dir, 'ca.key') },
      transforms: [
        { name: 'allowlist', config: { domains: [...new Set(intercepts.flatMap((i) => i.binding.hosts))] } },
        { name: 'secrets', config: { secrets } },
      ],
    }
    // JSON is valid YAML, so no YAML writer is needed.
    await writeFile(join(dir, 'proxy.yaml'), JSON.stringify(config), { mode: 0o600 })
    const secretEnv = Object.fromEntries(intercepts.map(({ secret }, i) => [`JAIL_EGRESS_SECRET_${i}`, secret]))
    const child = spawn(bin, ['-config', join(dir, 'proxy.yaml')], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...secretEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const tunnel = await tunnelAddress(child)
    return { child, dir, tunnel, caCert: await readFile(join(dir, 'ca.crt'), 'utf8') }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/** iron-proxy logs one JSON line per listener; the tunnel line carries the bound port. */
function tunnelAddress(child: ChildProcess): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('iron-proxy did not start within 10s')) }, 10_000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`iron-proxy exited (${code}) before listening`)) })
    child.stderr!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        const match = /"msg":"tunnel proxy starting","addr":"(127\.0\.0\.1):(\d+)"/u.exec(line)
        if (match) {
          clearTimeout(timer)
          child.stderr!.resume()
          return resolve({ host: match[1]!, port: Number(match[2]) })
        }
      }
    })
  })
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${args[0]} exited ${code}`))))
  })
}
