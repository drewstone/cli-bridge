import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

/**
 * A stand-in `claude` started by a profile turn: it calls the caller's tool through the MCP server the Bridge mounted,
 * then answers with the system prompt it was started with and the tool's result.
 */
const harness = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('profile-route-peer 1.0'); process.exit(0) }
async function main() {
  const argv = process.argv.slice(2)
  const prompt = argv.includes('--system-prompt') ? argv[argv.indexOf('--system-prompt') + 1] : 'no profile prompt'
  const appended = argv.includes('--append-system-prompt') ? argv[argv.indexOf('--append-system-prompt') + 1] : 'nothing appended'
  const caller = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.caller
  if (!caller || !caller.url) throw new Error('no caller MCP server')
  const rpc = async (id, method, params) => (await (await fetch(caller.url, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json()).result
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'profile-route-native' }))
  await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'peer', version: '1' } })
  const listed = await rpc(2, 'tools/list', {})
  if (!listed.tools.some((tool) => tool.name === 'lookup_owner')) throw new Error('the caller tool was not listed')
  const result = await rpc(3, 'tools/call', { name: 'lookup_owner', arguments: { id: 'A-17' } })
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_done', content: [{ type: 'text', text: prompt + ' / ' + result.content[0].text + ' / ' + appended }] } }))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'profile-route-native', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }))
}
main().catch((error) => { console.error('profile-route peer failed: ' + error.message); process.exitCode = 1 })
`

const tools = [{ type: 'function', function: { name: 'lookup_owner', description: 'Look up the owner of a CRM account',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }]

it('a base-URL-only caller reaches a cataloged profile at /profiles/<id>/v1: the profile drives the harness and caller tools round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-route-'))
  const binary = join(root, 'claude')
  await writeFile(binary, harness)
  await chmod(binary, 0o755)
  const profiles = join(root, 'profiles')
  await mkdir(profiles)
  const server = await startServer({ cwd: root, quiet: true, handleSignals: false,
    config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', BRIDGE_JAIL_MODE: 'off',
      CLAUDE_BIN: binary, SANDBOX_PROFILES_DIR: profiles }), port: 0 } })
  try {
    // Written after start: the route rereads the catalog for an id it does not know.
    await writeFile(join(profiles, 'bench-app.json'), JSON.stringify({ name: 'bench-app', prompt: { systemPrompt: 'You are the bench app.' } }))
    const base = `${server.url}/profiles/bench-app/v1`
    const post = (url: string, body: unknown) => fetch(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    // A runner's own system message, which the chat route refuses beside a profile, joins the profile prompt instead.
    const user = { role: 'user', content: 'Who owns account A-17?' }
    const system = { role: 'system', content: [{ type: 'text', text: 'Answer with the owner only.' }] }

    const first = await post(base, { model: 'claude-code/test', messages: [system, user], tools })
    const firstText = await first.text()
    expect(first.status, firstText).toBe(200)
    const asked = JSON.parse(firstText) as { choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }> }
    expect(asked.choices[0]!.finish_reason).toBe('tool_calls')
    const call = asked.choices[0]!.message.tool_calls![0]!
    expect(call.function.name).toBe('lookup_owner')
    expect(JSON.parse(call.function.arguments)).toEqual({ id: 'A-17' })

    const second = await post(base, { model: 'claude-code/test', tools, messages: [system, user,
      { role: 'assistant', content: asked.choices[0]!.message.content, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'Dana Reyes' }] })
    const secondText = await second.text()
    expect(second.status, secondText).toBe(200)
    const done = JSON.parse(secondText) as { choices: Array<{ finish_reason: string; message: { content: string | null } }> }
    expect(done.choices[0]!.finish_reason).toBe('stop')
    expect(done.choices[0]!.message.content).toContain('You are the bench app. / Dana Reyes / ')
    expect(done.choices[0]!.message.content).toContain('Answer with the owner only.')

    const missing = await post(`${server.url}/profiles/no-such-app/v1`, { model: 'claude-code/test', messages: [user] })
    expect(missing.status).toBe(404)
    const doubled = await post(base, { model: 'claude-code/test', messages: [user], agent_profile: { name: 'other' } })
    expect(doubled.status).toBe(400)
    expect(await doubled.text()).toContain('applies the cataloged profile bench-app')
    const image = await post(base, { model: 'claude-code/test', messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }, user] })
    expect(image.status).toBe(400)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
