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
 *
 * Two axes, named in every row: `seat` runs each harness's own model on a subscription seat;
 * CONFORMANCE_SCRIPTED=1 (`scripted`) drives the Router's scripted test model, tangle/canary-echo, which
 * needs no seat and cannot wobble. It answers the instruction in the last user message that carries one:
 * - tool: `Call the tool *write_nonce with exactly {...}` of the matrix's own MCP server (prime: through its REPL);
 * - retained: `Reply with exactly <word>`, then a second turn with no instruction, which can only be
 *   answered with <word> when the harness sent the first turn along;
 * - steer: the turn calls the matrix's `wait_seconds` tool and the steer says `Reply with exactly <word>`,
 *   which the turn can only answer when the steer reached it mid-turn;
 * - abort: the cancelled turn waits in `wait_seconds`; the replacement replies with its own word;
 * - usage: `Report usage <prompt> <completion>`, checked by equality.
 * The profile prompt is not observable on it; the profile's MCP server is.
 * The scripted model makes one call per instruction, so it cannot search for a deferred tool first: the
 * axis runs the Bridge with ENABLE_TOOL_SEARCH=false (unless set), which has Claude Code put every MCP
 * tool in each request instead of behind its ToolSearch tool, as it does for an endpoint without search.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { localBackends, localHarnesses, loadConfig } from '../../src/config.js'
import { startServer, type BridgeServer } from '../../src/server.js'

type Cell = { state: 'green' | 'red' | 'unsupported' | 'blocked'; detail: string }
const SCRIPTED = process.env.CONFORMANCE_SCRIPTED === '1'
const AXIS = SCRIPTED ? 'scripted' : 'seat'
const AXIS_TEXT = SCRIPTED ? 'scripted model (tangle/canary-echo through the Router)' : "the harness's own model on a seat"
// Cursor Agent talks only to Cursor's own backend, so no scripted model is on its route.
// Harnesses no scripted model can reach. Cursor Agent talks only to Cursor's backend (the CLI cannot);
// Gemini CLI speaks only the Gemini API, which the Router does not serve (no route, not a CLI limit).
const NO_SCRIPTED_ROUTE: Record<string, Cell> = {
  cursor: { state: 'unsupported', detail: 'Cursor Agent reaches only Cursor\'s own backend; the seat axis measures it' },
  gemini: { state: 'blocked', detail: 'no scripted route: Gemini CLI speaks only the Gemini API, which the Router does not serve; the seat axis needs a Google login on the Bridge host' },
}
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

/**
 * The binary on PATH and, on the seat axis, the CLI's own login check. The scripted axis needs no
 * login: the Router key is its only credential. Pi's check names the provider its model routes to.
 */
