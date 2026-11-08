/**
 * Jail egress proofs through the public boundary: POST /v1/chat/completions,
 * then the host spawner's bwrap jail. Linux only.
 *
 *   none    a replay reaches neither GitHub nor the Router.
 *   router  one Router model turn completes (TANGLE_ROUTER_KEY); npm, Discord,
 *           GitHub and SNI fronting through the Router's address all fail.
 *   relay   a proxySecrets GitHub binding: the jail holds only a placeholder,
 *           clones and pushes a branch to PROOF_REPO through iron-proxy, and a
 *           PR-create call fails; npm and Discord fail; a hash-only scan finds
 *           the real secret nowhere under the jail root, its environ or logs.
 *           CLAUDE_TURN=1 adds one real claude turn under relay.
 *
 * BRIDGE_IRON_PROXY_BIN is required. BRIDGE_PROXY_SECRET_COMMAND defaults to a
 * stand-in that returns a fake token: the push then fails at GitHub's auth
 * check, which still proves placeholder, CA and proxy path end to end. With
 * scripts/proxy-secret-github.mjs and TANGLE_API_KEY the push succeeds.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'
import { hostSpawner } from '../src/executors/host.js'
import { resolveJailSpec } from '../src/jail/resolve-spec.js'
import type { Backend } from '../src/backends/types.js'

assert.equal(process.platform, 'linux')
assert.ok(process.env.BRIDGE_IRON_PROXY_BIN, 'BRIDGE_IRON_PROXY_BIN is unset')
const routerKey = process.env.TANGLE_ROUTER_KEY ?? ''
const repo = process.env.PROOF_REPO ?? 'drewstone/is-promise'
const branch = `jail-egress-proof-${Date.now()}`
const scratch = await mkdtemp(join(tmpdir(), 'verify-egress-'))
const redact = (value: string) => (routerKey ? value.split(routerKey).join('[redacted]') : value)

// The secret command runs host-side; this wrapper records only the secret's hash for the scan.
const hashFile = join(scratch, 'secret.sha256')
const standIn = join(scratch, 'stand-in.mjs')
await writeFile(standIn, `const v=process.argv[2];if(v==='mint')process.stdout.write(JSON.stringify({secret:'ghs_'+'${randomBytes(18).toString('hex')}',expiresAt:new Date(Date.now()+6e5).toISOString()}))\n`)
const inner = process.env.BRIDGE_PROXY_SECRET_COMMAND ?? `${process.execPath} ${standIn}`
const wrapper = join(scratch, 'secret-command')
await writeFile(wrapper, `#!/bin/sh
input=$(cat)
out=$(printf '%s' "$input" | ${inner} "$1") || exit $?
[ "$1" = mint ] && printf '%s' "$out" | ${process.execPath} -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(JSON.parse(s).secret).digest("hex")))' > ${hashFile}
printf '%s' "$out"
`)
await chmod(wrapper, 0o700)

const capped = (ask: string, operator?: string) => resolveJailSpec({ execMode: 'fs-jail', execNetwork: ask, cwd: '/tmp', env: operator ? { BRIDGE_JAIL_NETWORK: operator } : {} })?.network
assert.equal(capped('relay', 'none'), 'none', 'a none operator setting must cap a relay request')
assert.equal(capped('relay'), 'router', 'without an operator setting, relay is capped at router')

/** Runs inside the jail: each check is a command whose exit status and output tail come back. */
const probe = `
const { spawnSync } = require('node:child_process')
const checks = JSON.parse(process.argv[1])
const out = {}
for (const [name, cmd] of Object.entries(checks)) {
  const run = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 60000 })
  out[name] = { status: run.status, tail: ((run.stdout || '') + (run.stderr || '')).slice(-1500) }
}
out.environ = require('node:fs').readFileSync('/proc/self/environ', 'utf8')
console.log(JSON.stringify(out))
`
const curl = (url: string, extra = '') => `curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 ${extra} ${url}`
const fronting = (name: string) =>
  `echo | timeout 10 openssl s_client -proxy 127.0.0.1:3128 -connect router.tangle.tools:443 -servername ${name} 2>&1 | grep -q 'subject=' && exit 0 || exit 1`
