/**
 * Harness conformance matrix: every registered harness by six verbs, as real turns through a real
 * Bridge listener. Run it where the harness CLIs and their seats are, for example inside a box built
 * from agent-container's Nix flake:
 *
 *   pnpm conformance:matrix [--harness claude,codex] [--json matrix.json]
 *
 * Model per harness: CONFORMANCE_MODEL_<HARNESS> (claude-code -> CONFORMANCE_MODEL_CLAUDE_CODE),
 * else the harness's own default. A harness whose binary or login is missing reads `blocked`.
 * Cells: green | red (cause) | unsupported (the CLI has no such mode) | blocked (no binary or seat).
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { localBackends, localHarnesses, loadConfig } from '../../src/config.js'
import { startServer, type BridgeServer } from '../../src/server.js'

type Cell = { state: 'green' | 'red' | 'unsupported' | 'blocked'; detail: string }
const VERBS = ['tool', 'retained', 'steer', 'abort', 'profile+mcp', 'usage+outcome'] as const
type Verb = typeof VERBS[number]
const BEARER = `conformance-${randomBytes(12).toString('hex')}`
const TURN_MS = Number(process.env.CONFORMANCE_TURN_MS ?? 240_000)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const only = flag('--harness')?.split(',')
const rows = localBackends.filter((row) => !only || only.includes(row.name) || only.includes(row.harness))
const marker = (label: string) => `${label}-${randomBytes(4).toString('hex')}`
const green = (detail: string): Cell => ({ state: 'green', detail })
const red = (detail: string): Cell => ({ state: 'red', detail: detail.replace(/\s+/gu, ' ').slice(0, 240) })

function harnessModel(harness: string): string {
  return process.env[`CONFORMANCE_MODEL_${harness.toUpperCase().replace(/-/gu, '_')}`] ?? harness
}

/** The binary on PATH and, for native harnesses, the CLI's own login check. */
function seat(name: string, bin: string): Cell | null {
  if (spawnSync('sh', ['-c', `command -v "$1"`, '_', bin]).status !== 0) return { state: 'blocked', detail: `no ${bin} on PATH` }
  const native = localHarnesses.find(([key]) => key === name)
  if (!native) return null
  const status = spawnSync(bin, [...native[3]], { encoding: 'utf8', timeout: 30_000 })
  if (status.status !== 0) return { state: 'blocked', detail: `no seat: ${bin} ${native[3].join(' ')} exited ${status.status}; log in with \`${native[2]}\`` }
  return null
}

async function call(bridge: BridgeServer, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(TURN_MS),
  })
}

