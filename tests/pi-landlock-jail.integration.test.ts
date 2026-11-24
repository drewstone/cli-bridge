/**
 * Pi under the Landlock fs-jail, through the real Bridge listener and a real Pi. The synthetic model asks Pi's Bash
 * tool to probe what an escaped tool would want: a host secret, the Bridge's own Pi configuration, a sibling
 * session's file, the Bridge's `/proc` environment and the Bridge's HTTP port. The test process reads and reaches
 * each of them (the unconfined control); Pi's Bash reaches none, and the turn still completes through the run's
 * scoped loopback transport, which alone holds the upstream key.
 *
 * Needs Linux with Landlock and python3, and a real Pi: PI_BIN, else `pi` on PATH (a gate installs
 * @earendil-works/pi-coding-agent). CLI_BRIDGE_REQUIRE_LANDLOCK=1 makes a missing prerequisite a failure.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const launcher = fileURLToPath(new URL('../src/jail/landlock-exec.py', import.meta.url))
const landlock = spawnSync('python3', ['-I', '-S', launcher, '--probe'], { encoding: 'utf8' })
const piBin = process.env.PI_BIN?.trim() || (() => {
  try { return execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()
const enabled = process.platform === 'linux' && landlock.status === 0 && Boolean(piBin)
const BEARER = `pi-landlock-${randomBytes(8).toString('hex')}`
const nonce = (label: string) => `${label}-${randomBytes(6).toString('hex')}`
const UPSTREAM_KEY = nonce('upstream-key')
const HOST_SECRET = nonce('host-secret')
const SIBLING_SECRET = nonce('sibling-secret')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** An OpenAI-compatible model: the first call asks Pi's bash tool to run `probe`, the second replies with its result. */
function syntheticModel(probe: () => string, bodies: string[], authorizations: string[]): Server {
  return createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    bodies.push(body)
    authorizations.push(req.headers.authorization ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) => res.write(`data: ${JSON.stringify({
      id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'probe-model',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`)
    if (bodies.length === 1) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: probe() }) } }] }, null)
      send({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
    } else {
      send({ role: 'assistant', content: 'landlock-pi-ok' }, null)
      send({}, 'stop', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
    }
    res.end('data: [DONE]\n\n')
  })
}

const reaches = (port: number) => new Promise<string>((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve('connected') })
  socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
})

describe.skipIf(!enabled)(`Pi under the Landlock fs-jail (ABI ${landlock.stdout.trim() || 'unavailable'}, ${piBin ?? 'no pi'})`, () => {
  const saved = { ...process.env }
  const bodies: string[] = [], authorizations: string[] = []
  let base: string, model: Server, bridge: BridgeServer
  let targets: Record<string, string>
  let probe = ''

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'pi-landlock-')))
    const agentDir = join(base, 'pi-agent'), tools = join(base, 'tools'), secrets = join(base, 'host')
    const sibling = join(agentDir, 'sessions', 'cli-bridge', 'sibling-session')
    for (const dir of [agentDir, tools, secrets, sibling]) await mkdir(dir, { recursive: true })
    targets = {
      HOST_SECRET: join(secrets, 'credential.txt'),
      SOURCE_MODELS: join(agentDir, 'models.json'),
      SIBLING_SESSION: join(sibling, 'private.jsonl'),
      BRIDGE_ENVIRON: `/proc/${process.pid}/environ`,
    }
    await writeFile(targets.HOST_SECRET!, HOST_SECRET)
    await writeFile(targets.SIBLING_SESSION!, SIBLING_SECRET)
    // An unusable bubblewrap: the backend in force is the Landlock one the operator selected.
    await writeFile(join(tools, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    process.env.PATH = `${tools}${delimiter}${saved.PATH}`

    model = syntheticModel(() => probe, bodies, authorizations)
    model.listen(0, '127.0.0.1')
    await once(model, 'listening')
    const port = (model.address() as { port: number }).port
    // The Bridge's own Pi configuration: the key is named, and lives only in the Bridge's environment.
    process.env.PI_LANDLOCK_UPSTREAM_KEY = UPSTREAM_KEY
    process.env.PI_CODING_AGENT_DIR = agentDir
    await writeFile(targets.SOURCE_MODELS!, JSON.stringify({ providers: { synthetic: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: '$PI_LANDLOCK_UPSTREAM_KEY',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: 'probe-model', name: 'probe-model', reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }))

    bridge = await startServer({
      config: { ...loadConfig({ ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(base, 'state'), BRIDGE_BACKENDS: 'pi', PI_BIN: piBin!, BRIDGE_JAIL_MODE: 'fs-jail',
        BRIDGE_JAIL_BACKEND: 'landlock', BRIDGE_JAIL_HOST_EGRESS_ENFORCED: '1' }), port: 0 },
      cwd: base, quiet: true, handleSignals: false,
    })
    console.log(`kernel=${spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()} Landlock ABI=${landlock.stdout.trim()} pi=${piBin}`)
  }, 60_000)

  afterAll(async () => {
    await bridge?.close()
    await new Promise((resolve) => model?.close(resolve))
    process.env = saved
    if (base) await rm(base, { recursive: true, force: true })
  })

  it('keeps Pi\'s Bash from host credentials, sibling sessions, the Bridge\'s environment and its port, while the turn completes', async () => {
    const bridgePort = Number(new URL(bridge.url).port)
    // The unconfined control: the same user reads every target and reaches the Bridge's port.
    for (const path of Object.values(targets)) await expect(readFile(path)).resolves.toBeInstanceOf(Buffer)
    expect(await reaches(bridgePort)).toBe('connected')

    probe = [
      ...Object.entries(targets).map(([label, path]) => `if cat ${quote(path)} >/dev/null 2>&1; then echo READABLE_${label}; cat ${quote(path)}; else echo READ_BLOCKED_${label}; fi`),
      'echo inside > own.txt && sed "s/^/OWN_/" own.txt',
      `node -e ${quote(`const s=require('net').connect(${bridgePort},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED_BRIDGE');s.destroy()});s.on('error',e=>console.log('CONNECT_BLOCKED_BRIDGE_'+e.code))`)}`,
      'env',
    ].join('; ')

    const cwd = await mkdtemp(join(base, 'work-'))
    const response = await fetch(`${bridge.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'pi/synthetic/probe-model', cwd, stream: false,
        messages: [{ role: 'user', content: 'Run the probe, then report.' }] }),
      signal: AbortSignal.timeout(90_000),
    })
    const body = await response.json() as Record<string, any>
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.choices?.[0]?.message?.content).toContain('landlock-pi-ok')

    // The second model call carries the probe's output as the tool result.
    expect(bodies).toHaveLength(2)
    const result = bodies[1]!
    for (const label of Object.keys(targets)) expect(result).toContain(`READ_BLOCKED_${label}`)
    expect(result).toContain('OWN_inside')
    expect(result).toContain('CONNECT_BLOCKED_BRIDGE_EACCES')
    for (const secret of [HOST_SECRET, SIBLING_SECRET, UPSTREAM_KEY, BEARER]) expect(result).not.toContain(secret)
    // Only the Bridge's scoped transport held the key: it reached the model on Pi's behalf.
    expect(authorizations).toEqual([`Bearer ${UPSTREAM_KEY}`, `Bearer ${UPSTREAM_KEY}`])
  }, 120_000)
})

it('required Landlock and Pi qualification is explicit', () => {
  if (process.env.CLI_BRIDGE_REQUIRE_LANDLOCK === '1') expect(enabled, landlock.stderr || `Landlock ${landlock.status}, pi ${piBin}`).toBe(true)
})