const blocked = { npm: curl('https://registry.npmjs.org/'), discord: curl('https://discord.com/'), github: curl('https://github.com/') }
// The key reaches curl on stdin, never argv.
const routerTurn = `printf 'authorization: Bearer %s' "$TANGLE_ROUTER_KEY" | curl -sS --max-time 40 -o /dev/null -w '%{http_code}' https://router.tangle.tools/v1/chat/completions -H @- -H 'content-type: application/json' -d '{"model":"zai/glm-5.3","messages":[{"role":"user","content":"Reply with the single word pong."}],"max_tokens":32}'`

type Result = Record<string, { status: number | null; tail: string }> & { environ: string }

async function scenario(network: 'none' | 'router' | 'relay', checks: Record<string, string>, profile?: unknown, mode: 'fs-jail' | 'write-jail' = 'fs-jail') {
  const directory = await mkdtemp(join(tmpdir(), 'verify-egress-run-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const config = loadConfig({
    BRIDGE_BACKENDS: '', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_TRACE: 'off',
    BRIDGE_JAIL_MODE: mode, BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: network,
    BRIDGE_IRON_PROXY_BIN: process.env.BRIDGE_IRON_PROXY_BIN, BRIDGE_PROXY_SECRET_COMMAND: wrapper,
  })
  const built = await buildApp(config)
  let stderr = ''
  const backend: Backend = {
    name: 'net-probe', matches: (model) => model === 'net-probe',
    health: async () => ({ name: 'net-probe', state: 'ready' }),
    async *chat(request, _session, signal) {
      const env = { ...process.env, TANGLE_ROUTER_KEY: network === 'router' ? routerKey : '' }
      const spawned = await hostSpawner(process.execPath, ['-e', probe, JSON.stringify(checks)], {
        cwd: workspace, env, jail: request.jailSpec ?? undefined, signal,
      })
      let stdout = ''
      spawned.child.stdout!.setEncoding('utf8').on('data', (text) => { stdout += text })
      spawned.child.stderr!.setEncoding('utf8').on('data', (text) => { stderr += text })
      try {
        const [code] = await once(spawned.child, 'close')
        assert.equal(code, 0, redact(stderr).slice(-700))
        yield { content: stdout, finish_reason: 'stop' }
      } finally { spawned.release() }
    },
  }
  built.registry.register(backend)
  const server = serve({ fetch: built.app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'net-probe', messages: [{ role: 'user', content: 'egress probe' }], cwd: workspace,
        execution: { kind: 'host', jail: { mode, network } },
        ...(profile ? { agent_profile: profile } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }> }
    assert.equal(response.status, 200, redact(JSON.stringify(body)))
    const result = JSON.parse(body.choices![0]!.message.content) as Result
    return { result, directory, logs: stderr }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    for (const close of built.extras.shutdownHooks) await close()
    built.sessions.close()
  }
}

const failed = (r: { status: number | null; tail: string }) => r.status !== 0 || !/^2\d\d$/u.test(r.tail.trim())

// none: a replay reaches nothing.
const none = await scenario('none', { github: blocked.github, router: curl('https://router.tangle.tools/') })
for (const name of ['github', 'router']) assert.ok(failed(none.result[name]!), `none ${name}: ${none.result[name]!.tail}`)

// A write-jail sees the host root, but never a sibling spawn's relay socket directory.
await mkdir(join(tmpdir(), 'cbe'), { recursive: true, mode: 0o700 })
const sibling = await mkdtemp(join(tmpdir(), 'cbe', 's-'))
const writeNone = await scenario('none', { siblings: `test -z "$(ls -A ${join(tmpdir(), 'cbe')})"` }, undefined, 'write-jail')
assert.equal(writeNone.result.siblings!.status, 0, 'a write-jail can list another spawn\'s egress directory')
await rm(sibling, { recursive: true, force: true })

