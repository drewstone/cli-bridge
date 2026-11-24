import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

/** A stand-in `claude` that answers with what reached it: the question, the instructions, and the profile prompt. */
const harness = String.raw`#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('responses-peer 1.0'); process.exit(0) }
const argv = process.argv.slice(2).join('\n')
const saw = (text) => argv.includes(text) ? 'yes' : 'no'
const text = 'question ' + saw('What is six times seven?') + ', instructions ' + saw('Answer with a number.') + ', profile ' + saw('You are the bench app.')
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'responses-peer' }))
console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text }] } }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'responses-peer', usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0 }))
`

it('a Responses-only caller gets the chat route\'s answer as output_text, on /v1 and on a cataloged profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'responses-route-'))
  const binary = join(root, 'claude')
  await writeFile(binary, harness)
  await chmod(binary, 0o755)
  const profiles = join(root, 'profiles')
  await mkdir(profiles)
  await writeFile(join(profiles, 'bench-app.json'), JSON.stringify({ name: 'bench-app', prompt: { systemPrompt: 'You are the bench app.' } }))
  const server = await startServer({ cwd: root, quiet: true, handleSignals: false,
    config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', BRIDGE_JAIL_MODE: 'off',
      CLAUDE_BIN: binary, SANDBOX_PROFILES_DIR: profiles }), port: 0 } })
  try {
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const request = { model: 'claude-code/test', instructions: 'Answer with a number.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is six times seven?' }] }] }
    type Answer = { object: string; status: string; output: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>; usage: { total_tokens: number } }

    const plain = await post('/v1/responses', request)
    const plainText = await plain.text()
    expect(plain.status, plainText).toBe(200)
    const answer = JSON.parse(plainText) as Answer
    expect(answer.object).toBe('response')
    expect(answer.status).toBe('completed')
    expect(answer.output[0]!.content[0]).toMatchObject({ type: 'output_text', text: 'question yes, instructions yes, profile no' })

    // The same request on a cataloged profile: the instructions join the profile prompt, as on /profiles/<id>/v1/chat/completions.
    const profiled = await post('/profiles/bench-app/v1/responses', request)
    const profiledText = await profiled.text()
    expect(profiled.status, profiledText).toBe(200)
    expect((JSON.parse(profiledText) as Answer).output[0]!.content[0]!.text).toBe('question yes, instructions yes, profile yes')

    const tools = await post('/v1/responses', { ...request, tools: [{ type: 'web_search' }] })
    expect(tools.status).toBe(400)
    expect(await tools.text()).toContain('does not run tools')
    const stringInput = await post('/v1/responses', { model: 'claude-code/test', input: 'What is six times seven?' })
    expect(stringInput.status).toBe(200)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
