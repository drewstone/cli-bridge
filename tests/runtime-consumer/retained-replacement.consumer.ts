import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { loadConfig, startServer } from '../../src/server.js'

const PROFILE = {
  name: 'retained-replacement-proof',
  harness: 'claude-code',
  model: { provider: 'anthropic', default: 'sonnet' },
} as const
const COORDINATION_ALIAS = 'agent-runtime-coordination'
const NATIVE_SESSION = '00000000-0000-4000-8000-000000000394'
const MARKER = 'replacement-turn-answered-394'

// What Agent Runtime 10.0.15 mounts as its coordination tools (coordinationRuntimeAttachment).
const coordination = {
  transport: 'http',
  url: 'http://127.0.0.1:9/mcp',
  headers: { Authorization: { kind: 'secret-ref', key: 'AGENT_RUNTIME_COORDINATION_TOKEN', format: 'bearer' } },
  metadata: { toolTimeoutMs: 300_000 },
} as const

async function drain(stream: AsyncIterable<unknown>): Promise<{ events: unknown[]; error?: Error }> {
  const events: unknown[] = []
  try {
    for await (const event of stream) events.push(event)
    return { events }
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

// A real Bridge listener, a real Claude-protocol process and the published provider: no model is called.
// The first turn ends as health-agent#99's plan turn did on the Factory host: exit 134 with no signal.
test('a replacement after a harness abort: the Runtime\'s turn-carried attachment is refused by key path, the Bridge-issued shape runs', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-retained-replacement-'))
  let bridge: Awaited<ReturnType<typeof startServer>> | undefined
  context.after(async () => { await bridge?.close(); await rm(directory, { recursive: true, force: true }) })
  const spawnsPath = join(directory, 'spawns.json')
  const bin = join(directory, 'claude-protocol.cjs')
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('2.1.330 (Claude Code)'); process.exit(0) }
const spawns = fs.existsSync(${JSON.stringify(spawnsPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(spawnsPath)}, 'utf8')) : []
const flag = (name) => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1] }
const mcp = flag('--mcp-config') ? JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers : {}
spawns.push({ resume: flag('--resume'), mcpServers: Object.keys(mcp) })
fs.writeFileSync(${JSON.stringify(spawnsPath)}, JSON.stringify(spawns))
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(NATIVE_SESSION)} })
if (spawns.length === 1) {
  emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }] } })
  process.exit(134)
}
emit({ type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: ${JSON.stringify(MARKER)} }] } })
emit({ type: 'result', subtype: 'success', session_id: ${JSON.stringify(NATIVE_SESSION)}, result: ${JSON.stringify(MARKER)}, is_error: false,
  usage: { input_tokens: 3, output_tokens: 5 } })
`, { mode: 0o755 })
  bridge = await startServer({
    config: { ...loadConfig({
      BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_BACKENDS: 'claude',
      BRIDGE_BEARER: 'test-only', BRIDGE_TRACE: 'off', CLAUDE_BIN: bin,
    }), port: 0 },
    handleSignals: false,
    quiet: true,
  })
  const sent: Array<Record<string, unknown>> = []
  const provider = createCliBridgeProvider({
    baseUrl: bridge.url,
    bearerToken: 'test-only',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions') && typeof init?.body === 'string') sent.push(JSON.parse(init.body))
      return await fetch(input, init)
    },
  })
  const idempotencyKey = 'runtime:retained-replacement-proof:s1:input:1'
  const environment = await provider.create({
    profile: PROFILE,
    idempotencyKey,
    metadata: { retainedIdempotencyKey: idempotencyKey },
    env: { AGENT_RUNTIME_COORDINATION_TOKEN: 'coordination-bearer-fixture-394' },
    runtimeAttachments: { mcp: { [COORDINATION_ALIAS]: coordination } },
  })
  const sessionId = 'retained-session-replacement-proof'
  const turn = (n: number) => ({ sessionId, executionId: `retained-execution-${n}`, turnId: `retained-replacement-proof:s1:input:${n}:turn:0` })
  const spawns = async (): Promise<Array<{ resume: string | null; mcpServers: string[] }>> =>
    JSON.parse(await readFile(spawnsPath, 'utf8'))

  const first = await drain(environment.stream({ prompt: 'plan the change', ...turn(1) }))
  assert.equal((await spawns()).length, 1)
  assert.match(`${first.error?.message ?? ''} ${JSON.stringify(first.events)}`, /claude exited 134/)

  // Runtime 10.0.15 retainedDispatchMaterial: a dispatch into the prior session re-mounts the
  // coordination tools through turn.providerOptions.backend.runtimeAttachments.
  const replacement = await drain(environment.stream({
    prompt: 'The previous attempt failed; continue.',
    ...turn(7),
    providerOptions: { backend: { runtimeAttachments: { mcp: { [COORDINATION_ALIAS]: coordination } } } },
  }))
  const refusedBody = sent.at(-1)!
  console.log(`refused replacement request metadata: ${JSON.stringify(refusedBody.metadata)}`)
  assert.deepEqual(refusedBody.metadata, {
    retainedIdempotencyKey: idempotencyKey,
    backend: { runtimeAttachments: { mcp: { [COORDINATION_ALIAS]: coordination } } },
  })
  assert.equal((replacement.error as { status?: unknown } | undefined)?.status, 400)
  assert.match(replacement.error!.message, /retained metadata contains a credential-bearing key at /)
  assert.ok(replacement.error!.message.includes(`backend.runtimeAttachments.mcp.${COORDINATION_ALIAS}.headers.Authorization`), replacement.error!.message)
  assert.ok(!replacement.error!.message.includes('coordination-bearer-fixture-394'))
  assert.equal((await spawns()).length, 1, 'the refused replacement never reached the harness')

  // The same replacement with only what the Bridge issued and the attachment in its own field runs,
  // resumes the aborted native session and mounts the coordination tools.
  const accepted = await drain(environment.stream({ prompt: 'The previous attempt failed; continue.', ...turn(8) }))
  assert.equal(accepted.error, undefined, accepted.error?.message)
  assert.ok(JSON.stringify(accepted.events).includes(MARKER))
  const acceptedBody = sent.at(-1)!
  assert.deepEqual(acceptedBody.metadata, { retainedIdempotencyKey: idempotencyKey })
  assert.deepEqual(Object.keys((acceptedBody.runtime_attachments as { mcp: object }).mcp), [COORDINATION_ALIAS])
  const [, resumed] = await spawns()
  assert.equal(resumed?.resume, NATIVE_SESSION)
  assert.ok(resumed?.mcpServers.includes(COORDINATION_ALIAS), JSON.stringify(resumed))
})
