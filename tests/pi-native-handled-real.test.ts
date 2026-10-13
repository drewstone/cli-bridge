import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BackendRegistry } from '../src/backends/registry.js'
import { PiBackend } from '../src/backends/pi.js'
import { createPiInferenceTransportResolver } from '../src/backends/pi-inference-transport.js'
import { hostSpawner } from '../src/executors/host.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { PiNativeSession } from '../src/backends/pi-native-session.js'
import { piNativeCapabilities } from '../src/backends/pi-native-start.js'

// Pi 1.0.2's input hook completes before inference. This gate is independent
// of CLI_BRIDGE_REAL_PI, whose tests intentionally use a paid provider.
it.skipIf(process.env.CLI_BRIDGE_REAL_PI_NO_INFERENCE !== '1')('handles two real Pi inputs without inference or agent settlement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-handled-real-'))
  let requests = 0
  const endpoint = createServer((_request, response) => {
    requests += 1
    response.writeHead(500).end('unexpected inference')
  })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const address = endpoint.address()
  if (!address || typeof address === 'string') throw new Error('missing local endpoint')
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {
    'no-inference': {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'unused-test-key',
      models: [{ id: 'local-only', name: 'local-only', contextWindow: 8192, maxTokens: 128 }],
    },
  } }))
  const extension = join(dir, 'handled.ts')
  writeFileSync(extension, `export default function (pi) {
    pi.on('input', async (event, ctx) => {
      ctx.ui.notify('handled:' + event.text);
      return { action: 'handled' };
    });
  }`)
  const child = spawn(process.env.CLI_BRIDGE_PI_BIN ?? 'pi', [
    '--mode', 'rpc', '--no-session', '--offline', '--no-tools', '--no-extensions',
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--extension', extension, '--provider', 'no-inference', '--model', 'local-only',
  ], {
    cwd: dir,
    // No ambient provider credentials, login state, extensions, or project files.
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_TELEMETRY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const native = new PiNativeSession({
    child, release: () => {},
    terminate: async () => { child.kill('SIGTERM'); await closed },
  }, {
    capabilities: piNativeCapabilities(),
    requestTimeoutMs: 5_000,
    cleanup: () => {},
  })
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 10_000)
  try {
    for (const prompt of ['first', 'second']) {
      const events: unknown[] = []
      for await (const event of native.turn(prompt, controller.signal)) events.push(event)
      expect(events).toContainEqual(expect.objectContaining({ type: 'extension_ui_request', message: `handled:${prompt}` }))
      expect(events).toContainEqual(expect.objectContaining({ type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } }))
      expect(native.isClosed()).toBe(false)
    }
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(messages.filter(message => message.type === 'response' && message.command === 'prompt')).toEqual([
      expect.objectContaining({ success: true, data: { disposition: 'handled' } }),
      expect.objectContaining({ success: true, data: { disposition: 'handled' } }),
    ])
    expect(messages.some(message => message.type === 'agent_start' || message.type === 'agent_settled')).toBe(false)
    expect(requests).toBe(0)
  } finally {
    clearTimeout(deadline)
    await native.close()
    await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

// Exercise the retained wire contract with the production host executor and
// actual Pi. A request must be able to raise confinement with no service floor.
it.skipIf(process.env.CLI_BRIDGE_REAL_PI_NO_INFERENCE !== '1')('honors a retained per-session fs-jail for two real handled turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-pi-retained-jail-'))
  const workspace = join(dir, 'workspace')
  const agentDir = join(dir, 'agent')
  const jailRoot = join(workspace, '.agent-home', 'requested')
  mkdirSync(workspace)
  mkdirSync(agentDir)
  const outside = join(dir, 'sibling.txt')
  writeFileSync(outside, 'owned fixture outside the requested workspace')
  const bin = process.env.CLI_BRIDGE_PI_BIN ?? 'pi'
  let connections = 0
  const endpoint = createServer((_request, response) => response.writeHead(503).end('inference forbidden'))
  endpoint.on('connection', () => { connections += 1 })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const address = endpoint.address()
  if (!address || typeof address === 'string') throw new Error('missing local endpoint')
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'no-inference': {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'unused-test-key',
      models: [{ id: 'local-only', name: 'local-only', contextWindow: 8192, maxTokens: 128 }],
    },
  } }))
  const extension = join(workspace, 'handled.mjs')
  writeFileSync(extension, `import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export default function (pi) {
  let sequence = 0;
  pi.on('input', async (event, ctx) => {
    let outsideReadable = false;
    try { readFileSync(${JSON.stringify(outside)}); outsideReadable = true; } catch {}
    writeFileSync(join(homedir(), 'handled-count'), String(++sequence));
    ctx.ui.notify(JSON.stringify({ pid: process.pid, sequence, input: event.text, home: homedir(), outsideReadable }));
    return { action: 'handled' };
  });
}`)
  const environmentKeys = ['BRIDGE_JAIL_MODE', 'WORKER_FS_JAIL', 'BRIDGE_JAIL_RO_PATHS', 'BRIDGE_JAIL_RW_PATHS', 'PI_OFFLINE', 'PI_TELEMETRY'] as const
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]))
  for (const key of environmentKeys) delete process.env[key]
  process.env.PI_OFFLINE = '1'
  process.env.PI_TELEMETRY = '0'
  const store = new SessionStore(join(dir, 'store'))
  const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
  const backend = new PiBackend({
    bin, timeoutMs: 10_000, spawner: hostSpawner,
    transportResolver: createPiInferenceTransportResolver({
      bin, agentDir, sessionDir: join(dir, 'sessions'),
      env: { PATH: process.env.PATH, HOME: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    }),
  })
  const app = new Hono()
  mountRetainedSessions(app, new RetainedSessionService({
    store, registry: new BackendRegistry().register(backend), runs,
  }))
  try {
    const created = await app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({
      id: 'real-handled-jail', model: 'pi/no-inference/local-only', cwd: workspace,
      mode: 'byob', interaction_policy: 'interactive',
      execution: { kind: 'host', jail: { mode: 'fs-jail', root: jailRoot }, acquireTimeoutMs: 1000 },
      agent_profile: { name: 'handled-jail', extensions: { pi: { load: [extension] } } },
    }) })
    expect(created.status, await created.text()).toBe(201)
    const pids: number[] = []
    for (const [index, message] of ['first', 'second'].entries()) {
      const runId = `real-handled-jail-${index}`
      const admitted = await app.request('/v1/sessions/real-handled-jail/turns', {
        method: 'POST', body: JSON.stringify({ message, run_id: runId, execution_id: runId }),
      })
      expect(admitted.status, await admitted.text()).toBe(202)
      const deadline = Date.now() + 12_000
      while (!store.getRetainedRun(runId)?.snapshot.terminal && Date.now() < deadline) {
        if (connections > 0) throw new Error('unexpected inference connection')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(store.getRetainedRun(runId)?.snapshot).toMatchObject({ status: 'done', terminal: true })
      const events = store.retainedEventsAfter('real-handled-jail')
        .filter(row => row.envelope.runId === runId).map(row => row.envelope.event)
      expect(events).toContainEqual({ type: 'status', status: 'completed' })
      expect(events.some(event => event.type === 'message.part.updated')).toBe(false)
      const notifications = events.filter(event => event.type === 'raw')
        .map(event => event.event as Record<string, unknown>)
        .filter(event => event.type === 'extension_ui_request' && event.method === 'notify')
      expect(notifications).toHaveLength(1)
      const notification = JSON.parse(String(notifications[0]!.message)) as Record<string, unknown>
      expect(notification).toMatchObject({ sequence: index + 1, input: message, home: jailRoot, outsideReadable: false })
      expect(notification.pid).toEqual(expect.any(Number))
      pids.push(Number(notification.pid))
      expect(connections).toBe(0)
    }
    expect(pids[0]).toBe(pids[1])
    expect(readFileSync(join(jailRoot, 'handled-count'), 'utf8')).toBe('2')
    const closed = await app.request('/v1/sessions/real-handled-jail/close', { method: 'POST', body: '{}' })
    expect(closed.status, await closed.text()).toBe(200)
  } finally {
    try {
      // A failed assertion may leave the retained child idle or mid-turn.
      // Close its exact session through the same owner boundary on every exit.
      const closed = await app.request('/v1/sessions/real-handled-jail/close', { method: 'POST', body: '{}' })
      expect([200, 404]).toContain(closed.status)
    } finally {
      await runs.shutdown(2_000)
      store.close()
      endpoint.closeAllConnections()
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()))
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 35_000)
