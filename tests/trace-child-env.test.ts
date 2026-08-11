/**
 * Child trace propagation over the env channel (#147).
 *
 * Measured before this channel existed: 98/98 children across 100
 * discovery-lab spawn journals emitted `trace-unpropagated`
 * (`no-env-channel`) — no trace context survived the spawn path, so every
 * child opened an orphan trace root and its telemetry never joined the
 * caller's trace.
 *
 * The channel has four seams, each proven here:
 *   1. `traceContextToChildEnv` — context → the env spellings agent-runtime's
 *      `readTraceContextFromEnv` reads (W3C `TRACEPARENT` first, legacy
 *      `TRACE_ID` / `PARENT_SPAN_ID` as fallback).
 *   2. The two env filters (`piToolProcessEnvironment`, `sanitizeHostEnv`)
 *      pass request-stamped trace values and keep stripping the daemon's own
 *      ambient ones.
 *   3. The pi backend stamps `ChatRequest.childTrace` into the spawn env.
 *   4. The chat route derives `childTrace` from the correlation headers,
 *      nesting the child under the bridge's own request span when one
 *      records.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { PiBackend, piToolProcessEnvironment } from '../src/backends/pi.js'
import { BackendRegistry } from '../src/backends/registry.js'
import type { ChatRequest } from '../src/backends/types.js'
import { sanitizeHostEnv } from '../src/executors/host.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { TraceEmitter } from '../src/trace/emitter.js'
import { traceContextToChildEnv } from '../src/trace/ids.js'
import { testPiInferenceTransport } from './pi-inference-fixture.js'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const SPAN_ID = 'b7ad6b7169203331'
const TRACE_KEYS = ['TRACEPARENT', 'TRACE_ID', 'PARENT_SPAN_ID'] as const

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

const PI_TURN_LINES: Array<Record<string, unknown>> = [
  { type: 'session', id: 'trace-test-pi-session' },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
  },
  { type: 'turn_end', message: { usage: { input: 2, output: 1 } } },
]

function capturingPiSpawner(envs: Array<NodeJS.ProcessEnv | undefined>): Spawner {
  const spawner: Spawner = async (_bin, _args, opts): Promise<SpawnResult> => {
    envs.push(opts.env)
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of PI_TURN_LINES) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 0
        child.emit('close', 0)
      }, 10)
    })
    return {
      child: child as never,
      release() {},
      spawnError: () => null,
    }
  }
  spawner.executionEnvironment = 'test-double'
  return spawner
}

function newPiBackend(envs: Array<NodeJS.ProcessEnv | undefined>): PiBackend {
  return new PiBackend({
    bin: 'pi',
    timeoutMs: 1000,
    spawner: capturingPiSpawner(envs),
    transportResolver: testPiInferenceTransport(),
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { /* drain */ }
}

describe('traceContextToChildEnv', () => {
  it('dual-writes the W3C wire and the legacy pair from one context', () => {
    expect(traceContextToChildEnv({ traceId: TRACE_ID, parentSpanId: SPAN_ID })).toEqual({
      TRACE_ID,
      PARENT_SPAN_ID: SPAN_ID,
      TRACEPARENT: `00-${TRACE_ID}-${SPAN_ID}-01`,
    })
  })

  it('degrades to the legacy trace id alone when no span id exists', () => {
    // TRACEPARENT requires a span id by grammar; half a wire would be an
    // unjoinable orphan, so only the legacy pair's trace id travels.
    expect(traceContextToChildEnv({ traceId: TRACE_ID, parentSpanId: null })).toEqual({
      TRACE_ID,
    })
  })

  it('stamps nothing without a context', () => {
    expect(traceContextToChildEnv(null)).toEqual({})
    expect(traceContextToChildEnv(undefined)).toEqual({})
  })
})

