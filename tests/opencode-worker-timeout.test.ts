import { describe, expect, it } from 'vitest'

import { OpencodeBackend } from '../src/backends/opencode.js'
import { sanitizeHostEnv } from '../src/executors/host.js'

/**
 * The `opencode` on PATH is a wrapper, not the binary. It caps every
 * non-interactive `run` at OPENCODE_RUN_TIMEOUT_SECONDS (default 1800) and kills
 * the worker with exit 124. That cap is invisible from the backend and smaller
 * than the backend's own timeout, so it silently decided the outcome: a long
 * agent run died at exactly 30 minutes while OPENCODE_TIMEOUT_MS said 24 hours.
 * These tests pin the propagation so one configured timeout governs one process.
 */
describe('opencode worker timeout propagation', () => {
  const spawnEnvFor = async (
    timeoutMs: number,
    parentEnv: NodeJS.ProcessEnv = {},
  ): Promise<NodeJS.ProcessEnv> => {
    let captured: NodeJS.ProcessEnv = {}
    const backend = new OpencodeBackend({
      bin: 'opencode',
      timeoutMs,
      spawner: async (_bin, _args, opts: { env?: NodeJS.ProcessEnv }) => {
        captured = opts.env ?? {}
        throw new Error('spawn intercepted — env captured')
      },
    } as ConstructorParameters<typeof OpencodeBackend>[0])
    const saved = { ...process.env }
    Object.assign(process.env, parentEnv)
    try {
      const stream = backend.chat(
        {
          model: 'opencode/zai-coding-plan/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        } as Parameters<typeof backend.chat>[0],
        null,
        new AbortController().signal,
      )
      for await (const _ of stream) { /* drain until the spawner throws */ }
    } catch {
      // expected: the spawner throws once it has captured the env
    } finally {
      for (const k of Object.keys(parentEnv)) delete process.env[k]
      Object.assign(process.env, saved)
    }
    return captured
  }

  it('derives the wrapper timeout from the backend timeout, in whole seconds', async () => {
    const env = await spawnEnvFor(86_400_000)
    expect(env.OPENCODE_RUN_TIMEOUT_SECONDS).toBe('86400')
  })

  it('rounds a fractional second up rather than truncating below the configured budget', async () => {
    const env = await spawnEnvFor(1_500)
    expect(env.OPENCODE_RUN_TIMEOUT_SECONDS).toBe('2')
  })

  it('lets an explicit operator override win over the derived value', async () => {
    const env = await spawnEnvFor(86_400_000, { OPENCODE_RUN_TIMEOUT_SECONDS: '600' })
    expect(env.OPENCODE_RUN_TIMEOUT_SECONDS).toBe('600')
  })

  it('survives the host env allowlist — a dropped variable would restore the 30-minute cap', () => {
    const out = sanitizeHostEnv({
      HOME: '/home/x',
      PATH: '/bin',
      OPENCODE_RUN_TIMEOUT_SECONDS: '86400',
    })
    expect(out?.OPENCODE_RUN_TIMEOUT_SECONDS).toBe('86400')
  })
})

/**
 * The isolating wrapper decides disposability from ONE call's argv. Shot 1 of a
 * resumable loop has no `-s` yet — the session does not exist — so it was isolated
 * into a temp store and deleted on exit; shot 2 then resumed a session that was gone
 * and opencode exited 1 with "Session not found". Every multi-round run died at
 * round 2. The caller's session id is stable across shots, so it names the series.
 */
describe('opencode resumable-series isolation', () => {
  const spawnEnvFor = async (req: Record<string, unknown>): Promise<NodeJS.ProcessEnv> => {
    let captured: NodeJS.ProcessEnv = {}
    const backend = new OpencodeBackend({
      bin: 'opencode',
      timeoutMs: 86_400_000,
      spawner: async (_bin, _args, opts: { env?: NodeJS.ProcessEnv }) => {
        captured = opts.env ?? {}
        throw new Error('spawn intercepted — env captured')
      },
    } as ConstructorParameters<typeof OpencodeBackend>[0])
    try {
      const stream = backend.chat(
        {
          model: 'opencode/zai-coding-plan/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
          ...req,
        } as Parameters<typeof backend.chat>[0],
        null,
        new AbortController().signal,
      )
      for await (const _ of stream) { /* drain */ }
    } catch { /* expected */ }
    return captured
  }

  it('names the series from the caller session id, so shot 1 and shot 2 share one store', async () => {
    const env = await spawnEnvFor({ session_id: 'task-2f92cd28-a0c4-4a3d-8332-71f057cd04ee' })
    expect(env.OPENCODE_RUNTIME_ID).toBe('task-2f92cd28-a0c4-4a3d-8332-71f057cd04ee')
  })

  it('sanitises a session id that would escape the runtime root', async () => {
    const env = await spawnEnvFor({ session_id: '../../etc/passwd' })
    expect(env.OPENCODE_RUNTIME_ID).toBe('..-..-etc-passwd')
    expect(env.OPENCODE_RUNTIME_ID).not.toContain('/')
  })

  it('leaves one-shot calls disposable — no series id when the caller supplies no session', async () => {
    const env = await spawnEnvFor({})
    expect(env.OPENCODE_RUNTIME_ID).toBeUndefined()
  })
})
