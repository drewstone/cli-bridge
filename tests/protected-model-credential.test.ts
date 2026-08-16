import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { bindIncomingRequest } from '../src/http/request-source.js'
import {
  PROTECTED_MODEL_BASE_URL_HEADER,
  PROTECTED_MODEL_CREDENTIAL_HEADER,
  mountChatCompletions,
} from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionIdentityConflictError, type SessionRecord, type SessionStore } from '../src/sessions/store.js'

function memorySessions(): { store: SessionStore; records: Map<string, SessionRecord> } {
  const records = new Map<string, SessionRecord>()
  const identities = new Map<string, 'legacy' | 'retained'>()
  const keyFor = (externalId: string, backend: string): string => `${backend}:${externalId}`
  const store = {
    get(externalId: string, backend: string): SessionRecord | null {
      return records.get(keyFor(externalId, backend)) ?? null
    },
    findByExternalId(externalId: string): SessionRecord[] {
      return [...records.values()].filter(record => record.externalId === externalId)
    },
    async acquireExecution(): Promise<{ release(): void }> {
      return { release() {} }
    },
    assertSessionIdentityAvailable(id: string, kind: 'legacy' | 'retained'): void {
      const existing = identities.get(id)
      if (existing && existing !== kind) throw new SessionIdentityConflictError(id, kind, existing)
    },
    claimSessionIdentity(id: string, kind: 'legacy' | 'retained'): void {
      const existing = identities.get(id)
      if (existing && existing !== kind) throw new SessionIdentityConflictError(id, kind, existing)
      identities.set(id, kind)
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
    remember(args: {
      externalId: string
      backend: string
      model: string
      internalId?: string | null
      cwd?: string | null
      metadata?: Record<string, unknown>
    }): SessionRecord {
      identities.set(args.externalId, 'legacy')
      const now = Date.now()
      const existing = records.get(keyFor(args.externalId, args.backend))
      const record: SessionRecord = {
        externalId: args.externalId,
        backend: args.backend,
        internalId: args.internalId ?? existing?.internalId ?? '',
        cwd: args.cwd ?? existing?.cwd ?? null,
        turns: existing?.turns ?? 0,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(args.metadata ?? {}),
          model: args.model,
        },
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
    readonly baseUrl?: string
    readonly runId?: string
    readonly sessionId?: string
  } = {},
): Request {
  return new Request('http://127.0.0.1/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { [PROTECTED_MODEL_CREDENTIAL_HEADER]: options.token }),
      ...(options.baseUrl === undefined ? {} : { [PROTECTED_MODEL_BASE_URL_HEADER]: options.baseUrl }),
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
    const baseUrl = 'https://router.tangle.tools/v1/protected-route'
    const first = bind(request('pi/provider/model', {
      token: secret,
      baseUrl,
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))

    const response = await app.fetch(first)
    expect(response.status).toBe(200)
    const responseBody = await response.text()
    expect(responseBody).not.toContain(secret)
    expect(responseBody).not.toContain('/v1/protected-route')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.protectedModelCredential?.token).toBe(secret)
    expect(requests[0]?.protectedModelCredential?.baseUrl).toBe(baseUrl)
    expect(requests[0]?.protectedModelCredential?.baseUrlDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)

    const session = records.get('pi:protected-session')
    const sessionMetadata = JSON.stringify(session?.metadata ?? {})
    expect(sessionMetadata).not.toContain(secret)
    expect(sessionMetadata).not.toContain('/v1/protected-route')
    const snapshot = runs.get('protected-run')?.snapshot()
    expect(snapshot).toBeDefined()
    const snapshotBody = JSON.stringify(snapshot)
    expect(snapshotBody).not.toContain(secret)
    expect(snapshotBody).not.toContain('/v1/protected-route')
    expect(snapshot?.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)

    const same = bind(request('pi/provider/model', {
      token: secret,
      baseUrl,
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))
    expect((await app.fetch(same)).status).toBe(200)
    expect(requests).toHaveLength(1)

    const changed = bind(request('pi/provider/model', {
      token: 'different-protected-request-secret',
      baseUrl,
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))
    const conflict = await app.fetch(changed)
    expect(conflict.status).toBe(409)
    const conflictBody = await conflict.text()
    expect(conflictBody).not.toContain(secret)
    expect(conflictBody).not.toContain('different-protected-request-secret')

    const changedUrl = bind(request('pi/provider/model', {
      token: secret,
      baseUrl: 'https://router.tangle.tools/v1/another-route',
      runId: 'protected-run',
      sessionId: 'protected-session',
    }))
    const urlConflict = await app.fetch(changedUrl)
    expect(urlConflict.status).toBe(409)
    const urlConflictBody = await urlConflict.text()
    expect(urlConflictBody).not.toContain(baseUrl)
    expect(urlConflictBody).not.toContain('another-route')
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

    const tokenOnly = bind(request('pi/provider/model', { token: 'token-only-secret' }))
    const tokenOnlyResponse = await app.fetch(tokenOnly)
    expect(tokenOnlyResponse.status).toBe(400)
    expect(await tokenOnlyResponse.text()).not.toContain('token-only-secret')
    expect(piRequests).toHaveLength(1)

    const nonPi = bind(request('claude/provider/model', { token: 'non-pi-secret' }))
    const nonPiResponse = await app.fetch(nonPi)
    expect(nonPiResponse.status).toBe(400)
    expect(await nonPiResponse.text()).not.toContain('non-pi-secret')
    expect(claudeRequests).toHaveLength(0)

    const remote = bind(request('pi/provider/model', {
      token: 'remote-secret',
      baseUrl: 'https://router.tangle.tools/v1',
    }), '10.20.30.40')
    const remoteResponse = await app.fetch(remote)
    expect(remoteResponse.status).toBe(403)
    expect(await remoteResponse.text()).not.toContain('remote-secret')
    expect(piRequests).toHaveLength(1)
  })

  it('rejects non-HTTPS protected routes before Pi receives the request', async () => {
    const { store: sessions } = memorySessions()
    const runs = new RunRegistry()
    const piRequests: ChatRequest[] = []
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(fakeBackend('pi', piRequests)),
      sessions,
      runs,
    })

    const response = await app.fetch(bind(request('pi/provider/model', {
      token: 'route-token',
      baseUrl: 'http://router.tangle.tools/v1',
    })))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('router.tangle.tools')
    expect(piRequests).toHaveLength(0)
  })
})