describe('spawn env filters', () => {
  it('passes request-stamped trace values through both allowlists', () => {
    const child = sanitizeHostEnv(piToolProcessEnvironment(
      { HOME: '/home/test', PATH: process.env.PATH },
      traceContextToChildEnv({ traceId: TRACE_ID, parentSpanId: SPAN_ID }),
    ))
    expect(child?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
    expect(child?.TRACE_ID).toBe(TRACE_ID)
    expect(child?.PARENT_SPAN_ID).toBe(SPAN_ID)
  })

  it('leaves the child env byte-identical when no context was stamped', () => {
    const withoutTrace = sanitizeHostEnv(piToolProcessEnvironment(
      { HOME: '/home/test', PATH: process.env.PATH },
      {},
    ))
    for (const key of TRACE_KEYS) expect(withoutTrace).not.toHaveProperty(key)
  })

  it('still strips the daemon\'s own ambient trace context', () => {
    // A backend that spreads the whole process.env (codex, opencode, kimi,
    // gemini) copies the BRIDGE's launch-time TRACEPARENT. Passing it on
    // would parent every child under the daemon's launch context instead of
    // its caller's trace, so the identical-to-ambient value stays stripped.
    const ambient = `00-${'f'.repeat(32)}-${'f'.repeat(16)}-01`
    const saved = process.env.TRACEPARENT
    process.env.TRACEPARENT = ambient
    try {
      const spread = sanitizeHostEnv({ HOME: '/home/test', TRACEPARENT: ambient })
      expect(spread).not.toHaveProperty('TRACEPARENT')

      const stamped = sanitizeHostEnv({
        HOME: '/home/test',
        TRACEPARENT: `00-${TRACE_ID}-${SPAN_ID}-01`,
      })
      expect(stamped?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
    } finally {
      if (saved === undefined) delete process.env.TRACEPARENT
      else process.env.TRACEPARENT = saved
    }
  })
})

describe('pi backend spawn env', () => {
  const request = (cwd: string, childTrace?: ChatRequest['childTrace']): ChatRequest => ({
    model: 'pi/zai-coding-paas/glm-5.2',
    messages: [{ role: 'user', content: 'inspect the project' }],
    cwd,
    ...(childTrace === undefined ? {} : { childTrace }),
  })

  it('carries childTrace into the child env, and only then', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-trace-env-'))
    const envs: Array<NodeJS.ProcessEnv | undefined> = []
    const backend = newPiBackend(envs)
    try {
      await drain(backend.chat(
        request(cwd, { traceId: TRACE_ID, parentSpanId: SPAN_ID }),
        null,
        new AbortController().signal,
      ))
      await drain(backend.chat(request(cwd), null, new AbortController().signal))

      expect(envs).toHaveLength(2)
      expect(envs[0]?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
      expect(envs[0]?.TRACE_ID).toBe(TRACE_ID)
      expect(envs[0]?.PARENT_SPAN_ID).toBe(SPAN_ID)
      for (const key of TRACE_KEYS) expect(envs[1]).not.toHaveProperty(key)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('chat route childTrace derivation', () => {
  function mountedApp(options: { traced: boolean }): {
    app: Hono
    envs: Array<NodeJS.ProcessEnv | undefined>
    mintedSpanIds: string[]
  } {
    const envs: Array<NodeJS.ProcessEnv | undefined> = []
    const mintedSpanIds: string[] = []
    let minted = 0
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(newPiBackend(envs)),
      sessions: new SessionStore(mkdtempSync(join(tmpdir(), 'cli-bridge-trace-route-'))),
      runs: new RunRegistry(),
      ...(options.traced
        ? {
            trace: new TraceEmitter({
              sink: { write() {} },
              maxToolSpans: 8,
              mintSpanId: () => {
                const id = (minted++).toString(16).padStart(16, '0')
                mintedSpanIds.push(id)
                return id
              },
            }),
          }
        : {}),
    })
    return { app, envs, mintedSpanIds }
  }

  const post = async (app: Hono, cwd: string, headers: Record<string, string>): Promise<Response> =>
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'pi/zai-coding-paas/glm-5.2',
        messages: [{ role: 'user', content: 'inspect the project' }],
        stream: false,
        cwd,
      }),
    })

  it('nests the child under the bridge request span when tracing records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-trace-route-cwd-'))
    const { app, envs, mintedSpanIds } = mountedApp({ traced: true })
    try {
      const response = await post(app, cwd, {
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      })
      expect(response.status).toBe(200)
      // The recorder's own span id — minted first — is the spawning node, so
      // the child parents under the bridge request span, not the caller's.
      const requestSpanId = mintedSpanIds[0]
      expect(requestSpanId).toBeDefined()
      expect(envs[0]?.TRACEPARENT).toBe(`00-${TRACE_ID}-${requestSpanId}-01`)
      expect(envs[0]?.TRACE_ID).toBe(TRACE_ID)
      expect(envs[0]?.PARENT_SPAN_ID).toBe(requestSpanId)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('passes the caller ids through verbatim when tracing is off', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-trace-route-cwd-'))
    const { app, envs } = mountedApp({ traced: false })
    try {
      const response = await post(app, cwd, {
        'x-trace-id': TRACE_ID,
        'x-parent-span-id': SPAN_ID,
      })
      expect(response.status).toBe(200)
      expect(envs[0]?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
      expect(envs[0]?.TRACE_ID).toBe(TRACE_ID)
      expect(envs[0]?.PARENT_SPAN_ID).toBe(SPAN_ID)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stamps nothing when the request carried no correlation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-bridge-trace-route-cwd-'))
    // Traced on purpose: even though the recorder minted a fresh root for its
    // own span, a request with no caller correlation must leave the child env
    // untouched.
    const { app, envs } = mountedApp({ traced: true })
    try {
      const response = await post(app, cwd, {})
      expect(response.status).toBe(200)
      for (const key of TRACE_KEYS) expect(envs[0]).not.toHaveProperty(key)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
