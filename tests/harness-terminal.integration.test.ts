/** Native harness protocol integration through real OS executables and the maintained host
 * spawner. These fixtures never invoke a model or tool service: they write actual native stdout,
 * delayed stderr and an exit receipt. Actual backends feed the common run registry unchanged. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_DISABLED_FEATURE_ARGS } from '@tangle-network/agent-profile-materialize'
import { ClaudeBackend } from '../src/backends/claude.js'
import { FactoryBackend } from '../src/backends/factory.js'
import { GeminiBackend } from '../src/backends/gemini.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { CodexBackend } from '../src/backends/codex.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner } from '../src/executors/types.js'
import { RunRegistry } from '../src/runs/registry.js'

const progress = 'progress: reading the disposable protocol fixture\n'
const usage = { input_tokens: 23, output_tokens: 13 }
type Harness = 'claude' | 'codex' | 'factory' | 'gemini' | 'kimi' | 'opencode'
// These are the existing model/profile laws, observed at the real executable boundary.
const codexArguments: {
  name: string
  model: string
  expectedModel?: string
  expectedProvider?: string
  profileModel?: { provider?: string; default: string }
  prompt?: string
  refused?: boolean
}[] = [
  {
    name: 'qualified model',
    model: 'codex/openai/gpt-5.1-codex',
    expectedProvider: 'openai',
    expectedModel: 'gpt-5.1-codex',
    prompt: '-cfeatures.plugins=true',
  },
  {
    name: 'bare model',
    model: 'codex/gpt-5.1-codex',
    expectedModel: 'gpt-5.1-codex',
    prompt: 'resume',
  },
  {
    name: 'profile default',
    model: 'codex/default',
    profileModel: { default: 'default' },
    prompt: '-cfeatures.plugins=true',
  },
  {
    name: 'profile harness provider',
    model: 'codex/gpt-5-codex',
    profileModel: { provider: 'codex', default: 'gpt-5-codex' },
    expectedModel: 'gpt-5-codex',
    prompt: 'resume',
  },
  {
    name: 'wire harness provider',
    model: 'codex/codex/gpt-5-codex',
    expectedModel: 'gpt-5-codex',
  },
  { name: 'alias without model', model: 'codex' },
  {
    name: 'OSS colon model',
    model: 'codex/ollama/gpt-oss:20b',
    expectedProvider: 'ollama',
    expectedModel: 'gpt-oss:20b',
  },
  {
    name: 'conflicting profile provider',
    model: 'codex/openai/gpt-5-codex',
    profileModel: { provider: 'codex', default: 'gpt-5-codex' },
    refused: true,
  },
]

interface Scenario {
  name: string
  codexArguments?: (typeof codexArguments)[number]
  terminal: boolean
  exitCode: number
  diagnostic?: string
  failureType?: string
  finalText?: string
  nativeError?: string
  signal?: NodeJS.Signals
}
const scenarios: Scenario[] = [
  { name: 'success', terminal: true, exitCode: 0 },
  { name: 'signal-death', terminal: false, exitCode: 0, signal: 'SIGKILL', failureType: 'NODE_DOWN' },
  { name: 'late-native-error', terminal: true, exitCode: 0, nativeError: 'late native failure after a provisional result' },
  { name: 'late-process-failure', terminal: true, exitCode: 7, diagnostic: 'native process failed after reporting its result', failureType: 'NODE_DOWN' },
  { name: 'truncated-native-stream', terminal: false, exitCode: 0 },
  { name: 'invalid-final-json', terminal: true, exitCode: 0, finalText: 'native result is not JSON', failureType: 'HARNESS_OUTPUT_INVALID' },
  { name: 'late-model-refusal', terminal: true, exitCode: 7, diagnostic: 'unknown model: protocol-fixture-model', failureType: 'MODEL_NOT_FOUND' },
  { name: 'preterminal-auth-refusal', terminal: false, exitCode: 9, diagnostic: 'authentication required: login required', failureType: 'SEAT_NOT_LOGGED_IN' },
]

function nativeEvents(harness: Harness, finalText: string, terminal: boolean): unknown[] {
  if (harness === 'claude') {
    return [
      { type: 'system', subtype: 'init', session_id: 'fixture-claude-session', model: 'protocol-fixture-model' },
      { type: 'assistant', message: { id: 'progress', content: [{ type: 'text', text: progress }] } },
      { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: finalText }] } },
      ...(terminal ? [{ type: 'result', subtype: 'success', session_id: 'fixture-claude-session',
        result: finalText, is_error: false,
        usage: { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 5, output_tokens: 13 },
        total_cost_usd: 0.125 }] : []),
    ]
  }
  if (harness === 'codex') return [
    { type: 'thread.started', thread_id: 'fixture-codex-thread' },
    { type: 'item.completed', item: { id: 'progress', type: 'agent_message', text: progress } },
    { type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'echo protocol-fixture', status: 'completed', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: { key: 'fixture' }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'protocol fixture' } },
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: finalText } },
    ...(terminal ? [{ type: 'turn.completed', usage: { ...usage, cached_input_tokens: 7 } }] : []),
  ]
  if (harness === 'kimi') return [
    { role: 'assistant', content: [{ type: 'text', text: progress }] },
    { role: 'assistant', content: [{ type: 'text', text: finalText }] },
    ...(terminal ? [{ type: 'result', usage }] : []),
  ]
  if (harness === 'opencode') return [
    { type: 'text', part: { type: 'text', text: progress } },
    { type: 'text', part: { type: 'text', text: finalText } },
    ...(terminal ? [{ type: 'turn.completed', usage }] : []),
  ]
  return [
    { type: 'message', role: 'assistant', text: progress, content: progress },
    { type: 'message', role: 'assistant', text: finalText, content: finalText },
    ...(terminal ? [{ type: 'result' }] : []),
  ]
}

const executable = `#!${process.execPath}
const fs = require('node:fs');
const spec = JSON.parse(fs.readFileSync('native-case.json', 'utf8'));
for (const event of spec.events) process.stdout.write(JSON.stringify(event) + '\\n');
if (!spec.terminal && !spec.signal) process.stdout.write('{"type":');
// A terminal stdout event is deliberately provisional: diagnostics and actual exit come later.
setTimeout(() => {
  if (spec.nativeError) process.stdout.write(JSON.stringify({ type: 'error', message: spec.nativeError }) + '\\n');
  if (spec.diagnostic) process.stderr.write(spec.diagnostic + '\\n');
  fs.writeFileSync('exit-receipt.json', JSON.stringify({
    pid: process.pid, exitCode: spec.exitCode, argv: process.argv.slice(2),
  }));
  if (spec.signal) process.kill(process.pid, spec.signal);
  else process.exitCode = spec.exitCode;
}, 45);
`

describe('native harness terminal result followed by actual process exit', () => {
  let scratch: string
  // This is a path only. The tests neither read nor copy an operator credential file.
  const previousCodexHome = process.env.CODEX_HOME
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bridge-harness-terminal-'))
    const emptyCodexHome = join(scratch, 'empty-codex-home')
    await mkdir(emptyCodexHome)
    process.env.CODEX_HOME = emptyCodexHome
  })
  afterAll(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(scratch, { recursive: true, force: true })
  })

  for (const harness of ['claude', 'codex', 'factory', 'gemini', 'kimi', 'opencode'] as const) {
    const selected = harness === 'claude' || harness === 'codex'
      ? scenarios
      : scenarios.filter((scenario) => ['success', 'late-native-error', 'late-process-failure', 'signal-death'].includes(scenario.name))
    const cases: Scenario[] = harness === 'codex'
      ? selected.flatMap((scenario) => scenario.name === 'success'
        ? codexArguments.map((argumentsCase) => ({ ...scenario, codexArguments: argumentsCase }))
        : [scenario])
      : harness === 'kimi'
        ? [...selected, { name: 'json-content-nonzero-without-terminal', terminal: false, exitCode: 7,
            diagnostic: 'native Kimi process failed without a completion event', failureType: 'NODE_DOWN' }]
        : selected
    for (const scenario of cases) {
      it(`${harness}: ${scenario.name}${scenario.codexArguments ? ` (${scenario.codexArguments.name})` : ''} preserves raw evidence and gates structured final output`, async () => {
        const cwd = await mkdtemp(join(scratch, `${harness}-${scenario.name}-`))
        const bin = join(cwd, 'native-protocol.cjs')
        const finalOutput = { fixture: harness, ok: true }
        const finalText = scenario.finalText ?? JSON.stringify(finalOutput)
        await writeFile(bin, executable)
        await chmod(bin, 0o755)
        await writeFile(join(cwd, 'native-case.json'), JSON.stringify({
          ...scenario, events: nativeEvents(harness, finalText, scenario.terminal),
        }))
        let codexLaunches = 0
        const observedCodexSpawner: Spawner = (command, args, options) => {
          codexLaunches += 1
          return hostSpawner(command, args, options)
        }
        observedCodexSpawner.executionEnvironment = hostSpawner.executionEnvironment
        const backend = harness === 'claude'
          ? new ClaudeBackend({ bin, harness: 'claude-code', timeoutMs: 5000, spawner: hostSpawner })
          : harness === 'codex' ? new CodexBackend({ bin, timeoutMs: 5000, spawner: observedCodexSpawner })
          : harness === 'factory' ? new FactoryBackend({ bin, timeoutMs: 5000, spawner: hostSpawner })
          : harness === 'gemini' ? new GeminiBackend({ bin, timeoutMs: 5000, spawner: hostSpawner })
          : harness === 'kimi' ? new KimiBackend({ bin, timeoutMs: 5000, spawner: hostSpawner })
          : new OpencodeBackend({ bin, timeoutMs: 5000, spawner: hostSpawner })
        const argumentsCase = scenario.codexArguments
        const prompt = argumentsCase?.prompt ?? 'exercise the native protocol fixture'
        const request: ChatRequest = {
          model: argumentsCase?.model ?? `${harness === 'claude' ? 'claude-code/anthropic' : harness === 'kimi' ? 'kimi-code' : harness}/protocol-fixture-model`,
          mode: 'byob', cwd, messages: [{ role: 'user', content: prompt }],
          responseFormat: { type: 'json_object' },
          ...(argumentsCase?.profileModel ? {
            agent_profile: {
              name: 'native-argv-policy',
              harness: 'codex',
              model: argumentsCase.profileModel,
              prompt: { instructions: ['Public native argv policy fixture.'] },
            },
          } : {}),
        }
        if (argumentsCase?.refused) {
          const iteration = backend.chat(request, null, new AbortController().signal)[Symbol.asyncIterator]()
          try {
            await expect(iteration.next()).rejects.toThrow(/conflicts with agent_profile\.model/u)
            expect(codexLaunches).toBe(0)
          } finally {
            await iteration.return?.()
          }
          return
        }
        const registry = new RunRegistry({ maxLifetimeMs: 5000 })
        try {
          const { run } = registry.claim(`${harness}-${scenario.name}`, `fixture:${harness}:${scenario.name}`)
          const pumping = run.pump(backend.chat(request, null, run.signal), { requireFinalOutput: true })
          const deltas: ChatDelta[] = []
          for await (const { delta } of run.attach()) {
            if (delta.finish_reason === 'stop' || delta.finish_reason === 'tool_calls' || Object.hasOwn(delta, 'final_output')) {
              // A native success record alone must not reach this path before the child exits.
              const receipt = JSON.parse(await readFile(join(cwd, 'exit-receipt.json'), 'utf8'))
              expect(receipt.exitCode).toBe(0)
            }
            deltas.push(delta)
          }
          await pumping
          const receipt = JSON.parse(await readFile(join(cwd, 'exit-receipt.json'), 'utf8'))
          expect(receipt.exitCode).toBe(scenario.exitCode)
          expect(receipt.argv).toContain(harness === 'codex' ? '--json' : harness === 'opencode' ? '--format' : '--output-format')
          if (harness === 'codex') {
            const argv: string[] = receipt.argv
            expect(argv.slice(-2)).toEqual(['--', prompt])
            const featureFlags = argv.findIndex((_, index) =>
              CODEX_DISABLED_FEATURE_ARGS.every((flag, offset) => argv[index + offset] === flag),
            )
            expect(featureFlags >= 0).toBe(Boolean(argumentsCase?.profileModel))
            if (argumentsCase) {
              for (const [key, expected] of [
                ['model', argumentsCase.expectedModel],
                ['model_provider', argumentsCase.expectedProvider],
              ] as const) {
                const selections = argv.filter((arg) => arg.startsWith(`${key}=`))
                if (expected === undefined) expect(selections).toEqual([])
                else expect(selections).toContain(`${key}="${expected}"`)
              }
            }
          }
          expect(deltas.map((delta) => delta.content ?? '').join('')).toBe(progress + finalText)
          if (scenario.terminal && ['claude', 'codex', 'kimi', 'opencode'].includes(harness)) {
            const nativeUsage = deltas.find((delta) => delta.usage !== undefined)?.usage
            expect(nativeUsage).toMatchObject(usage)
            if (harness === 'claude') expect(nativeUsage).toMatchObject({
              fresh_input_tokens: 11, cache_read_input_tokens: 7, cache_write_input_tokens: 5,
              cost: 0.125, cost_known: true, cost_provenance: 'provider-receipt', cost_scope: 'total',
            })
            else if (harness === 'codex') expect(nativeUsage).toMatchObject({ cached_input_tokens: 7 })
          }
          if (scenario.name === 'success') {
            expect(run.snapshot().status).toBe('done')
            expect(run.failure()).toBeUndefined()
            expect(deltas.filter((delta) => Object.hasOwn(delta, 'final_output'))
              .map((delta) => delta.final_output)).toEqual([finalOutput])
            expect(deltas.filter((delta) => delta.finish_reason === (harness === 'codex' ? 'tool_calls' : 'stop'))).toHaveLength(1)
            if (harness === 'codex') expect(deltas.flatMap((delta) => delta.tool_calls ?? [])
              .map((call) => call.name)).toEqual(['bash', 'fixture_lookup', 'websearch'])
          } else {
            expect(run.snapshot().status).toBe('error')
            expect(run.failure()).toBeDefined()
            expect(deltas.some((delta) => delta.finish_reason === 'stop' || delta.finish_reason === 'tool_calls')).toBe(false)
            expect(deltas.some((delta) => Object.hasOwn(delta, 'final_output'))).toBe(false)
            const reason = deltas.findLast((delta) => delta.finish_reason === 'error')?.error
            expect(reason?.message).toBeTruthy()
            if (scenario.failureType) expect(reason?.type).toBe(scenario.failureType)
            if (scenario.diagnostic) expect(reason?.message).toContain(scenario.diagnostic)
            if (scenario.nativeError) expect(reason?.message).toContain(scenario.nativeError)
            if (scenario.signal) expect(reason?.message).toContain(scenario.signal)
          }
          const replay: ChatDelta[] = []
          for await (const { delta } of run.attach()) replay.push(delta)
          expect(replay).toEqual(deltas)
        } finally {
          await registry.shutdown()
        }
      }, 15000)
    }
  }
})