// router: one model turn; everything else, including SNI fronting on the Router's address, fails.
const router = await scenario('router', {
  ...blocked, frontNpm: fronting('registry.npmjs.org'), frontDiscord: fronting('discord.com'),
  ...(routerKey ? { turn: routerTurn } : {}),
})
for (const name of ['npm', 'discord', 'github']) assert.ok(failed(router.result[name]!), `router ${name}: ${router.result[name]!.tail}`)
for (const name of ['frontNpm', 'frontDiscord']) assert.notEqual(router.result[name]!.status, 0, `router ${name} completed a TLS handshake`)
if (routerKey) assert.equal(router.result.turn!.tail.trim(), '200', `router turn: ${redact(router.result.turn!.tail)}`)

// relay: GitHub only through iron-proxy with a placeholder credential.
const profile = {
  name: 'egress-proof', harness: 'opencode',
  proxySecrets: [{
    hosts: ['github.com', 'api.github.com'], envName: 'GITHUB_TOKEN',
    secretRef: { key: `github:${repo}`, kind: 'secret-ref' },
    presentation: { type: 'basic', username: 'x-access-token' }, ttlSeconds: 900,
  }],
}
const relay = await scenario('relay', {
  ...blocked,
  placeholder: `case "$GITHUB_TOKEN" in proxy-github-token.*) exit 0;; *) exit 1;; esac`,
  clone: `git clone -q --depth 1 https://github.com/${repo} /tmp/r`,
  push: `cd /tmp/r && git commit -q --allow-empty -m 'jail egress proof' && git push -q origin HEAD:refs/heads/${branch}`,
  prCreate: curl(`https://api.github.com/repos/${repo}/pulls`, `-u x-access-token:$GITHUB_TOKEN -X POST -d '{"title":"x","head":"${branch}","base":"master"}'`),
}, profile)
const r = relay.result
assert.equal(r.placeholder!.status, 0, 'GITHUB_TOKEN inside the jail is not the placeholder')
for (const name of ['npm', 'discord']) assert.ok(failed(r[name]!), `relay ${name}: ${r[name]!.tail}`)
assert.equal(r.clone!.status, 0, `relay clone through iron-proxy: ${r.clone!.tail}`)
assert.ok(failed(r.prCreate!), `relay PR create must fail: ${r.prCreate!.tail}`)
const pushed = r.push!.status === 0
if (!process.env.BRIDGE_PROXY_SECRET_COMMAND) {
  assert.match(r.push!.tail, /Authentication failed|Invalid username or token|403|401/u, `stand-in push must fail at GitHub auth, not TLS or policy: ${r.push!.tail}`)
} else {
  assert.ok(pushed, `relay push with a minted token: ${r.push!.tail}`)
}

// Hash-only scan: no token-shaped string under the jail root, workspace, environ or logs hashes to the secret.
const secretHash = (await readFile(hashFile, 'utf8')).trim()
assert.match(secretHash, /^[0-9a-f]{64}$/u)
const texts: string[] = [r.environ, relay.logs]
async function collect(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile()) texts.push(await readFile(path, 'latin1').catch(() => ''))
  }
}
await collect(relay.directory)
const hits = texts.flatMap((text) => text.match(/[A-Za-z0-9_\-.]{20,}/gu) ?? [])
  .filter((token) => createHash('sha256').update(token).digest('hex') === secretHash)
assert.equal(hits.length, 0, 'the real secret appears under the jail root, its environ or logs')

for (const dir of [none.directory, writeNone.directory, router.directory, relay.directory, scratch]) await rm(dir, { recursive: true, force: true })
console.log('PASS jail egress: none reaches nothing; router fails closed (incl. SNI fronting); relay pushes through iron-proxy with a placeholder and cannot create a PR; secret hash absent')
console.log(JSON.stringify({
  router: { turn: routerKey ? 'completed' : 'skipped (no TANGLE_ROUTER_KEY)', npm: router.result.npm!.tail, discord: router.result.discord!.tail },
  relay: { push: pushed ? `pushed ${branch}` : r.push!.tail.trim().slice(-120), prCreate: r.prCreate!.tail, scannedTexts: texts.length },
}))
