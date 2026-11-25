// A stand-in `codex app-server --listen stdio://` speaking the JSON-RPC subset the Bridge's native session uses,
// with the semantics measured on Codex 0.169.0: `turn/steer` is accepted at once and applied after the running
// tool call, as a `userMessage` item carrying the steer's `clientUserMessageId`; under approval policy `untrusted`
// a command asks `item/commandExecution/requestApproval` and an MCP tool call asks `mcpServer/elicitation/request`;
// `turn/interrupt` ends the turn `interrupted`. The scripted model reads the turn's last user message:
// `wait <s>` runs the MCP tool wait_seconds for s seconds, `run <file>` asks approval for a command that writes it,
// `mcp <nonce>` asks approval for an MCP tool call, `commit <file> [branch]` commits a new file in the working
// repository and pushes it to `branch` of origin, `remember <word>` and `recall` span turns.
// Launch arguments, the effective config and every request are appended to codex-fixture.log in the working
// directory, one JSON line each; the Router key is logged only as present or absent.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')

if (process.argv.includes('--version')) { console.log('codex-cli 0.169.0'); process.exit(0) }
if (!process.argv.includes('app-server')) { console.error('fixture: only app-server'); process.exit(2) }

const log = (entry) => fs.appendFileSync(path.join(process.cwd(), 'codex-fixture.log'), `${JSON.stringify(entry)}\n`)
const home = process.env.CODEX_HOME || ''
const config = home && fs.existsSync(path.join(home, 'config.toml')) ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : ''
log({ launched: true, pid: process.pid, argv: process.argv.slice(2), codexHome: home, mcpServers: [...config.matchAll(/^\[mcp_servers\.([\w-]+)\]/gmu)].map((m) => m[1]),
  authFile: Boolean(home) && fs.existsSync(path.join(home, 'auth.json')), routerKey: Boolean(process.env.TANGLE_API_KEY) })

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const threads = new Map() // id -> { memory }
const answers = new Map() // server request id -> resolve
let nextServerRequest = 0
let active = null // { threadId, turnId, steers: [], stop }

const ask = (method, params) => new Promise((resolve) => {
  const id = nextServerRequest++
  answers.set(id, resolve)
  send({ id, method, params })
})
const item = (threadId, turnId, value, started = true) => notify(started ? 'item/started' : 'item/completed', { item: value, threadId, turnId })
const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  active.stop = () => { clearTimeout(timer); resolve() }
})

