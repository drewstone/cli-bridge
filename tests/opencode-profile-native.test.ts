/** Actual OpenCode 2.3 and published materializer against only a localhost API.
 * No operator credentials or external inference; no host-jail qualification. */
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'
import type { SpawnOpts, Spawner } from '../src/executors/types.js'

const binary = process.env.OPENCODE_NATIVE_TEST_BIN

it.runIf(binary)('runs the selected profile and skill and records the normal closed native store state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-opencode-native-'))
  const cwd = join(root, 'workspace'), home = join(root, 'home'), config = join(root, 'config'), data = join(root, 'data')
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(join(config, 'opencode'), { recursive: true })])
  const requests: Array<Record<string, any>> = []
  const api = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const main = body.tools?.some((tool: any) => tool.function?.name === 'skill') === true
    const tool = main && !body.messages.some((message: any) => message.role === 'tool')
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native-skill-call', type: 'function',
      function: { name: 'skill', arguments: JSON.stringify({ id: 'profile-proof' }) } }] }
      : { role: 'assistant', content: main ? 'NATIVE_PROFILE_OK' : 'Native profile proof' }
    const frame = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: `fixture-${requests.length}`,
      object: 'chat.completion.chunk', created: 1_800_000_000, model: 'profile-proof', choices, ...(usage ? { usage } : {}) })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame([{ index: 0, delta, finish_reason: null }]))
    res.write(frame([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]))
    res.write(frame([], { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }))
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const port = (api.address() as { port: number }).port
  const providerConfig = JSON.stringify({ providers: { 'bridge-local': {
    name: 'Local native profile proof', env: ['NATIVE_TEST_API_KEY'], package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { 'profile-proof': { name: 'Native proof' } },
  } } })
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', providerConfig)
  const frames: string[] = []
  let diagnostic = ''
  const launches: Array<{ args: string[]; nativeStore?: string }> = []
  const spawner: Spawner = Object.assign(async (bin: string, args: string[], options: SpawnOpts) => {
    launches.push({ args, nativeStore: options.nativeStore })
    const names = ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG',
      'OPENCODE_RUN_TIMEOUT_SECONDS', 'OPENCODE_RUNTIME_ID', 'OPENCODE_CONFIG']
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), NATIVE_TEST_API_KEY: 'localhost-only',
      ...Object.fromEntries(names.filter(key => options.env?.[key] !== undefined).map(key => [key, options.env![key]])),
    }
    const child = spawn(bin, args, { cwd: options.cwd, stdio: 'pipe', env })
    child.stdout.on('data', bytes => frames.push(bytes.toString()))
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4000) })
    return { child, release() {}, terminate: async () => { if (child.exitCode === null) child.kill('SIGTERM') } }
  }, { executionEnvironment: 'test-double' as const })
  const sessions = new SessionStore(join(root, 'bridge-state')), runs = new RunRegistry(), app = new Hono()
  mountChatCompletions(app, { registry: new BackendRegistry().register(new OpencodeBackend({ bin: binary!, timeoutMs: 30000, spawner })), sessions, runs })
  try {
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/bridge-local/profile-proof', cwd, session_id: 'native-profile-proof',
        agent_profile: { name: 'native-profile-proof', harness: 'opencode',
          model: { provider: 'bridge-local', default: 'bridge-local/profile-proof' },
          permissions: { '*': 'deny', skill: { '*': 'deny', 'profile-proof': 'allow' } },
          prompt: { instructions: ['Use the profile-proof skill, then answer.'] },
          resources: { skills: [{ kind: 'inline', name: 'profile-proof', content:
            '---\nname: profile-proof\ndescription: selected native profile proof\n---\nReturn NATIVE_PROFILE_OK after reading this skill.' }] } },
        messages: [{ role: 'user', content: 'Load the selected skill and return its answer.' }] }) })
    const body = await response.json() as any
    expect(response.status, JSON.stringify({ body, launches, calls: requests.length, native: frames.join('').slice(-4000), diagnostic })).toBe(200)
    expect(body.choices[0].message.content).toBe('NATIVE_PROFILE_OK')
    expect(requests).toHaveLength(2)
    const mainRequests = requests.filter(request => request.tools?.length)
    expect(mainRequests).toHaveLength(2)
    for (const request of mainRequests) expect(request.tools?.map((tool: any) => tool.function.name), JSON.stringify({ model: request.model,
      roles: request.messages?.map((message: any) => message.role), native: frames.join('').slice(-5000) })).toEqual(['skill'])
    expect(body.usage).toEqual({ completion_tokens: 12, fresh_input_tokens: 36, cache_read_input_tokens: 4,
      reasoning_tokens: 2, estimated: false, cost_known: false, cost_scope: 'total' })
    expect(launches[0]?.nativeStore).toBe('opencode')
    expect(launches[0]!.args.slice(-2)).toEqual(['--title', 'cli-bridge'])
    const nativeId = sessions.get('native-profile-proof', 'opencode')?.internalId
    expect(nativeId).toBeTruthy()
    const events = frames.join('').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(event => event.type === 'tool_use').map(event => event.part.tool)).toEqual(['skill'])
    const store = join(data, 'opencode')
    const files = (await readdir(store)).filter(path => path.startsWith('opencode.db'))
    const handle = await open(join(store, 'opencode.db'), 'r')
    const header = Buffer.alloc(20)
    try { await handle.read(header, 0, 20, 0) } finally { await handle.close() }
    const storeState = { journalReadVersion: header[18], journalWriteVersion: header[19],
      files: await Promise.all(files.map(async path => ({ path, bytes: (await stat(join(store, path))).size }))) }
    if (process.env.OPENCODE_NATIVE_TEST_EVIDENCE) await writeFile(process.env.OPENCODE_NATIVE_TEST_EVIDENCE,
      JSON.stringify({ nativeVersion: '2.3.0', nativeId, calls: requests.length, mainCalls: mainRequests.length,
        toolNames: mainRequests[0]!.tools.map((tool: any) => tool.function.name),
        launches, storeState, usage: body.usage, nativeEvents: events }, null, 2))
    expect(header.subarray(0, 16).toString()).toBe('SQLite format 3\0')
  } finally {
    vi.unstubAllEnvs()
    await runs.shutdown()
    sessions.close()
    api.closeAllConnections()
    await new Promise<void>(resolve => api.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
