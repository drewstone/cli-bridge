import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

/**
 * A stand-in `claude` that does what a harness does with an MCP tool: it says something, calls the caller's tool through the
 * MCP server the Bridge mounted, waits for the answer, and finishes with text that uses it. The MCP call blocks while the Bridge
 * holds it for the caller, so one harness turn spans both caller requests.
 */
const harness = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('caller-tools-peer 1.0'); process.exit(0) }
const say = (text) => console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_' + Math.random(), content: [{ type: 'text', text }] } }))
async function main() {
  const argv = process.argv.slice(2)
  const servers = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers
  const caller = servers.caller
  if (!caller || !caller.url) throw new Error('no caller MCP server')
  const rpc = async (id, method, params) => {
    const response = await fetch(caller.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    return (await response.json()).result
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'caller-tools-native' }))
  await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'peer', version: '1' } })
  const listed = await rpc(2, 'tools/list', {})
  const tool = listed.tools.find((entry) => entry.name === 'record_answer')
  if (!tool || tool.inputSchema.required[0] !== 'value') throw new Error('the caller tool was not listed with its schema')
  say('before the tool. ')
  const result = await rpc(3, 'tools/call', { name: 'record_answer', arguments: { value: '42' } })
  say('tool said: ' + result.content[0].text)
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'caller-tools-native', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }))
}
main().catch((error) => { console.error('caller-tools peer failed: ' + error.message); process.exitCode = 1 })
`

const tools = [{ type: 'function', function: { name: 'record_answer', description: 'Record the answer',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }]

it('a harness turn calls the caller\'s tool: the Bridge answers tool_calls, then resumes the same turn from the tool result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caller-tools-'))
  const binary = join(root, 'claude')
  await writeFile(binary, harness)
  await chmod(binary, 0o755)
  const server = await startServer({ cwd: root, quiet: true, handleSignals: false,
    config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', BRIDGE_JAIL_MODE: 'off', CLAUDE_BIN: binary }), port: 0 } })
  try {
    const post = (body: unknown) => fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const user = { role: 'user', content: 'Record the answer with the tool.' }

    const first = await post({ model: 'claude-code/test', messages: [user], tools })
    const firstText = await first.text()
    expect(first.status, firstText).toBe(200)
    const asked = JSON.parse(firstText) as { choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }> }
    expect(asked.choices[0]!.finish_reason).toBe('tool_calls')
    const call = asked.choices[0]!.message.tool_calls![0]!
    expect(call.type).toBe('function')
    expect(call.function.name).toBe('record_answer')
    expect(JSON.parse(call.function.arguments)).toEqual({ value: '42' })
    expect(asked.choices[0]!.message.content).toContain('before the tool')
    expect(firstText).not.toContain('/caller-tools/')

    const second = await post({ model: 'claude-code/test', tools, messages: [user,
      { role: 'assistant', content: asked.choices[0]!.message.content, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'stored 42' }] })
    const secondText = await second.text()
    expect(second.status, secondText).toBe(200)
    const done = JSON.parse(secondText) as { choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: unknown[] } }> }
    expect(done.choices[0]!.finish_reason).toBe('stop')
    expect(done.choices[0]!.message.content).toContain('tool said: stored 42')
    expect(done.choices[0]!.message.tool_calls).toBeUndefined()

    // Caller tools and a text-only turn contradict each other: refused before any harness starts.
    const stale = await post({ model: 'claude-code/test', tools: [{ type: 'function', function: { name: 'record_answer' } }], tool_choice: 'none', messages: [user] })
    expect(stale.status).toBe(400)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
