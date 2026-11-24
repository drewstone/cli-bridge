/**
 * Retained Kimi Code sessions through the real Bridge listener and the real Kimi Code CLI (`kimi web`, carried over
 * stdio by kimi-kap-stdio.mjs). Only the model is synthetic: Kimi's own config points its key-only provider at a
 * local OpenAI-compatible endpoint that answers the instruction in the last user message:
 * - `Reply with exactly <word>`; `Repeat your previous answer.` (only the session's history can answer it);
 * - `RUN_SLEEP:<n>`: one Bash call running `sleep <n>`, which keeps the turn running for a steer or a cancel;
 * - `CALL_TOOL <name> <json>`: one call to that tool, then a reply carrying its result.
 * Needs the Kimi Code CLI: KIMI_BIN, else `kimi` on PATH (a Beelink gate installs @moonshot-ai/kimi-code).
 */
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const BEARER = 'kimi-native-session-integration'
const MODEL = 'kimi-code/kimi-for-coding'
const kimiBin = process.env.KIMI_BIN || 'kimi'
const kimi = await promisify(execFile)(kimiBin, ['--version'], { timeout: 30_000 }).then(({ stdout }) => stdout.trim(), () => null)

interface ModelRequest { users: string[]; roles: string[]; system: string; tools: string[] }

const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : ''

/** The synthetic model: an OpenAI-compatible streaming endpoint that records every request it answers. */
function syntheticModel(requests: ModelRequest[]): Server {
  return createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body || '{}') as { model?: string; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> }
    const messages = parsed.messages ?? []
    // Kimi appends `<system-reminder>` user messages; the caller's text is the last user message that is not one.
    const real = (message: { role: string; content: unknown }) => message.role === 'user' && !text(message.content).trimStart().startsWith('<system-reminder>')
    const last = messages.findLastIndex(real)
    const instruction = last < 0 ? '' : text(messages[last]!.content)
    const toolResult = messages.slice(last + 1).find((message) => message.role === 'tool')
    const tools = (parsed.tools ?? []).map((tool) => tool.function?.name ?? '')
    requests.push({ users: messages.filter(real).map((message) => text(message.content)), roles: messages.map((message) => message.role),
      system: text(messages.find((message) => message.role === 'system')?.content), tools })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const call = (name: string, args: Record<string, unknown>) => {
      chunk({ role: 'assistant', content: '' })
      chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      chunk({}, 'tool_calls')
    }
    const reply = (answer: string) => { chunk({ role: 'assistant', content: '' }); chunk({ content: answer }); chunk({}, 'stop') }
    const sleep = /RUN_SLEEP:(\d+)/u.exec(instruction)
    const named = /CALL_TOOL (\S+) (\{.*\})/u.exec(instruction)
    if (sleep && !toolResult) call(tools.find((name) => name === 'Bash') ?? 'Bash', { command: `sleep ${sleep[1]}` })
    else if (named && !toolResult) call(named[1]!, JSON.parse(named[2]!) as Record<string, unknown>)
    else if (named) reply(`TOOL SAID ${text(toolResult!.content)}`)
    else if (/Repeat your previous answer/u.test(instruction)) reply(text(messages.slice(0, last).findLast((message) => message.role === 'assistant')?.content))
    else reply(/Reply with exactly (\S+)/u.exec(instruction)?.[1] ?? (sleep ? 'SLEPT' : 'OK'))
    res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
}

