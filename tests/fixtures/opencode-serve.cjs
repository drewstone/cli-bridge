// A stand-in `opencode serve` speaking the v1 HTTP API the Bridge's native session uses, with the
// loop semantics measured on opencode 1.19.6: a prompt admits its user message at once; a message
// posted while the loop runs is answered at the loop's next step, in the same busy period; abort
// ends the loop with MessageAbortedError; a permission prompt waits on /permission/:id/reply.
// The scripted model reads the last user message: `wait <s>` runs a tool for s seconds,
// `write <file>` asks permission to write it, `remember <word>` and `recall` span turns.
// Every request is appended to opencode-fixture.log in the server's working directory, one JSON line.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

if (process.argv.includes('--version')) { console.log('1.19.6'); process.exit(0) }
if (process.argv[2] !== 'serve') { console.error('fixture: only serve'); process.exit(2) }

const log = (entry) => fs.appendFileSync(path.join(process.cwd(), 'opencode-fixture.log'), `${JSON.stringify(entry)}\n`)
const auth = process.env.OPENCODE_SERVER_PASSWORD
  ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
  : null
const clients = new Set()
const sessions = new Map()
let counter = 0
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(12, '0')}`
const emit = (type, properties) => {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`
  for (const client of clients) client.write(frame)
}
const sleep = (ms, session) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  session.stop = () => { clearTimeout(timer); resolve() }
})

function message(session, role, parentID, text) {
  const info = { id: nextId('msg'), sessionID: session.id, role, time: { created: Date.now() },
    ...(role === 'assistant' ? { parentID, modelID: session.model?.modelID ?? 'default', providerID: session.model?.providerID ?? 'fixture' } : {}) }
  session.messages.push({ info, parts: [], text })
  emit('message.updated', { info })
  return info
}

function part(session, info, value) {
  const entry = { id: nextId('prt'), sessionID: session.id, messageID: info.id, ...value }
  session.messages.find((m) => m.info.id === info.id).parts.push(entry)
  emit('message.part.updated', { part: entry })
  return entry
}

async function answer(session, parent, text) {
  const info = message(session, 'assistant', parent.info.id)
  part(session, info, { type: 'step-start' })
  const textPart = part(session, info, { type: 'text', text: '' })
  const half = Math.ceil(text.length / 2)
  for (const delta of [text.slice(0, half), text.slice(half)]) {
    emit('message.part.delta', { sessionID: session.id, messageID: info.id, partID: textPart.id, field: 'text', delta })
  }
  emit('message.part.updated', { part: { ...textPart, text } })
  part(session, info, { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 11, output: 3, reasoning: 0, cache: { read: 2, write: 0 } } })
  emit('message.updated', { info: { ...info, finish: 'stop', time: { ...info.time, completed: Date.now() } } })
  parent.answered = true
}

async function tool(session, parent, name, input, run) {
  const info = message(session, 'assistant', parent.info.id)
  part(session, info, { type: 'step-start' })
  const callID = `call_${counter}`
  const toolPart = part(session, info, { type: 'tool', callID, tool: name, state: { status: 'running', input } })
  const outcome = await run(info, callID)
  if (session.aborted) return
  emit('message.part.updated', { part: { ...toolPart, state: { status: outcome.error ? 'error' : 'completed', input, ...outcome } } })
  part(session, info, { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })
  emit('message.updated', { info: { ...info, finish: 'tool-calls', time: { ...info.time, completed: Date.now() } } })
  return outcome
}

