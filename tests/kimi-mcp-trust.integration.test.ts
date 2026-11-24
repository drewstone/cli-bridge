/**
 * Kimi Code loads a project's `.kimi-code/mcp.json` only in a trusted workspace, and skips it with a
 * warning otherwise. The Bridge mounts a turn's MCP servers in that file, so a turn that names MCP
 * must reach Kimi with the file present and the workspace trusted; a turn without MCP changes
 * nothing. A real process records what Kimi would see at launch; no model is called.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KimiBackend } from '../src/backends/kimi.js'
import type { ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'

describe('a Kimi Code turn that names MCP servers', () => {
  let root: string
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'kimi-mcp-trust-')) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const run = async (name: string, mcp: boolean) => {
    const cwd = await mkdtemp(join(root, `${name}-`))
    const record = join(cwd, 'launch.json')
    const bin = join(cwd, 'kimi.cjs')
    await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
if (process.argv.includes('--version')) { console.log('kimi version 2.7.2'); process.exit(0) }
const file = path.join(process.cwd(), '.kimi-code', 'mcp.json')
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  trust: process.env.KIMI_CODE_TRUST_WORKSPACE ?? null,
  servers: fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {}) : null,
}))
for (const line of [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { type: 'result', usage: { input_tokens: 2, output_tokens: 1 } }]) console.log(JSON.stringify(line))
`, { mode: 0o700 })
    const request: ChatRequest = {
      model: 'kimi-code/kimi-for-coding', mode: 'byob', cwd,
      messages: [{ role: 'user', content: 'call the tool' }],
      ...(mcp ? { mcp: { mcpServers: { conformance: { type: 'stdio', command: process.execPath, args: ['-e', ''] } } } } : {}),
    }
    const backend = new KimiBackend({ bin, timeoutMs: 10_000, spawner: hostSpawner })
    for await (const _delta of backend.chat(request, null, new AbortController().signal)) { /* drain */ }
    return JSON.parse(await readFile(record, 'utf8')) as { trust: string | null; servers: string[] | null }
  }

  it('reaches Kimi with its MCP file mounted and the workspace trusted', async () => {
    expect(await run('mcp', true)).toEqual({ trust: '1', servers: ['conformance'] })
  }, 30_000)

  it('leaves trust alone for a turn without MCP', async () => {
    expect(await run('plain', false)).toEqual({ trust: null, servers: null })
  }, 30_000)
})
