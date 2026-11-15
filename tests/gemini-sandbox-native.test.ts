/** Opt-in actual Gemini CLI with a localhost provider and isolated credentials.
 * This checks native config precedence, not host-jail qualification. */
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GeminiBackend } from '../src/backends/gemini.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'
import type { SpawnOpts, Spawner } from '../src/executors/types.js'

const entry = process.env.GEMINI_NATIVE_TEST_ENTRY

it.runIf(entry)('actual Gemini honors supplied sandbox=false over saved sandbox=true without changing settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-native-sandbox-'))
  const home = join(root, 'home'), cwd = join(root, 'workspace')
  mkdirSync(join(home, '.gemini'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'fixture.txt'), 'NATIVE-SANDBOX-PREFERENCE\n')
  const settingsPath = join(home, '.gemini/settings.json')
  const settings = JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } },
    telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
    tools: { core: ['read_file'], sandbox: true } })
  writeFileSync(settingsPath, settings)
  let calls = 0
  const api = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url?.includes('countTokens')) { res.end('{"totalTokens":100}'); return }
    if (!/generateContent/iu.test(req.url ?? '')) { res.statusCode = 404; res.end('{}'); return }
    const parts = ++calls === 1 ? [{ functionCall: { name: 'read_file', args: { file_path: 'fixture.txt' } } }]
      : [{ text: 'NATIVE-SANDBOX-PREFERENCE' }]
    res.setHeader('content-type', 'text/event-stream')
    res.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }] })}\n\n`)
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const port = (api.address() as { port: number }).port
  let launch: { args: string[]; nativeStore?: string; sandbox?: string } | undefined
  const nativeFrames: string[] = []
  const spawner: Spawner = Object.assign(async (_bin: string, args: string[], options: SpawnOpts) => {
    launch = { args, nativeStore: options.nativeStore, sandbox: options.env?.GEMINI_SANDBOX }
    const child = spawn(process.execPath, [entry!, ...args, '--skip-trust'], {
      cwd: options.cwd, stdio: 'pipe', env: {
        PATH: process.env.PATH, HOME: home, GEMINI_CLI_HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
        GEMINI_SANDBOX: options.env?.GEMINI_SANDBOX,
        GEMINI_API_KEY: 'localhost-protocol-only', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
        GEMINI_TELEMETRY_ENABLED: 'false', NO_COLOR: '1', CI: 'true',
      },
    })
    child.stdout.on('data', bytes => nativeFrames.push(bytes.toString()))
    return { child, release() {}, terminate: async () => { if (child.exitCode === null) child.kill('SIGTERM') } }
  }, { executionEnvironment: 'test-double' as const })
  const sessions = new SessionStore(join(root, 'bridge-state')), runs = new RunRegistry(), app = new Hono()
  mountChatCompletions(app, { registry: new BackendRegistry().register(new GeminiBackend({ bin: process.execPath, timeoutMs: 30000, spawner })), sessions, runs })
  vi.stubEnv('GEMINI_SANDBOX', 'false')
  try {
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini/gemini-2.5-flash', cwd, session_id: 'sandbox-choice',
        messages: [{ role: 'user', content: 'Read fixture.txt and return its marker.' }] }) })
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.choices[0].message.content).toBe('NATIVE-SANDBOX-PREFERENCE')
    expect(calls).toBe(2)
    expect(launch).toMatchObject({ nativeStore: 'gemini', sandbox: 'false' })
    expect(launch!.args.filter(arg => arg.startsWith('--sandbox'))).toEqual(['--sandbox=false'])
    expect(readFileSync(settingsPath, 'utf8')).toBe(settings)
    const events = nativeFrames.join('').trim().split('\n').map(line => JSON.parse(line))
    const nativeId = events.find(event => event.type === 'init')?.session_id
    expect(nativeId).toBeTruthy()
    expect(sessions.get('sandbox-choice', 'gemini')?.internalId).toBe(nativeId)
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({ status: 'success' })
    expect(events.find(event => event.type === 'result')).toMatchObject({ status: 'success' })
    const files = readdirSync(join(home, '.gemini/tmp'), { recursive: true }).map(String).filter(path => path.endsWith('.jsonl'))
    const headers = files.map(path => JSON.parse(readFileSync(join(home, '.gemini/tmp', path), 'utf8').split('\n')[0]!))
    expect(headers.some(header => header.sessionId === nativeId)).toBe(true)
  } finally {
    vi.unstubAllEnvs()
    await runs.shutdown()
    sessions.close()
    await new Promise<void>(resolve => api.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