function seat(name: string, harness: string, bin: string): Cell | null {
  if (spawnSync('sh', ['-c', `command -v "$1"`, '_', bin]).status !== 0) return { state: 'blocked', detail: `no ${bin} on PATH` }
  if (SCRIPTED) return NO_SCRIPTED_ROUTE[harness] ?? null
  const native = localHarnesses.find(([key]) => key === name)
  if (!native) return null
  const provider = harness === 'pi' ? /^pi\/([^/]+)\//u.exec(harnessModel(harness))?.[1] : undefined
  const check = native[3].map((arg) => (provider && arg === 'openai-codex' ? provider : arg))
  const status = spawnSync(bin, check, { encoding: 'utf8', timeout: 30_000 })
  if (status.status !== 0) return { state: 'blocked', detail: `no seat: ${bin} ${check.join(' ')} exited ${status.status}; log in with \`${native[2]}\`` }
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

const USAGE = { prompt: 1234, completion: 56 }
// prime-agent 0.10 offers its model one tool, a Python REPL, and mounts an MCP server there as
// `mcp.call_tool(server, tool, args)` (its system prompt's "Generic MCP Connections"), so prime's script
// calls the REPL; every other harness offers the MCP tool itself.
const scriptedMcpCall = (harness: string, tool: string, args: Record<string, unknown>) => harness === 'prime'
  ? `Call the tool python_repl with exactly ${JSON.stringify({ code: `print(await mcp.call_tool('conformance', '${tool}', ${JSON.stringify(args)}))` })}`
  : `Call the tool *${tool} with exactly ${JSON.stringify(args)}`

// One MCP tool that writes `<dir>/<nonce>.nonce` and answers with the nonce, so a turn proves both effects.
const nonceServer = (dir: string) => `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:(r.params&&r.params.protocolVersion)||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'write_nonce',description:'Writes the nonce file and returns the nonce.',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']}},{name:'wait_seconds',description:'Waits the given number of seconds, then returns.',inputSchema:{type:'object',properties:{seconds:{type:'number'}},required:['seconds']}}]};else if(r.method==='tools/call'&&r.params&&r.params.name==='wait_seconds'){const seconds=Number(r.params.arguments&&r.params.arguments.seconds)||0;setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'waited '+seconds+' seconds'}]}})+'\\n'),seconds*1000);return}else if(r.method==='tools/call'){const nonce=String((r.params&&r.params.arguments&&r.params.arguments.nonce)||'');fs.writeFileSync(path.join(${JSON.stringify(dir)},nonce+'.nonce'),nonce);result={content:[{type:'text',text:'nonce '+nonce+' written'}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

const tokenServer = (token: string) => `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{let r;try{r=JSON.parse(line)}catch{return}if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:(r.params&&r.params.protocolVersion)||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'conformance',version:'1'}}:r.method==='tools/list'?{tools:[{name:'conformance_token',description:'Returns the conformance token.',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:${JSON.stringify(token)}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`

/**
 * Whether the CLI itself offers a mode that keeps a session open for input mid-turn, read from its own
 * help: a server, ACP, an RPC mode or streamed input. Without one, steer is not supported by the CLI.
 */
function retainedModeEvidence(bin: string): { offered: boolean; evidence: string } {
  const help = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000 })
  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
  // A subcommand line, with or without the program name in front: `  acp ...` or `  opencode serve ...`.
  const modes = [/^\s+(?:[\w-]+\s)?(?:acp|serve|app-server|web)\b/mu, /--(?:experimental-)?acp\b/u, /--mode\b[^\n]*\brpc\b/u, /--input-format\b/u]
  const offered = modes.some((mode) => mode.test(text))
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim().split('\n')[0] ?? ''
  return { offered, evidence: `\`${bin} --help\` (${version}) lists no server, ACP, RPC or streamed-input mode` }
}

async function harnessCells(bridge: BridgeServer, harness: string, root: string, bin: string): Promise<Record<Verb, Cell>> {
  const model = harnessModel(harness)
  const cwd = await mkdtemp(join(root, `${harness}-`))
  const cells = {} as Record<Verb, Cell>
  const scriptedCall = (tool: string, args: Record<string, unknown>) => scriptedMcpCall(harness, tool, args)
  const guard = async (verb: Verb, run: () => Promise<Cell>) => {
    try { cells[verb] = await run() } catch (error) { cells[verb] = red(error instanceof Error ? error.message : String(error)) }
  }

  // A refused route is a seat or configuration fact for the whole row, not six failures.
  // A probe that never answers is the row's finding, not the end of the run for every later harness.
  const probe = await chat(bridge, model, cwd, SCRIPTED ? 'Reply with exactly OK' : 'Reply with OK only.', { session_id: marker(`${harness}-probe`) })
    .catch((error: unknown): Turn => ({ status: 0, text: '', error: { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) } }))
  if (probe.status === 0) {
    return Object.fromEntries(VERBS.map((verb) => [verb, red(`the first turn did not answer within ${TURN_MS} ms: ${(probe.error as { message?: string }).message ?? ''}`)])) as Record<Verb, Cell>
  }
  const refusal = probe.error as { type?: string; message?: string } | undefined
  if (probe.status === 403 && refusal?.type === 'subscription_required') {
    return Object.fromEntries(VERBS.map((verb) => [verb, { state: 'blocked', detail: `no subscription seat: ${refusal.message ?? ''}`.slice(0, 240) }])) as Record<Verb, Cell>
  }
  if (probe.status === 501 && /requires an explicit/u.test(refusal?.message ?? '')) {
    return Object.fromEntries(VERBS.map((verb) => [verb, { state: 'blocked', detail: `set CONFORMANCE_MODEL_${harness.toUpperCase().replace(/-/gu, '_')}: ${refusal?.message ?? ''}`.slice(0, 240) }])) as Record<Verb, Cell>
  }

  let toolTurn: Turn | undefined
  const nonceProfile = async () => {
    const server = join(cwd, 'nonce-mcp.cjs')
    await writeFile(server, nonceServer(cwd))
    return { name: 'conformance', mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }] } } }
  }
  await guard('tool', async () => {
    if (SCRIPTED) {
      const nonce = marker('nonce')
      toolTurn = await chat(bridge, model, cwd, scriptedCall('write_nonce', { nonce }), { session_id: marker(`${harness}-tool`), agent_profile: await nonceProfile() })
      if (toolTurn.status !== 200) return red(`HTTP ${toolTurn.status}: ${JSON.stringify(toolTurn.error)}`)
      const written = await readFile(join(cwd, `${nonce}.nonce`), 'utf8').catch(() => '')
      if (written !== nonce) return red(`the harness did not call write_nonce (no nonce file); reply: ${toolTurn.text}`)
      return toolTurn.text.includes(nonce) ? green('called write_nonce and reported its result') : red(`tool ran; reply lacks its result: ${toolTurn.text}`)
    }
    const value = marker('tool'), file = `${value}.txt`
    toolTurn = await chat(bridge, model, cwd, `Use your file tool to create the file ${file} in the current directory containing exactly ${value}. Then read it back with your file tool and reply with its exact contents only.`, { session_id: marker(`${harness}-tool`) })
    const written = await readFile(join(cwd, file), 'utf8').catch(() => '')
    if (toolTurn.status !== 200) return red(`HTTP ${toolTurn.status}: ${JSON.stringify(toolTurn.error)}`)
    if (written.trim() !== value) return red(`file ${written ? 'has other content' : 'not written'}; reply: ${toolTurn.text}`)
    return toolTurn.text.includes(value) ? green('wrote and read back') : red(`file written; reply lacks it: ${toolTurn.text}`)
  })

  // Every native session answers its own permission prompts (allow), as the unattended consumers ask;
  // on the scripted axis it also mounts the matrix's MCP server, whose wait_seconds the steer verb uses.
  const sessionId = marker(`${harness}-retained`)
  const created = await call(bridge, '/v1/sessions', { id: sessionId, model, cwd, interaction_policy: 'unattended-allow',
    ...(SCRIPTED ? { agent_profile: await nonceProfile() } : {}) })
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
    // Scripted: the second turn carries no instruction, so only the first turn's, sent along, answers it.
    const first = SCRIPTED ? `Reply with exactly ${word}` : 'Remember this codeword for later: ' + word + '. Reply with OK only.'
    const second = SCRIPTED ? 'Repeat your previous answer.' : 'What codeword did I give you earlier? Reply with the codeword only.'
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
    if (!native) {
      const cli = retainedModeEvidence(bin)
      return cli.offered ? red(`the Bridge has no native session for ${harness}, though the CLI offers one: ${nativeRefusal}`)
        : { state: 'unsupported', detail: `not supported by the CLI: ${cli.evidence}; retained and abort pass on its one-shot continuation` }
    }
    const word = marker('steered')
    const turn = await call(bridge, `/v1/sessions/${sessionId}/turns`, {
      message: SCRIPTED ? scriptedCall('wait_seconds', { seconds: 40 })
        : 'Count slowly from 1 to 200, one number per line, using your shell tool to sleep 1 second between numbers.',
      turn_id: `${sessionId}-steer`, run_id: `${sessionId}-steer-run`, execution_id: `${sessionId}-steer-execution`,
    })
    const body = await turn.json() as Record<string, any>
    if (turn.status >= 300) return red(`turn HTTP ${turn.status}`)
    // A steer names the exact run, whose six coordinates the run's status response carries as X-Run-* headers.
    const status = await call(bridge, `/v1/runs/${encodeURIComponent(String(body.run?.id))}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const run = { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'),
      environmentId: header('environment-id'), sessionId: header('session-id'), executionId: header('execution-id') }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    const steer = await call(bridge, `/v1/sessions/${sessionId}/steer`, { operationId: marker('steer-op'), run,
      message: SCRIPTED ? `Reply with exactly ${word}` : `Stop counting now and reply with ${word} only.` })
    if (steer.status >= 300) return red(`steer HTTP ${steer.status}: ${(await steer.text()).slice(0, 160)}`)
    const answer = await runText(bridge, String(body.run?.id))
    return answer.text.includes(word) ? green('steer applied') : red(`steer accepted, not applied: ${answer.text.slice(-160)}`)
  })

  // A steer that did not end its turn leaves it running; closing the session ends it before the next verb.
  if (native) await call(bridge, `/v1/sessions/${sessionId}/close`, {}).catch(() => undefined)

  await guard('abort', async () => {
    const session = marker(`${harness}-abort`), runId = marker(`${harness}-abort-run`)
    const controller = new AbortController()
    const slow = chat(bridge, model, cwd, SCRIPTED ? scriptedCall('wait_seconds', { seconds: 120 }) : 'Use your shell tool to run `sleep 120`, then reply DONE.',
      { session_id: session, run_id: runId, ...(SCRIPTED ? { agent_profile: await nonceProfile() } : {}) }, controller.signal).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    const cancelled = await call(bridge, `/v1/runs/${runId}/cancel?wait_ms=20000`, {})
    controller.abort()
    await slow
    if (cancelled.status >= 300) return red(`cancel HTTP ${cancelled.status}: ${(await cancelled.text()).slice(0, 160)}`)
    const word = marker('replaced')
    const next = await chat(bridge, model, cwd, SCRIPTED ? `Reply with exactly ${word}` : `Reply with ${word} only.`,
      { session_id: session, ...(SCRIPTED ? { agent_profile: await nonceProfile() } : {}) })
    return next.status === 200 && next.text.includes(word) ? green('cancelled, replacement answered') : red(`replacement HTTP ${next.status}: ${next.text || JSON.stringify(next.error)}`)
  })

  await guard('profile+mcp', async () => {
    if (SCRIPTED) {
      // The echo model ignores a system prompt, so only the profile's MCP server is observable here.
      const nonce = marker('profile')
      const turn = await chat(bridge, model, cwd, scriptedCall('write_nonce', { nonce }), { session_id: marker(`${harness}-profile`), agent_profile: await nonceProfile() })
      const written = await readFile(join(cwd, `${nonce}.nonce`), 'utf8').catch(() => '')
      return turn.status === 200 && written === nonce
        ? green('the profile\'s MCP server reached the harness (prompt text is not observable on the scripted model)')
        : red(`HTTP ${turn.status}: ${turn.text || JSON.stringify(turn.error)}`)
    }
    const prompted = marker('PROFILE'), token = marker('TOKEN')
    const server = join(cwd, 'token-mcp.cjs')
    await writeFile(server, tokenServer(token))
    // The codeword rides the strongest prompt intent the harness declares: a system-prompt replacement,
    // else instructions (a harness with neither still gets the replacement, and its refusal is the cell).
    const declared = await call(bridge, `/v1/capabilities?model=${encodeURIComponent(model)}`)
    const profileControls = declared.ok ? (await declared.json() as { profile?: { systemPrompt?: { replace?: boolean }; instructions?: boolean } }).profile : undefined
    const viaInstructions = profileControls?.systemPrompt?.replace === false && profileControls.instructions === true
    const standing = `Your codeword is ${prompted}. Whenever you are asked for your codeword, give exactly ${prompted}.`
    const turn = await chat(bridge, model, cwd, 'Call the conformance_token tool, then reply with the token it returns followed by your codeword.', {
      session_id: marker(`${harness}-profile`),
      agent_profile: {
        name: 'conformance',
        prompt: viaInstructions ? { instructions: [standing] } : { systemPrompt: standing },
        mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: server }] } },
      },
    })
    if (turn.status !== 200) return red(`HTTP ${turn.status}: ${JSON.stringify(turn.error)}`)
    const missing = [turn.text.includes(token) ? '' : 'MCP token', turn.text.includes(prompted) ? '' : 'profile prompt'].filter(Boolean)
    const channel = viaInstructions ? 'prompt.instructions (the harness declares no system-prompt replacement)' : 'prompt.systemPrompt'
    return missing.length === 0 ? green(`${channel} and MCP tool reached the harness`) : red(`missing ${missing.join(' and ')} (${channel}): ${turn.text}`)
  })

  await guard('usage+outcome', async () => {
    if (SCRIPTED) {
      const word = marker('usage')
      const turn = await chat(bridge, model, cwd, `Reply with exactly ${word}\nReport usage ${USAGE.prompt} ${USAGE.completion}`, { session_id: marker(`${harness}-usage`) })
      const usage = (turn.usage ?? {}) as Record<string, unknown>
      if (turn.status !== 200) return red(`HTTP ${turn.status}: ${JSON.stringify(turn.error)}`)
      if (usage.prompt_tokens !== USAGE.prompt || usage.completion_tokens !== USAGE.completion) {
        return red(`usage ${JSON.stringify(usage).slice(0, 120)} is not the scripted ${USAGE.prompt}/${USAGE.completion}`)
      }
      const refused = await chat(bridge, `${harness}/conformance-no-such-model`, cwd, 'Reply OK.', { session_id: marker(`${harness}-refused`) })
      const typed = refused.status >= 400 ? Boolean((refused.error as any)?.type ?? (refused.error as any)?.code) : refused.finish === 'error'
      return typed ? green(`scripted usage ${USAGE.prompt}/${USAGE.completion} exact; unknown model refused typed`) : red(`unknown model not refused typed: HTTP ${refused.status}`)
    }
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
  if (SCRIPTED) process.env.ENABLE_TOOL_SEARCH ??= 'false'
  const root = await mkdtemp(join(tmpdir(), 'bridge-conformance-'))
  const config = loadConfig({ ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
    BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: rows.map((row) => row.name).join(',') })
  const matrix: Record<string, Record<Verb, Cell>> = {}
  const bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  let shutdown: string | undefined
  try {
    for (const row of rows) {
      const bin = (config as unknown as Record<string, string>)[`${row.name}Bin`] ?? row.name
      const blocked = seat(row.name, row.harness, bin)
      matrix[row.harness] = blocked
        ? Object.fromEntries(VERBS.map((verb) => [verb, blocked])) as Record<Verb, Cell>
        : await harnessCells(bridge, row.harness, root, bin)
      console.error(`[conformance] ${row.harness} (${AXIS}): ${VERBS.map((verb) => `${verb}=${matrix[row.harness]![verb].state}`).join(' ')}`)
    }
  } finally {
    // A Bridge that cannot confirm its own resources closed is a finding of the run, not a reason to lose its cells.
    await bridge.close().catch((error: unknown) => {
      shutdown = error instanceof AggregateError ? `${error.message}: ${error.errors.map((inner) => String(inner?.message ?? inner)).join('; ')}`
        : error instanceof Error ? error.message : String(error)
    })
    await rm(root, { recursive: true, force: true })
  }
  const mark = { green: 'green', red: 'RED', unsupported: 'unsupported', blocked: 'blocked' } as const
  console.log(`axis: ${AXIS_TEXT}\n\n| harness | axis | ${VERBS.join(' | ')} |\n|---|---|${VERBS.map(() => '---').join('|')}|`)
  for (const [harness, cells] of Object.entries(matrix)) console.log(`| ${harness} | ${AXIS} | ${VERBS.map((verb) => mark[cells[verb].state]).join(' | ')} |`)
  for (const [harness, cells] of Object.entries(matrix)) {
    for (const verb of VERBS) if (cells[verb].state === 'red') console.log(`RED ${harness} ${verb}: ${cells[verb].detail}`)
  }
  if (shutdown) console.log(`RED bridge shutdown: ${shutdown}`)
  const json = flag('--json')
  if (json) await writeFile(json, JSON.stringify({ at: new Date().toISOString(), axis: AXIS, models: Object.fromEntries(rows.map((row) => [row.harness, harnessModel(row.harness)])), matrix, ...(shutdown ? { shutdown } : {}) }, null, 2))
  const counts = Object.values(matrix).flatMap((cells) => Object.values(cells)).reduce((sum, cell) => ({ ...sum, [cell.state]: (sum[cell.state] ?? 0) + 1 }), {} as Record<string, number>)
  console.log(`\ncells: ${JSON.stringify(counts)}`)
  process.exitCode = (counts.red ?? 0) > 0 || shutdown ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 2 })