async function loop(session) {
  session.running = true
  session.aborted = false
  emit('session.status', { sessionID: session.id, status: { type: 'busy' } })
  while (!session.aborted) {
    const last = [...session.messages].reverse().find((m) => m.info.role === 'user')
    if (!last || last.answered) break
    const text = last.text
    let match
    if ((match = /^wait (\d+)/u.exec(text))) {
      const outcome = await tool(session, last, 'bash', { command: `sleep ${match[1]}` }, async () => {
        await sleep(Number(match[1]) * 1000, session)
        return { output: 'slept' }
      })
      // The loop's next step answers the latest user message: a steer posted meanwhile, or this one.
      if (outcome && !session.aborted && [...session.messages].reverse().find((m) => m.info.role === 'user') === last) await answer(session, last, 'waited')
    } else if ((match = /^write (\S+)/u.exec(text))) {
      const file = match[1]
      let reply
      await tool(session, last, 'write', { filePath: file }, async (info, callID) => {
        const id = nextId('per')
        reply = await new Promise((resolve) => {
          session.permission = { id, resolve }
          emit('permission.asked', { id, sessionID: session.id, permission: 'edit', patterns: [file], metadata: { filepath: file },
            always: ['*'], tool: { messageID: info.id, callID } })
        })
        if (reply !== 'once') return { error: 'The user rejected permission to use this specific tool call.' }
        fs.writeFileSync(path.join(process.cwd(), file), 'written')
        return { output: 'wrote' }
      })
      if (!session.aborted) await answer(session, last, reply === 'once' ? 'WROTE' : 'REFUSED')
    } else if ((match = /^remember (\S+)/u.exec(text))) {
      await answer(session, last, 'OK')
    } else if (/^recall/u.test(text)) {
      const remembered = session.messages.map((m) => /^remember (\S+)/u.exec(m.text ?? '')?.[1]).filter(Boolean).at(-1)
      await answer(session, last, `you said ${remembered ?? 'nothing'}`)
    } else {
      await answer(session, last, `ECHO(${text})`)
    }
  }
  session.running = false
  emit('session.status', { sessionID: session.id, status: { type: 'idle' } })
  emit('session.idle', { sessionID: session.id })
}

const body = (req) => new Promise((resolve) => {
  let text = ''
  req.on('data', (chunk) => { text += chunk })
  req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}) } catch { resolve({}) } })
})
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  const input = req.method === 'POST' ? await body(req) : undefined
  log({ method: req.method, path: url.pathname, query: url.search, body: input, authorized: !auth || req.headers.authorization === auth })
  if (auth && req.headers.authorization !== auth) return json(res, 401, { error: 'unauthorized' })
  let match
  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    clients.add(res)
    req.on('close', () => clients.delete(res))
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    return
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    const session = { id: nextId('ses'), messages: [], running: false, title: input.title, permission: input.permission }
    sessions.set(session.id, session)
    emit('session.created', { info: { id: session.id, title: input.title } })
    return json(res, 200, { id: session.id, title: input.title })
  }
  if ((match = /^\/session\/([^/]+)(\/.*)?$/u.exec(url.pathname))) {
    const session = sessions.get(decodeURIComponent(match[1]))
    if (!session) return json(res, 404, { name: 'NotFoundError' })
    const rest = match[2] ?? ''
    if (req.method === 'GET' && rest === '') return json(res, 200, { id: session.id })
    if (req.method === 'GET' && rest === '/message') {
      const limit = Number(url.searchParams.get('limit') ?? session.messages.length)
      return json(res, 200, session.messages.slice(-limit).map((m) => ({ info: m.info, parts: m.parts })))
    }
    if (req.method === 'POST' && rest === '/prompt_async') {
      session.model = input.model ?? session.model
      const text = input.parts?.[0]?.text ?? ''
      res.writeHead(204).end()
      const info = message(session, 'user', undefined, text)
      part(session, info, { type: 'text', text })
      if (!session.running) void loop(session)
      return
    }
    if (req.method === 'POST' && rest === '/abort') {
      if (session.running) {
        session.aborted = true
        session.stop?.()
        session.permission?.resolve('reject')
        emit('session.error', { sessionID: session.id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } })
      }
      return json(res, 200, true)
    }
  }
  if (req.method === 'POST' && (match = /^\/permission\/([^/]+)\/reply$/u.exec(url.pathname))) {
    const session = [...sessions.values()].find((s) => s.permission?.id === match[1])
    if (!session) return json(res, 404, { name: 'NotFoundError' })
    const pending = session.permission
    session.permission = null
    emit('permission.replied', { sessionID: session.id, requestID: pending.id, reply: input.reply })
    pending.resolve(input.reply)
    return json(res, 200, true)
  }
  json(res, 404, { name: 'NotFoundError' })
})

server.listen(0, '127.0.0.1', () => {
  log({ listening: server.address().port, pid: process.pid })
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`)
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0))
