import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { bindIncomingRequest } from '../src/http/request-source.js'
import { PROTECTED_MODEL_CREDENTIAL_HEADER, mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import type { SessionRecord, SessionStore } from '../src/sessions/store.js'

function memorySessions(): { store: SessionStore; records: Map<string, SessionRecord> } {
  const records = new Map<string, SessionRecord>()
  const keyFor = (externalId: string, backend: string): string => `${backend}:${externalId}`
  const store = {
    get(externalId: string, backend: string): SessionRecord | null {
      return records.get(keyFor(externalId, backend)) ?? null
    },
    async acquireExecution(): Promise<{ release(): void }> {
      return { release() {} }
    },
    upsert(args: {
      externalId: string
      backend: string
      internalId: string
      cwd?: string | null
      metadata?: Record<string, unknown>
    }): SessionRecord {
      const now = Date.now()
      const existing = records.get(keyFor(args.externalId, args.backend))
      const record: SessionRecord = {
        externalId: args.externalId,
        backend: args.backend,
        internalId: args.internalId,
        cwd: args.cwd ?? null,
        turns: (existing?.turns ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        metadata: { ...(existing?.metadata ?? {}), ...(args.metadata ?? {}) },
      }
      records.set(keyFor(args.externalId, args.backend), record)
      return record
    },
  } as unknown as SessionStore
  return { store, records }
}

function fakeBackend(name: string, requests: ChatRequest[]): Backend {
  return {
    name,
    matches: (model) => model.startsWith(`${name}/`),
    health: async () => ({ name, state: 'ready' }),
    chat: async function* (request): AsyncIterable<ChatDelta> {
      requests.push(request)
      yield { content: 'ok', internal_session_id: request.session_id ? 'internal-session' : undefined }
      yield { finish_reason: 'stop' }
    },
  }
}

function request(
  model: string,
  options: {
    readonly token?: string
    readonly runId?: string
    readonly sessionId?: string
  } = {},
): Request {
  return new Request('http://127.0.0.1/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { [PROTECTED_MODEL_CREDENTIAL_HEADER]: options.token }),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      ...(options.runId === undefined ? {} : { run_id: options.runId }),
      ...(options.sessionId === undefined ? {} : { session_id: options.sessionId }),
    }),
  })
}

function bind(requestValue: Request, address = '127.0.0.1'): Request {
  bindIncomingRequest(requestValue, {
    socket: { remoteAddress: address },
  } as never)
  return requestValue
}

describe('protected model credential bridge channel', () => {
  it('keeps the token out of the body, session, response, and durable run record', async () => {
    const { store: sessions, records } = memorySessions()
    const runs = new RunRegistry()
    const requests: ChatRequest[] = []
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(fakeBackend('pi', requests)),
      sessions,
      runs,
    })
    const secret = 'protected-request-secret-keep-out-of-artifacts'
    const first = bind(request('pi/provider/model', {
      token: secret,
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))

    const response = await app.fetch(first)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain(secret)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.protectedModelCredential?.token).toBe(secret)

    const session = records.get('pi:protected-session')
    expect(JSON.stringify(session?.metadata ?? {})).not.toContain(secret)
    const snapshot = runs.get('protected-run')?.snapshot()
    expect(snapshot).toBeDefined()
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(snapshot?.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)

    const same = bind(request('pi/provider/model', {
      token: secret,
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))
    expect((await app.fetch(same)).status).toBe(200)
    expect(requests).toHaveLength(1)

    const changed = bind(request('pi/provider/model', {
      token: 'different-protected-request-secret',
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))
    const conflict = await app.fetch(changed)
    expect(conflict.status).toBe(409)
    const conflictBody = await conflict.text()
    expect(conflictBody).not.toContain(secret)
    expect(conflictBody).not.toContain('different-protected-request-secret')
  })

  it('preserves the no-header path and rejects non-Pi or non-loopback callers', async () => {
    const { store: sessions } = memorySessions()
    const runs = new RunRegistry()
    const piRequests: ChatRequest[] = []
    const claudeRequests: ChatRequest[] = []
    const app = new Hono()
    const registry = new BackendRegistry()
      .register(fakeBackend('pi', piRequests))
      .register(fakeBackend('claude', claudeRequests))
    mountChatCompletions(app, { registry, sessions, runs })

    const noHeader = bind(request('pi/provider/model'))
    expect((await app.fetch(noHeader)).status).toBe(200)
    expect(piRequests[0]?.protectedModelCredential).toBeUndefined()

    const nonPi = bind(request('claude/provider/model', { token: 'non-pi-secret' }))
    const nonPiResponse = await app.fetch(nonPi)
    expect(nonPiResponse.status).toBe(400)
    expect(await nonPiResponse.text()).not.toContain('non-pi-secret')
    expect(claudeRequests).toHaveLength(0)

    const remote = bind(request('pi/provider/model', { token: 'remote-secret' }), '10.20.30.40')
    const remoteResponse = await app.fetch(remote)
    expect(remoteResponse.status).toBe(403)
    expect(await remoteResponse.text()).not.toContain('remote-secret')
    expect(piRequests).toHaveLength(1)
  })
})
