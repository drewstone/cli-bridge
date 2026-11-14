/** Real HTTP Bridge in the tangle CLI's embedded shape, real codex app-server child, real private-MCP redaction. No inference. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import { loadConfig, startServer } from '../src/server.js'

// A codex that keeps its app-server open between requests, as the real one does, and answers one line per request.
const codex = String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.164.0');process.exit(0)}
if(process.argv.includes('app-server')){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
  const result=r.method==='config/read'?{config:{model_provider:'openai',model:'probe-fixture'},origins:{}}:r.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:r.id,result})+'\n');
  // The probe's last request: record the span from this process's start to its answer.
  if(r.method==='account/read')fs.appendFileSync('app-server-probe-ms',Math.round(Date.now()-performance.timeOrigin)+'\n')});
}else if(process.argv.includes('exec')){
 const id='00000000-0000-4000-8000-0000000000'+String(Date.now()%100).padStart(2,'0');
 for(const event of [{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:'probe-answered'}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}])console.log(JSON.stringify(event));
}else process.exit(2)
`

it.skipIf(!new LinuxBwrapJail().isAvailable())('a subscriptions-only codex probe answers in under 2 s when the run carries a private MCP secret', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-probe-private-mcp-'))), cwd = join(root, 'workspace')
  await mkdir(cwd)
  const bin = join(cwd, 'codex.cjs')
  await writeFile(bin, `#!${process.execPath}\n${codex}`, { mode: 0o700 })
  const tool = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"jsonrpc":"2.0","id":1,"result":{}}') })
  await new Promise<void>((resolve) => tool.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(tool.address() as { port: number }).port}/mcp`
  // The tangle CLI's embedded Bridge configuration (agent-container graph.ts).
  const config = { ...loadConfig({ HOME: root, PATH: process.env.PATH, BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: 'probe', BRIDGE_DATA_DIR: join(root, 'bridge'),
    BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: 'relay',
    BRIDGE_SUBSCRIPTIONS_ONLY: '1', BRIDGE_TRACE: 'off' }), port: 0 }
  const server = await startServer({ config, cwd, quiet: true, handleSignals: false,
    mcpSecrets: { async get(key) { return key === 'tool' ? 'private-tool-token-5f0c2b7e9a14d3c8' : undefined } } })
  const lifetime = new AbortController()
  try {
    const elapsed: number[] = []
    for (let run = 0; run < 5; run++) {
      server.registerPrivateMcpEndpoint({ runId: `probe-run-${run}`, url, paths: { '': ['POST', 'GET', 'DELETE'] }, signal: lifetime.signal })
      const started = performance.now()
      const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer probe' },
        body: JSON.stringify({ model: 'codex/probe-fixture', run_id: `probe-run-${run}`, session_id: `probe-${run}`, cwd, messages: [{ role: 'user', content: 'answer' }],
          agent_profile: { name: 'probe-fixture', harness: 'codex', model: { provider: 'openai', default: 'probe-fixture' } },
          runtime_attachments: { mcp: { custom: { transport: 'http', url, headers: { Authorization: { kind: 'secret-ref', key: 'tool', format: 'bearer' } } } } } }) })
      const text = await response.text()
      elapsed.push(Math.round(performance.now() - started))
      expect(response.status, text).toBe(200)
      expect(text).toContain('probe-answered')
    }
    const probes = (await readFile(join(cwd, 'app-server-probe-ms'), 'utf8')).split('\n').filter(Boolean).map(Number)
    console.log(`codex probe with private MCP: probe ms ${probes.join(', ')}; request ms ${elapsed.join(', ')}`)
    expect(probes.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...probes)).toBeLessThan(2_000)
  } finally {
    lifetime.abort(); await server.close(); await new Promise<void>((resolve) => tool.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 120_000)