// One stdio MCP server whose write_nonce tool writes `<dir>/<nonce>.nonce` and answers with the nonce.
const nonceServer = (dir: string) => `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:(r.params&&r.params.protocolVersion)||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'write_nonce',description:'Writes the nonce file and returns the nonce.',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']}}]};else if(r.method==='tools/call'){const nonce=String((r.params&&r.params.arguments&&r.params.arguments.nonce)||'');fs.writeFileSync(path.join(${JSON.stringify(dir)},nonce+'.nonce'),nonce);result={content:[{type:'text',text:'nonce '+nonce+' written'}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

describe.skipIf(!kimi)(`retained Kimi Code sessions on Kimi's local server (${kimi ?? 'no Kimi Code CLI'})`, () => {
  let root: string, model: Server, bridge: BridgeServer, admitted: BridgeServer
  const requests: ModelRequest[] = []
  const previousHome = process.env.KIMI_CODE_HOME
  let counter = 0

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kimi-native-session-')))
    model = syntheticModel(requests)
    model.listen(0, '127.0.0.1')
    await once(model, 'listening')
    const port = (model.address() as { port: number }).port
    // Kimi's own home for the Bridge and every Kimi process it starts: a key-only provider on the synthetic endpoint.
    process.env.KIMI_CODE_HOME = join(root, 'kimi-home')
    await mkdir(process.env.KIMI_CODE_HOME)
    await writeFile(join(process.env.KIMI_CODE_HOME, 'config.toml'), [
      `default_model = "${MODEL}"`, '[loop_control]', 'max_retries_per_step = 1',
      `[models."${MODEL}"]`, 'provider = "managed:kimi-code"', 'model = "kimi-for-coding"', 'max_context_size = 262144', 'capabilities = ["tool_use"]',
      '[providers."managed:kimi-code"]', 'type = "kimi"', `base_url = "http://127.0.0.1:${port}/v1"`, 'api_key = "synthetic-model-key"', '',
    ].join('\n'), { mode: 0o600 })
    const start = async (name: string, extra: Record<string, string> = {}) => await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, name), BRIDGE_BACKENDS: 'kimi', KIMI_BIN: kimiBin, ...extra }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
    bridge = await start('state')
    // Subscription-only admission: the synthetic endpoint is not Kimi Code's membership endpoint.
    admitted = await start('subscriptions-only', { BRIDGE_SUBSCRIPTIONS_ONLY: '1' })
  }, 60_000)
  afterAll(async () => {
    await bridge?.close()
    await admitted?.close()
    await new Promise((resolve) => model?.close(resolve))
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })

  const call = async (path: string, body?: unknown, server = bridge) => await fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  /** A run's canonical events, read until its terminal status, and the text its parts streamed. */
  const settle = async (runId: string) => {
    const events: Array<Record<string, any>> = []
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 90_000)
    try {
      const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: { authorization: `Bearer ${BEARER}` }, signal: controller.signal })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      reading: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          let event: Record<string, any>
          try { event = JSON.parse(line.slice(5)) } catch { continue }
          const inner = event.event ?? event
          events.push(inner)
          if (inner.type === 'status' && ['completed', 'failed', 'cancelled'].includes(inner.status)) break reading
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
    const streamed = events.filter((event) => event.type === 'message.part.updated' && event.part?.type === 'text' && typeof event.delta === 'string')
      .map((event) => event.delta as string).join('')
    return { events, text: streamed, status: events.findLast((event) => event.type === 'status')?.status as string | undefined }
  }

  // A retained session holds its executor slot for its whole life; close each one with its test.
  const open: string[] = []
  afterEach(async () => {
    for (const id of open.splice(0)) await call(`/v1/sessions/${id}/close`, {})
  })

  const session = async (extra: Record<string, unknown> = {}) => {
    const id = `kimi-native-${++counter}`
    open.push(id)
    const cwd = await mkdtemp(join(root, 'work-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, interaction_policy: 'unattended-allow', ...extra })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    return { id, cwd }
  }

  const turn = async (id: string, message: string, extra: Record<string, unknown> = {}) => {
    const name = `${id}-turn-${++counter}`
    const response = await call(`/v1/sessions/${id}/turns`, { message, turn_id: name, run_id: `${name}-run`, execution_id: `${name}-execution`, ...extra })
    const body = await response.json() as Record<string, any>
    expect(response.status, JSON.stringify(body)).toBeLessThan(300)
    return String(body.run.id)
  }

  it('keeps one native session across turns and applies a steer to the running turn', async () => {
    const { id } = await session()
    expect((await settle(await turn(id, 'Reply with exactly KEEP-7'))).text).toBe('KEEP-7')
    // Only the first turn's answer, carried in Kimi's own session, answers the second.
    const second = await settle(await turn(id, 'Repeat your previous answer.'))
    expect(second).toMatchObject({ status: 'completed', text: 'KEEP-7' })

    const runId = await turn(id, 'RUN_SLEEP:6')
    // A steer names the exact run, whose coordinates the run status carries as X-Run-* headers.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const status = await call(`/v1/runs/${encodeURIComponent(runId)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const run = { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'),
      environmentId: header('environment-id'), sessionId: header('session-id'), executionId: header('execution-id') }
    const steer = await call(`/v1/sessions/${id}/steer`, { operationId: 'kimi-steer-1', run, message: 'Reply with exactly STEERED-9' })
    expect(steer.status, await steer.clone().text()).toBe(200)
    const steered = await settle(runId)
    expect(steered).toMatchObject({ status: 'completed', text: 'STEERED-9' })
    // Kimi asked to run Bash; the turn's unattended-allow policy answered it.
    expect(steered.events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'interaction_answered_by_policy' }))
    expect(steered.events).toContainEqual(expect.objectContaining({ type: 'raw', event: expect.objectContaining({ type: 'steer', operationId: 'kimi-steer-1', state: 'applied' }) }))
    // The model saw the sleep's result and the steer together, in the same native conversation.
    const applied = requests.find((request) => request.users.at(-1) === 'Reply with exactly STEERED-9')
    expect(applied?.users).toEqual(['Reply with exactly KEEP-7', 'Repeat your previous answer.', 'RUN_SLEEP:6', 'Reply with exactly STEERED-9'])
    expect(applied?.roles.slice(-3)).toEqual(['assistant', 'tool', 'user'])
  }, 180_000)

  it('cancels a running turn: the run ends at once and the session takes no further turn', async () => {
    const { id } = await session()
    const runId = await turn(id, 'RUN_SLEEP:60')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const started = Date.now()
    const cancelled = await call(`/v1/runs/${encodeURIComponent(runId)}/cancel?wait_ms=20000`, {})
    expect(cancelled.status, await cancelled.clone().text()).toBeLessThan(300)
    expect(await cancelled.json()).toMatchObject({ cancelled: true, terminal: true })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect((await settle(runId)).status).not.toBe('completed')
    // A cancelled retained session takes no further turn.
    const next = await call(`/v1/sessions/${id}/turns`, { message: 'Reply with exactly NEVER-2', turn_id: `${id}-after`,
      run_id: `${id}-after-run`, execution_id: `${id}-after-execution` })
    expect(next.status).toBe(409)
    expect(requests.some((request) => request.users.at(-1) === 'Reply with exactly NEVER-2')).toBe(false)
  }, 120_000)

  it('reaches Kimi with the profile prompt as its project agent and the profile MCP server in a trusted workspace', async () => {
    const cwd = await mkdtemp(join(root, 'profile-'))
    const server = join(cwd, 'nonce-mcp.cjs')
    await writeFile(server, nonceServer(cwd))
    const { id } = await session({ cwd, agent_profile: {
      name: 'conformance',
      prompt: { systemPrompt: 'Your codeword is PROFILE-5.' },
      mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }] } },
    } })
    const result = await settle(await turn(id, 'CALL_TOOL mcp__conformance__write_nonce {"nonce":"NONCE-4"}'))
    expect(result).toMatchObject({ status: 'completed', text: expect.stringContaining('NONCE-4') })
    expect(await readFile(join(cwd, 'NONCE-4.nonce'), 'utf8')).toBe('NONCE-4')
    const seen = requests.find((request) => request.users.at(-1)?.startsWith('CALL_TOOL mcp__conformance__write_nonce'))
    expect(seen?.system).toContain('Your codeword is PROFILE-5.')
    expect(seen?.tools).toContain('mcp__conformance__write_nonce')
  }, 180_000)

  it('refuses a retained session whose Kimi provider is not a subscription before Kimi takes a turn', async () => {
    const before = requests.length
    const id = `kimi-native-refused-${++counter}`
    const cwd = await mkdtemp(join(root, 'refused-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd }, admitted)
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    const response = await call(`/v1/sessions/${id}/turns`, { message: 'Reply with exactly NEVER', turn_id: `${id}-t`,
      run_id: `${id}-r`, execution_id: `${id}-e` }, admitted)
    const body = await response.json() as Record<string, any>
    expect(JSON.stringify(body)).toContain('subscription_required')
    expect(requests.length).toBe(before)
    await call(`/v1/sessions/${id}/close`, {}, admitted)
  }, 60_000)
})