type Turn = { status: number; text: string; finish?: string; usage?: Record<string, unknown>; error?: unknown }
async function chat(bridge: BridgeServer, model: string, cwd: string, prompt: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Turn> {
  const response = await call(bridge, '/v1/chat/completions', {
    model, cwd, stream: false, messages: [{ role: 'user', content: prompt }], ...extra,
  }, signal)
  const body = await response.json().catch(() => ({})) as Record<string, any>
  const choice = body.choices?.[0]
  return { status: response.status, text: String(choice?.message?.content ?? ''), finish: choice?.finish_reason, usage: body.usage, error: body.error }
}

/** Text of one run, read from its replayed event stream (one-shot chunks or canonical parts). */
async function runText(bridge: BridgeServer, runId: string): Promise<{ text: string; failed?: string }> {
  const response = await call(bridge, `/v1/runs/${encodeURIComponent(runId)}/events`)
  let text = '', failed: string | undefined
  for (const line of (await response.text()).split('\n')) {
    if (!line.startsWith('data:')) continue
    let event: any
    try { event = JSON.parse(line.slice(5)) } catch { continue }
    const inner = event.event ?? event
    if (typeof inner.choices?.[0]?.delta?.content === 'string') text += inner.choices[0].delta.content
    if (inner.type === 'message.part.updated' && inner.part?.type === 'text' && typeof inner.delta === 'string') text += inner.delta
    if (inner.type === 'status' && inner.status === 'failed') failed = String(inner.detail ?? 'failed')
  }
  return { text, ...(failed ? { failed } : {}) }
}

const tokenServer = (token: string) => `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:(r.params&&r.params.protocolVersion)||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',description:'Returns the conformance token.',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:${JSON.stringify(token)}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

async function harnessCells(bridge: BridgeServer, harness: string, root: string): Promise<Record<Verb, Cell>> {
  const model = harnessModel(harness)
  const cwd = await mkdtemp(join(root, `${harness}-`))
  const cells = {} as Record<Verb, Cell>
  const guard = async (verb: Verb, run: () => Promise<Cell>) => {
    try { cells[verb] = await run() } catch (error) { cells[verb] = red(error instanceof Error ? error.message : String(error)) }
  }

  // A refused route is a seat or configuration fact for the whole row, not six failures.
  const probe = await chat(bridge, model, cwd, 'Reply with OK only.', { session_id: marker(`${harness}-probe`) })
  const refusal = probe.error as { type?: string; message?: string } | undefined
  if (probe.status === 403 && refusal?.type === 'subscription_required') {
    return Object.fromEntries(VERBS.map((verb) => [verb, { state: 'blocked', detail: `no subscription seat: ${refusal.message ?? ''}`.slice(0, 240) }])) as Record<Verb, Cell>
  }
  if (probe.status === 501 && /requires an explicit/u.test(refusal?.message ?? '')) {
    return Object.fromEntries(VERBS.map((verb) => [verb, { state: 'blocked', detail: `set CONFORMANCE_MODEL_${harness.toUpperCase().replace(/-/gu, '_')}: ${refusal?.message ?? ''}`.slice(0, 240) }])) as Record<Verb, Cell>
  }

  let toolTurn: Turn | undefined
  await guard('tool', async () => {
    const value = marker('tool'), file = `${value}.txt`
    toolTurn = await chat(bridge, model, cwd, `Use your file tool to create the file ${file} in the current directory containing exactly ${value}. Then read it back with your file tool and reply with its exact contents only.`, { session_id: marker(`${harness}-tool`) })
    const written = await readFile(join(cwd, file), 'utf8').catch(() => '')
    if (toolTurn.status !== 200) return red(`HTTP ${toolTurn.status}: ${JSON.stringify(toolTurn.error)}`)
    if (written.trim() !== value) return red(`file ${written ? 'has other content' : 'not written'}; reply: ${toolTurn.text}`)
    return toolTurn.text.includes(value) ? green('wrote and read back') : red(`file written; reply lacks it: ${toolTurn.text}`)
  })

  const sessionId = marker(`${harness}-retained`)
  const created = await call(bridge, '/v1/sessions', { id: sessionId, model, cwd })
  const native = created.status === 200 || created.status === 201
  const nativeRefusal = native ? '' : `POST /v1/sessions ${created.status}: ${(await created.text()).slice(0, 160)}`
  const nativeTurn = async (n: number, message: string) => {
    const id = `${sessionId}-turn-${n}`
    const response = await call(bridge, `/v1/sessions/${sessionId}/turns`, { message, turn_id: id, run_id: `${id}-run`, execution_id: `${id}-execution` })
    const body = await response.json() as Record<string, any>
    if (response.status >= 300) throw new Error(`turn ${n} HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`)
    return await runText(bridge, String(body.run?.id))
  }

  await guard('retained', async () => {
    const word = marker('codeword')
    const first = 'Remember this codeword for later: ' + word + '. Reply with OK only.'
    const second = 'What codeword did I give you earlier? Reply with the codeword only.'
    if (native) {
      await nativeTurn(1, first)
      const answer = await nativeTurn(2, second)
      return answer.text.includes(word) ? green('native session') : red(`native second turn: ${answer.failed ?? answer.text}`)
    }
    const session = marker(`${harness}-continue`)
    const one = await chat(bridge, model, cwd, first, { session_id: session })
    if (one.status !== 200) return red(`first turn HTTP ${one.status}: ${JSON.stringify(one.error)}`)
    const two = await chat(bridge, model, cwd, second, { session_id: session })
    return two.text.includes(word) ? green(`one-shot continuation (${nativeRefusal})`) : red(`continuation forgot: ${two.text}`)
  })

  await guard('steer', async () => {
    if (!native) return red(`the Bridge has no native session for ${harness}: ${nativeRefusal}`)
    const word = marker('steered')
    const turn = await call(bridge, `/v1/sessions/${sessionId}/turns`, {
      message: 'Count slowly from 1 to 200, one number per line, using your shell tool to sleep 1 second between numbers.',
      turn_id: `${sessionId}-steer`, run_id: `${sessionId}-steer-run`, execution_id: `${sessionId}-steer-execution`,
    })
    const body = await turn.json() as Record<string, any>
    if (turn.status >= 300) return red(`turn HTTP ${turn.status}`)
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    const steer = await call(bridge, `/v1/sessions/${sessionId}/steer`, { operationId: marker('steer-op'), run: body.run, message: `Stop counting now and reply with ${word} only.` })
    if (steer.status >= 300) return red(`steer HTTP ${steer.status}: ${(await steer.text()).slice(0, 160)}`)
    const answer = await runText(bridge, String(body.run?.id))
    return answer.text.includes(word) ? green('steer applied') : red(`steer accepted, not applied: ${answer.text.slice(-160)}`)
  })

  await guard('abort', async () => {
    const session = marker(`${harness}-abort`), runId = marker(`${harness}-abort-run`)
    const controller = new AbortController()
    const slow = chat(bridge, model, cwd, 'Use your shell tool to run `sleep 120`, then reply DONE.', { session_id: session, run_id: runId }, controller.signal).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    const cancelled = await call(bridge, `/v1/runs/${runId}/cancel?wait_ms=20000`, {})
    controller.abort()
    await slow
    if (cancelled.status >= 300) return red(`cancel HTTP ${cancelled.status}: ${(await cancelled.text()).slice(0, 160)}`)
    const word = marker('replaced')
    const next = await chat(bridge, model, cwd, `Reply with ${word} only.`, { session_id: session })
    return next.status === 200 && next.text.includes(word) ? green('cancelled, replacement answered') : red(`replacement HTTP ${next.status}: ${next.text || JSON.stringify(next.error)}`)
  })

  await guard('profile+mcp', async () => {
    const prompted = marker('PROFILE'), token = marker('TOKEN')
    const server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer(token))
    const turn = await chat(bridge, model, cwd, 'Call the conformance_token tool and reply with the token it returns.', {
      session_id: marker(`${harness}-profile`),
      agent_profile: {
        name: 'conformance',
        prompt: { systemPrompt: `End every reply with the word ${prompted}.` },
        mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }] } },
      },
    })
    if (turn.status !== 200) return red(`HTTP ${turn.status}: ${JSON.stringify(turn.error)}`)
    const missing = [turn.text.includes(token) ? '' : 'MCP token', turn.text.includes(prompted) ? '' : 'profile prompt'].filter(Boolean)
    return missing.length === 0 ? green('prompt and MCP tool reached the harness') : red(`missing ${missing.join(' and ')}: ${turn.text}`)
  })

  await guard('usage+outcome', async () => {
    if (!toolTurn || toolTurn.status !== 200) return red('no completed tool turn to read usage from')
    const usage = toolTurn.usage ?? {}
    const counted = Object.values(usage).some((value) => typeof value === 'number' && value > 0)
    const refused = await chat(bridge, `${harness}/conformance-no-such-model`, cwd, 'Reply OK.', { session_id: marker(`${harness}-refused`) })
    const typed = refused.status >= 400 ? Boolean((refused.error as any)?.type ?? (refused.error as any)?.code) : refused.finish === 'error'
    if (!counted) return red(`no usage on a completed turn (finish ${toolTurn.finish})`)
    return typed ? green(`usage ${JSON.stringify(usage).slice(0, 80)}; unknown model refused typed`) : red(`unknown model not refused typed: HTTP ${refused.status} ${JSON.stringify(refused.error ?? refused.text).slice(0, 120)}`)
  })
  return cells
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-conformance-'))
  const config = loadConfig({ ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
    BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: rows.map((row) => row.name).join(',') })
  const matrix: Record<string, Record<Verb, Cell>> = {}
  const bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  try {
    for (const row of rows) {
      const bin = (config as unknown as Record<string, string>)[`${row.name}Bin`] ?? row.name
      const blocked = seat(row.name, bin)
      matrix[row.harness] = blocked
        ? Object.fromEntries(VERBS.map((verb) => [verb, blocked])) as Record<Verb, Cell>
        : await harnessCells(bridge, row.harness, root)
      console.error(`[conformance] ${row.harness}: ${VERBS.map((verb) => `${verb}=${matrix[row.harness]![verb].state}`).join(' ')}`)
    }
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
  const mark = { green: 'green', red: 'RED', unsupported: 'unsupported', blocked: 'blocked' } as const
  console.log(`| harness | ${VERBS.join(' | ')} |\n|---|${VERBS.map(() => '---').join('|')}|`)
  for (const [harness, cells] of Object.entries(matrix)) console.log(`| ${harness} | ${VERBS.map((verb) => mark[cells[verb].state]).join(' | ')} |`)
  const json = flag('--json')
  if (json) await writeFile(json, JSON.stringify({ at: new Date().toISOString(), models: Object.fromEntries(rows.map((row) => [row.harness, harnessModel(row.harness)])), matrix }, null, 2))
  const counts = Object.values(matrix).flatMap((cells) => Object.values(cells)).reduce((sum, cell) => ({ ...sum, [cell.state]: (sum[cell.state] ?? 0) + 1 }), {} as Record<string, number>)
  console.log(`\ncells: ${JSON.stringify(counts)}`)
  process.exitCode = (counts.red ?? 0) > 0 ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 2 })
