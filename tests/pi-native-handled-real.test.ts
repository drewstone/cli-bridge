import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
