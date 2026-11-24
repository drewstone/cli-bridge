/**
 * A host behind a TLS-inspecting egress (a Tangle sandbox, a corporate proxy) trusts the inspecting
 * authority through NODE_EXTRA_CA_CERTS / SSL_CERT_FILE and reaches the network through its proxy.
 * Every harness the Bridge starts unconfined must inherit both, or its first provider call fails with
 * SELF_SIGNED_CERT_IN_CHAIN; measured on 2026-11-24 for Claude Code inside the agent-container box.
 * A jailed harness keeps only its jail's egress settings.
 *
 * Real processes, a real TLS endpoint signed by a private authority, the maintained host spawner and
 * the Claude backend; the runner speaks Claude's stream-json and calls no model.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner } from '../src/executors/types.js'
import { hostRequestJail } from '../src/jail/host-request.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const BODY = 'reached-through-the-inspecting-authority'
const PROXY = 'http://egress.invalid:3128'

// One HTTPS call to the endpoint, then a stream-json answer naming what the child saw.
const runner = (url: string) => `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.330 (Claude Code)'); process.exit(0) }
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const session = '00000000-0000-4000-8000-0000000c0de5'
emit({ type: 'system', subtype: 'init', session_id: session })
fetch(${JSON.stringify(url)}).then((r) => r.text(), (e) => 'fetch failed: ' + (e.cause?.code ?? e.message)).then((body) => {
  const text = JSON.stringify({ body, proxy: process.env.HTTPS_PROXY ?? null, ca: process.env.NODE_EXTRA_CA_CERTS ?? null,
    insecure: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null })
  emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', session_id: session, result: text, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`

const opensslAvailable = spawnSync('openssl', ['version']).status === 0
const spawner: Spawner = async (bin, args, opts) => ({ ...(await hostSpawner(bin, args, opts)), scope: 'host-transport-proof.scope' })

describe.skipIf(!opensslAvailable)('a harness started by the Bridge reaches the network the way its host does', () => {
  let root: string, server: Server, url: string, ca: string
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'host-transport-env-')))
    ca = join(root, 'authority.pem')
    const key = join(root, 'authority.key')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
    server = createServer({ key: await readFile(key), cert: await readFile(ca) }, (_req, res) => res.end(BODY))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `https://localhost:${(server.address() as { port: number }).port}/`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  afterEach(() => { vi.unstubAllEnvs() })

  const turn = async (name: string, jailed: boolean) => {
    const workspace = join(root, name)
    await mkdir(workspace)
    const bin = join(workspace, 'claude.cjs')
    await writeFile(bin, runner(url), { mode: 0o700 })
    const request: ChatRequest = {
      cwd: workspace,
      session_id: `host-transport-${name}`,
      mode: 'byob',
      model: 'claude-code/anthropic/haiku',
      messages: [{ role: 'user', content: 'call the endpoint' }],
    }
    if (jailed) {
      request.jailSpec = hostRequestJail(request, 'claude-code', { ...process.env, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none' })
      expect(request.jailSpec, 'BRIDGE_JAIL_MODE=fs-jail resolves a host jail').toBeTruthy()
    }
    const backend = new ClaudeBackend({ bin, harness: 'claude-code', timeoutMs: 30_000, spawner })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(request, null, new AbortController().signal)) deltas.push(delta)
    const text = deltas.map((delta) => delta.content ?? '').join('')
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, string | null>
  }

  it('an unconfined harness trusts the authority the host trusts and sees the host proxy', async () => {
    vi.stubEnv('NODE_EXTRA_CA_CERTS', ca)
    vi.stubEnv('HTTPS_PROXY', PROXY)
    vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const seen = await turn('unconfined', false)
    expect(seen.body).toBe(BODY)
    expect(seen.ca).toBe(ca)
    expect(seen.proxy).toBe(PROXY)
    // Turning verification off on the host never reaches a harness.
    expect(seen.insecure).toBeNull()
  })

  it('without the host authority the same call fails as it did in the box', async () => {
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', undefined)
    const seen = await turn('untrusted', false)
    expect(seen.body).toMatch(/^fetch failed: .*(SELF_SIGNED|UNABLE_TO_VERIFY|CERT)/u)
  })

  it.skipIf(!new LinuxBwrapJail().isAvailable())('a jailed harness keeps its jail egress, not the host proxy', async () => {
    vi.stubEnv('NODE_EXTRA_CA_CERTS', ca)
    vi.stubEnv('HTTPS_PROXY', PROXY)
    const seen = await turn('jailed', true)
    expect(seen.proxy).toBeNull()
    expect(seen.ca).toBeNull()
    expect(seen.body).toMatch(/^fetch failed/u)
  })
})