async function runTurn(threadId, turnId, text) {
  const thread = threads.get(threadId)
  const usage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
  const call = (inputTokens, cached, output) => {
    const last = { totalTokens: inputTokens + output, inputTokens, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 }
    for (const key of Object.keys(usage)) usage[key] += last[key]
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { ...usage }, last, modelContextWindow: 1000 } })
  }
  let reply
  const [verb, arg, branch] = text.split(/\s+/u)
  if (verb === 'wait') {
    const id = `call_${randomUUID()}`
    const tool = { type: 'mcpToolCall', id, server: 'conformance', tool: 'wait_seconds', status: 'inProgress', arguments: { seconds: Number(arg) }, result: null, error: null }
    item(threadId, turnId, tool)
    call(10, 0, 2)
    await sleep(Number(arg) * 1000)
    if (active.interrupted) return
    item(threadId, turnId, { ...tool, status: 'completed', result: { content: [{ type: 'text', text: 'waited' }] } }, false)
    const steer = active.steers.shift()
    if (steer) {
      // The steer reaches the model after the tool call, as its own user message of this turn.
      const message = { type: 'userMessage', id: randomUUID(), clientId: steer.clientId, content: steer.input }
      item(threadId, turnId, message)
      item(threadId, turnId, message, false)
      reply = `ECHO(${steer.input[0].text})`
    } else reply = 'waited'
  } else if (verb === 'run') {
    const id = `call_${randomUUID()}`
    const command = `/bin/bash -lc 'touch ${arg}'`
    const execution = { type: 'commandExecution', id, command, cwd: process.cwd(), status: 'inProgress', aggregatedOutput: null, exitCode: null }
    item(threadId, turnId, execution)
    const answer = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId, turnId, itemId: id, command, cwd: process.cwd(),
      availableDecisions: ['accept', 'decline', 'cancel'] })
    log({ approval: 'command', answer })
    const accepted = answer.decision === 'accept'
    if (accepted) fs.writeFileSync(path.join(process.cwd(), arg), 'written')
    item(threadId, turnId, { ...execution, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null }, false)
    reply = accepted ? 'RAN' : 'REFUSED'
  } else if (verb === 'mcp') {
    const id = `call_${randomUUID()}`
    const tool = { type: 'mcpToolCall', id, server: 'conformance', tool: 'write_nonce', status: 'inProgress', arguments: { nonce: arg }, result: null, error: null }
    item(threadId, turnId, tool)
    const answer = await ask('mcpServer/elicitation/request', { threadId, turnId, serverName: 'conformance', mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'write_nonce', tool_params: { nonce: arg } },
      message: 'Allow the conformance MCP server to run tool "write_nonce"?', requestedSchema: { type: 'object', properties: {} } })
    log({ approval: 'mcp', answer })
    const accepted = answer.action === 'accept'
    item(threadId, turnId, { ...tool, status: accepted ? 'completed' : 'failed', result: accepted ? { content: [{ type: 'text', text: `nonce ${arg} written` }] } : null,
      error: accepted ? null : { message: 'user rejected MCP tool call' } }, false)
    reply = accepted ? `Tool write_nonce returned: nonce ${arg} written` : 'REFUSED'
  } else if (verb === 'commit') {
    // `commit <file> [branch]`: commit a new file in the working repository and push it to `branch` of origin.
    const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: process.cwd(), stdio: 'ignore' })
    fs.writeFileSync(path.join(process.cwd(), arg), `${arg}\n`)
    git('add', arg)
    git('commit', '-m', `fixture ${arg}`)
    if (branch) git('push', 'origin', `HEAD:refs/heads/${branch}`)
    reply = 'COMMITTED'
  } else if (verb === 'remember') {
    thread.memory = arg
    reply = 'OK'
  } else if (verb === 'recall') {
    reply = `you said ${thread.memory}`
  } else reply = `ECHO(${text})`
  const message = { type: 'agentMessage', id: `msg_${randomUUID()}`, text: '' }
  item(threadId, turnId, message)
  const half = Math.ceil(reply.length / 2)
  for (const delta of [reply.slice(0, half), reply.slice(half)]) notify('item/agentMessage/delta', { threadId, turnId, itemId: message.id, delta })
  item(threadId, turnId, { ...message, text: reply }, false)
  call(13, 2, 3)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  log({ method: request.method ?? null, id: request.id ?? null, params: request.params ?? null, result: request.result ?? null })
  if (request.method === undefined && answers.has(request.id)) {
    const resolve = answers.get(request.id)
    answers.delete(request.id)
    notify('serverRequest/resolved', { threadId: active?.threadId, requestId: request.id })
    resolve(request.result ?? { decision: 'cancel', action: 'cancel' })
    return
  }
  const reply = (result) => send({ id: request.id, result })
  const refuse = (message) => send({ id: request.id, error: { code: -32600, message } })
  const params = request.params ?? {}
  switch (request.method) {
    case 'initialize': return reply({ userAgent: 'fixture/0.169.0', codexHome: home, platformFamily: 'unix', platformOs: 'linux' })
    case 'initialized': return undefined
    case 'thread/start': {
      const id = randomUUID()
      threads.set(id, { memory: null })
      reply({ thread: { id, cwd: params.cwd } })
      return notify('thread/started', { thread: { id } })
    }
    case 'thread/resume': {
      if (!threads.has(params.threadId)) return refuse(`no rollout found for thread id ${params.threadId}`)
      return reply({ thread: { id: params.threadId } })
    }
    case 'turn/start': {
      if (active) return refuse('a turn is already running')
      const turnId = randomUUID()
      active = { threadId: params.threadId, turnId, steers: [], stop: () => {} }
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      const prompt = { type: 'userMessage', id: randomUUID(), clientId: null, content: params.input }
      item(params.threadId, turnId, prompt)
      item(params.threadId, turnId, prompt, false)
      const turn = active
      void runTurn(params.threadId, turnId, String(params.input?.[0]?.text ?? '')).then(() => {
        notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, items: [], status: turn.interrupted ? 'interrupted' : 'completed', error: null } })
        if (active === turn) active = null
      })
      return undefined
    }
    case 'turn/steer': {
      if (!active || active.turnId !== params.expectedTurnId) return refuse('no active turn to steer')
      active.steers.push({ clientId: params.clientUserMessageId, input: params.input })
      return reply({ turnId: active.turnId })
    }
    case 'turn/interrupt': {
      if (!active || active.turnId !== params.turnId) return refuse('no active turn')
      active.interrupted = true
      active.stop()
      return reply({})
    }
    default: return refuse(`fixture: ${request.method} is not implemented`)
  }
})
