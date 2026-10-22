/**
 * A tool call is reported when it starts, against the REAL opencode.
 *
 * `opencode run --format json` prints a tool part only once it has finished, so a long tool read
 * as model silence: magnetar-rust-20261018b's 32-minute prove battery left no event for 32.4
 * minutes. A local endpoint scripts one `bash` call that sleeps; the call must reach the stream
 * while the command still runs, and its outcome once it ends, with one call per id.
 *
 * Skipped when the binary is absent, and by `CLI_BRIDGE_SKIP_REAL_OPENCODE=1`.
 * Measured against opencode 1.18.33.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const ENABLED = existsSync(BIN) && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'
const SLEEP_S = 4

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

describe.skipIf(!ENABLED)('a real opencode tool call', () => {
  let server: Server
  const scratch = mkdtempSync(join(tmpdir(), 'opencode-tool-start-'))
  const saved = { ...process.env }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (data: Buffer) => { body += data.toString('utf8') })
      req.on('end', () => {
        const request = JSON.parse(body) as { tools?: unknown[]; messages?: Array<{ role?: string }> }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        // A request without tools is opencode naming the session; one after the tool result ends the turn.
        const answered = request.messages?.some((message) => message.role === 'tool') === true
        if (!request.tools?.length || answered) {
          res.end(sse([chunk({ role: 'assistant', content: 'finished' }), chunk({}, 'stop')]))
          return
        }
        res.end(sse([
          chunk({
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_sleep',
              type: 'function',
              function: { name: 'bash', arguments: JSON.stringify({ command: `sleep ${SLEEP_S} && echo slept`, description: 'Wait' }) },
            }],
          }),
          chunk({}, 'tool_calls'),
        ]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    Object.assign(process.env, {
      XDG_CONFIG_HOME: join(scratch, 'config'),
      XDG_DATA_HOME: join(scratch, 'data'),
      XDG_CACHE_HOME: join(scratch, 'cache'),
      XDG_STATE_HOME: join(scratch, 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          probe: {
            npm: '@ai-sdk/openai-compatible',
            name: 'probe',
            options: { baseURL, apiKey: 'probe' },
            models: { m: { name: 'm', tool_call: true } },
          },
        },
      }),
    })
  })

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reports the call while the tool runs and its outcome when it ends, once each', async () => {
    const cwd = mkdtempSync(join(scratch, 'cwd-'))
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 300_000, spawner: hostSpawner })
    const req: ChatRequest = {
      cwd,
      session_id: 'tool-start-real',
      mode: 'byob',
      model: 'opencode/probe/m',
      messages: [{ role: 'user', content: 'wait for the command' }],
      agent_profile: { name: 'worker', harness: 'opencode', prompt: { instructions: ['Run the command you are asked to run.'] } },
    } as ChatRequest

    const calls: Array<{ id: string; at: number }> = []
    const results: Array<{ id: string; at: number; output?: string }> = []
    let finish: string | undefined
    for await (const delta of backend.chat(req, null, new AbortController().signal)) {
      for (const call of delta.tool_calls ?? []) calls.push({ id: call.id, at: Date.now() })
      for (const result of delta.tool_results ?? []) results.push({ id: result.id, at: Date.now(), ...(result.output ? { output: result.output } : {}) })
      if (delta.finish_reason !== undefined) finish = delta.finish_reason
    }

    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe(calls[0]!.id)
    expect(results[0]!.output).toMatch(/slept/)
    // Reported at its start: the sleep still had most of its time to run.
    expect(results[0]!.at - calls[0]!.at).toBeGreaterThanOrEqual((SLEEP_S - 1) * 1000)
    expect(finish).not.toBe('error')
  }, 180_000)
})
