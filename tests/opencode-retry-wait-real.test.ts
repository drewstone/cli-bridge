/**
 * A provider's long `retry-after` ends the turn instead of hanging it, against the REAL opencode.
 *
 * opencode sleeps a refused call's `retry-after` itself (capped only at 2^31 ms) and
 * `run --format json` prints nothing while it waits. The free seat answers a spent quota with
 * `429` and `retry-after: 47331`, and magnetar-rust-20261019b's root slept until the bridge's
 * 4 h turn cap. A local endpoint answers every call the same way here; the turn must end within
 * the bridge's retry-wait limit, coded `upstream_unavailable` and naming the reset time.
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
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const ENABLED = existsSync(BIN) && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'
const RETRY_AFTER_S = 3600

describe.skipIf(!ENABLED)('a real opencode turn refused with a long retry-after', () => {
  let server: Server
  let calls = 0
  let baseURL = ''
  const scratch = mkdtempSync(join(tmpdir(), 'opencode-retry-wait-'))
  const saved = { ...process.env }

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls++
      req.resume()
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(RETRY_AFTER_S) })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded. Please try again later.' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
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
            models: { m: { name: 'm' } },
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

  it('ends the turn coded upstream_unavailable with the reset time, well inside the wait', async () => {
    const cwd = mkdtempSync(join(scratch, 'cwd-'))
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 300_000, spawner: hostSpawner })
    const req: ChatRequest = {
      cwd,
      session_id: 'retry-wait-real',
      mode: 'byob',
      model: 'opencode/probe/m',
      messages: [{ role: 'user', content: 'say ok' }],
      agent_profile: { name: 'director', harness: 'opencode', prompt: { instructions: ['You are the director.'] } },
    } as ChatRequest

    const started = Date.now()
    let last: ChatDelta | undefined
    for await (const delta of backend.chat(req, null, new AbortController().signal)) {
      if (delta.finish_reason !== undefined) last = delta
    }
    const elapsedMs = Date.now() - started

    expect(calls).toBeGreaterThan(0)
    expect(last?.finish_reason).toBe('error')
    expect(last?.error?.type).toBe('upstream_unavailable')
    expect(last?.error?.status).toBeUndefined()
    expect(last?.error?.message).toMatch(/Rate limit exceeded/)
    expect(last?.error?.message).toMatch(/wait 3\d{3} s before retrying, reset at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
    expect(elapsedMs).toBeLessThan(120_000)
  }, 180_000)
})
