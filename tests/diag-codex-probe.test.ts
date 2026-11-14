/** DIAGNOSTIC ONLY: agent-container #18828's embedded-Bridge shape with its fake codex; times the subscription probe. */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

const fake = `#!/usr/bin/python3
import json,os,pathlib,sys,time,uuid
if '--version' in sys.argv[1:]:
    print('codex-cli 0.164.0'); sys.exit(0)
if any(sys.argv[i:i+2] == ['login','status'] for i in range(1,len(sys.argv)-1)):
    print("Logged in using ChatGPT"); sys.exit(0)
if 'app-server' in sys.argv[1:]:
    with open('native-metadata-probes','a') as receipt: receipt.write('app-server\\n')
    for line in sys.stdin:
        request=json.loads(line)
        if 'id' not in request: continue
        method=request.get('method')
        result={} if method=='initialize' else {'config':{'model_provider':'openai','model':'native-capture-fixture'},'origins':{}} if method=='config/read' else {'account':{'type':'chatgpt'},'requiresOpenaiAuth':True} if method=='account/read' else {'data':[],'nextCursor':None}
        print(json.dumps({'id':request['id'],'result':result}),flush=True)
    sys.exit(0)
if 'exec' not in sys.argv[1:]:
    print('Unsupported',file=sys.stderr); sys.exit(2)
native_id=str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':native_id}),flush=True)
for event in [
 {'type':'item.completed','item':{'type':'agent_message','text':'{"ok":true}'}},
 {'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}
]: print(json.dumps(event))
`

it.each(['none', 'mcp'] as const)('diag: probe timing with %s', async (variant) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'diag-probe-'))), cwd = join(root, 'workspace'), home = join(root, 'home')
  await mkdir(cwd); await mkdir(home)
  vi.stubEnv('HOME', home)
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) vi.stubEnv(key, undefined as unknown as string)
  const bin = join(cwd, 'codex-protocol')
  await writeFile(bin, fake, { mode: 0o700 })
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"jsonrpc":"2.0","id":1,"result":{}}') })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as { port: number }).port, url = `http://127.0.0.1:${port}/mcp`
  const config = { ...loadConfig({ ...process.env, HOME: home, BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: 'diag', BRIDGE_DATA_DIR: join(root, 'bridge'), BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin,
    BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_FALLBACK: 'deny', BRIDGE_JAIL_NETWORK: 'relay', BRIDGE_SUBSCRIPTIONS_ONLY: '1', BRIDGE_TRACE: 'off' }), port: 0 }
  const server = await startServer({ config, cwd, quiet: true, handleSignals: false, mcpSecrets: { async get(key) { return key === 'tool' ? 'secret-value' : undefined } } })
  const lifetime = new AbortController()
  try {
    if (variant === 'mcp') server.registerPrivateMcpEndpoint({ runId: 'diag-run', url, paths: { '': ['POST', 'GET', 'DELETE'] }, signal: lifetime.signal })
    const body = { stream: false, model: 'codex/native-capture-fixture', run_id: `diag-run`, session_id: `diag-${variant}`, cwd,
      agent_profile: { name: 'native-capture-fixture', harness: 'codex', model: { provider: 'openai', default: 'native-capture-fixture' } },
      messages: [{ role: 'user', content: 'diag' }],
      ...(variant === 'mcp' ? { runtime_attachments: { mcp: { custom: { transport: 'http', url, headers: { Authorization: { kind: 'secret-ref', key: 'tool', format: 'bearer' } } } } } } : {}) }
    const started = performance.now()
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer diag' }, body: JSON.stringify(body) })
    const text = await response.text()
    console.log(`DIAG ${variant} status=${response.status} ms=${Math.round(performance.now() - started)} body=${text.slice(0, 1500)}`)
    console.log(`DIAG ${variant} trace=${await readFile('/tmp/codex-probe-trace.jsonl', 'utf8').catch(() => 'none')}`)
    expect(response.status).toBeGreaterThan(0)
  } finally { lifetime.abort(); await server.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); vi.unstubAllEnvs() }
}, 60_000)
