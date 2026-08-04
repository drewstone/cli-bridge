import { execFileSync } from 'node:child_process'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { PiBackend, piToolProcessEnvironment } from '../src/backends/pi.js'
import {
  createPiInferenceTransportResolver,
  provisionPiInferenceTransport,
} from '../src/backends/pi-inference-transport.js'
import type {
  PiApiMode,
  ResolvedPiInferenceTransport,
} from '../src/backends/pi-inference-transport.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { Spawner } from '../src/executors/types.js'
import { scopedHostSpawner } from '../src/executors/scoped-host.js'
import type { SessionRecord } from '../src/sessions/store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function resolvePiBin(): string | null {
  const configured = process.env.PI_BIN?.trim()
  if (configured && existsSync(configured)) return configured
  try {
    const found = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

const realPiBin = resolvePiBin()

const SENTINELS = {
  TANGLE_API_KEY: 'daemon-tangle-sentinel-113',
  OPENAI_API_KEY: 'daemon-openai-sentinel-113',
  ANTHROPIC_API_KEY: 'daemon-anthropic-sentinel-113',
  GH_TOKEN: 'daemon-github-sentinel-113',
} as const

describe('Pi inference credential isolation', () => {
  it('starts from an allowlist, so ambient provider aliases never reach a child or descendant', () => {
    const childEnv = piToolProcessEnvironment({
      HOME: '/home/test',
      PATH: process.env.PATH,
      ...SENTINELS,
      DEEPSEEK_API_KEY: 'daemon-deepseek-sentinel-113',
      FUTURE_PROVIDER_SECRET: 'daemon-future-sentinel-113',
    }, {
      PI_CODING_AGENT_DIR: '/tmp/request-pi',
      PI_CODING_AGENT_SESSION_DIR: '/tmp/request-pi-sessions',
    })

    const output = execFileSync('/bin/bash', [
      '-lc',
      'env; tr "\\000" "\\n" </proc/self/environ; /bin/sh -c \'env; tr "\\000" "\\n" </proc/self/environ\'',
    ], { env: childEnv, encoding: 'utf8' })

    for (const [key, value] of Object.entries(SENTINELS)) {
      expect(childEnv).not.toHaveProperty(key)
      expect(output).not.toContain(`${key}=`)
      expect(output).not.toContain(value)
    }
    for (const value of ['daemon-deepseek-sentinel-113', 'daemon-future-sentinel-113']) {
      expect(output).not.toContain(value)
    }
    expect(childEnv.PI_CODING_AGENT_DIR).toBe('/tmp/request-pi')
  })

  it('pins explicit Pi config and closes the scoped model-only transport after one run', async () => {
    const cwd = tempDir('cli-bridge-pi-transport-')
    const sourceAgentDir = tempDir('cli-bridge-pi-config-')
    const sourceSessionDir = tempDir('cli-bridge-pi-sessions-')
    const fakePi = join(tempDir('cli-bridge-pi-auth-bin-'), 'pi')
    writeFileSync(fakePi, [
      '#!/bin/sh',
      'test "$1" = auth',
      'test "$2" = print-api-key',
      'test "$3" = --provider',
      'test "$4" = isolated-test',
      'test "$5" = --model',
      'test "$6" = credential-check',
      'printf %s "$TEST_PROVIDER_KEY"',
    ].join('\n'))
    chmodSync(fakePi, 0o700)

    const seen: Array<{ path: string; authorization: string; body: string }> = []
    const upstream = createServer(async (request, response) => {
      seen.push({
        path: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        body: await readBody(request),
      })
      const compressed = gzipSync('{"ok":true}')
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
        'x-reflected-credential': `prefix-${SENTINELS.TANGLE_API_KEY}-suffix`,
      })
      response.end(compressed)
    })
    await listen(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

    writeFileSync(join(sourceAgentDir, 'models.json'), JSON.stringify({
      providers: {
        'isolated-test': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          compat: { maxTokensField: 'max_tokens' },
          models: [{
            id: 'credential-check',
            name: 'Credential check',
            reasoning: true,
            input: ['text'],
            contextWindow: 1_000_000,
            maxTokens: 393_216,
          }],
        },
      },
    }))

    let transport: Awaited<ReturnType<typeof provisionPiInferenceTransport>> | null = null
    try {
      const resolver = createPiInferenceTransportResolver({
        bin: fakePi,
        agentDir: sourceAgentDir,
        sessionDir: sourceSessionDir,
        maxRequestBytes: Number.MAX_SAFE_INTEGER,
        env: { HOME: cwd, PATH: process.env.PATH, TEST_PROVIDER_KEY: SENTINELS.TANGLE_API_KEY },
      })
      const resolved = await resolver(
        { provider: 'isolated-test', model: 'credential-check' },
        new AbortController().signal,
      )
      expect(resolved).toMatchObject({
        upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiMode: 'openai-completions',
        maxRequestBytes: Number.MAX_SAFE_INTEGER,
        sourceSessionDir,
        modelConfig: {
          contextWindow: 1_000_000,
          maxTokens: 393_216,
        },
      })

      transport = await provisionPiInferenceTransport(resolved, { projectDir: cwd })
      const localConfig = JSON.parse(readFileSync(join(transport.agentDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { apiKey: string }>
      }
      const scopedToken = localConfig.providers['isolated-test']?.apiKey
      expect(scopedToken).toBeTruthy()
      expect(scopedToken).not.toBe(SENTINELS.TANGLE_API_KEY)

      const response = await fetch(`${transport.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
        body: '{"model":"credential-check"}',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('x-reflected-credential')).toBe(`prefix-${scopedToken}-suffix`)
      expect(response.headers.get('x-reflected-credential')).not.toContain(SENTINELS.TANGLE_API_KEY)
      expect(await response.json()).toEqual({ ok: true })
      expect(seen).toEqual([{
        path: '/v1/chat/completions',
        authorization: `Bearer ${SENTINELS.TANGLE_API_KEY}`,
        body: '{"model":"credential-check"}',
      }])

      const unrelated = await fetch(`${transport.localBaseUrl}/candidate-model-grants/reserve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedToken}` },
      })
      expect(unrelated.status).toBe(404)
      expect(seen).toHaveLength(1)
      expect(transport.traffic()).toEqual({
        requests: 2,
        generationRequests: 1,
        auxiliaryRequests: 0,
        rejectedRequests: 1,
        failedRequests: 0,
        inFlightRequests: 0,
      })

      const localBaseUrl = transport.localBaseUrl
      await transport.cleanup()
      transport = null
      await expect(fetch(`${localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedToken}` },
      })).rejects.toThrow()
    } finally {
      await transport?.cleanup()
      await close(upstream)
    }
  })

  it('binds every supported Pi protocol to the selected model before forwarding', async () => {
    interface ProtocolCase {
      apiMode: PiApiMode
      model: string
      accepted: Array<{ path: string; kind: 'generation' | 'auxiliary'; body?: string }>
      rejected: { path: string; body?: string }
      authInQuery?: boolean
      upstreamBasePath?: string
    }

    const bodyCase = (apiMode: PiApiMode, path: string): ProtocolCase => ({
      apiMode,
      model: 'credential-check',
      accepted: [{
        path,
        kind: 'generation',
        body: '{"model":"credential-check","unchanged":true}',
      }],
      rejected: { path, body: '{"model":"another-model"}' },
    })
    const cases: ProtocolCase[] = [
      bodyCase('openai-completions', '/chat/completions'),
      bodyCase('openai-responses', '/responses'),
      bodyCase('azure-openai-responses', '/responses'),
      {
        apiMode: 'azure-openai-responses',
        model: 'credential-check',
        upstreamBasePath: '/openai/deployments/credential-check',
        accepted: [{
          path: '/responses',
          kind: 'generation',
          body: '',
        }],
        rejected: {
          path: '/responses',
          body: '{"model":"another-model"}',
        },
      },
      bodyCase('openai-codex-responses', '/codex/responses'),
      bodyCase('anthropic-messages', '/v1/messages'),
      bodyCase('mistral-conversations', '/v1/chat/completions'),
      {
        apiMode: 'google-generative-ai',
        model: 'tunedModels/credential-check',
        authInQuery: true,
        accepted: [
          {
            path: '/tunedModels/credential-check:streamGenerateContent',
            kind: 'generation',
          },
          { path: '/tunedModels/credential-check:countTokens', kind: 'auxiliary' },
        ],
        rejected: { path: '/models/another-model:streamGenerateContent' },
      },
      {
        apiMode: 'google-vertex',
        model: 'projects/project-a/locations/us-central1/publishers/google/models/credential-check',
        authInQuery: true,
        accepted: [
          {
            path: '/v1/projects/project-a/locations/us-central1/publishers/google/models/credential-check:streamGenerateContent',
            kind: 'generation',
          },
          {
            path: '/v1/projects/project-a/locations/us-central1/publishers/google/models/credential-check:countTokens',
            kind: 'auxiliary',
          },
        ],
        rejected: {
          path: '/v1/projects/project-a/locations/us-central1/publishers/google/models/another-model:streamGenerateContent',
        },
      },
      {
        apiMode: 'bedrock-converse-stream',
        model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/profile-name',
        accepted: [{
          path: `/model/${encodeURIComponent('arn:aws:bedrock:us-east-1:123456789012:inference-profile/profile-name')}/converse-stream`,
          kind: 'generation',
        }],
        rejected: {
          path: `/model/${encodeURIComponent('arn:aws:bedrock:us-east-1:123456789012:inference-profile/another-model')}/converse-stream`,
        },
      },
    ]

    for (const protocol of cases) {
      const upstreamRequests: Array<{ path: string; body: string }> = []
      const upstream = createServer(async (request, response) => {
        upstreamRequests.push({
          path: request.url ?? '',
          body: await readBody(request),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      await listen(upstream)
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

      let transport: Awaited<ReturnType<typeof provisionPiInferenceTransport>> | null = null
      try {
        transport = await provisionPiInferenceTransport(fixtureTransport({
          model: protocol.model,
          upstreamBaseUrl: `http://127.0.0.1:${address.port}${protocol.upstreamBasePath ?? ''}`,
          apiMode: protocol.apiMode,
          providerConfig: { api: protocol.apiMode },
          modelConfig: {
            ...fixtureTransport().modelConfig,
            id: protocol.model,
            api: protocol.apiMode,
          },
        }))
        const localConfig = JSON.parse(readFileSync(join(transport.agentDir, 'models.json'), 'utf8')) as {
          providers: Record<string, { apiKey: string }>
        }
        const scopedToken = localConfig.providers['isolated-test']!.apiKey

        for (const accepted of protocol.accepted) {
          const suffix = protocol.authInQuery
            ? `${accepted.path}?key=${encodeURIComponent(scopedToken)}`
            : accepted.path
          const response = await fetch(`${transport.localBaseUrl}${suffix}`, {
            method: 'POST',
            headers: {
              ...(!protocol.authInQuery ? { authorization: `Bearer ${scopedToken}` } : {}),
              'content-type': 'application/json',
            },
            body: accepted.body ?? '{}',
          })
          expect(response.status, `${protocol.apiMode} accepted route`).toBe(200)
        }

        const rejectedSuffix = protocol.authInQuery
          ? `${protocol.rejected.path}?key=${encodeURIComponent(scopedToken)}`
          : protocol.rejected.path
        const rejected = await fetch(`${transport.localBaseUrl}${rejectedSuffix}`, {
          method: 'POST',
          headers: {
            ...(!protocol.authInQuery ? { authorization: `Bearer ${scopedToken}` } : {}),
            'content-type': 'application/json',
          },
          body: protocol.rejected.body ?? '{}',
        })
        expect(rejected.status, `${protocol.apiMode} wrong model`).toBe(403)
        expect(upstreamRequests, `${protocol.apiMode} upstream requests`).toHaveLength(
          protocol.accepted.length,
        )
        for (const accepted of protocol.accepted) {
          if (accepted.body) {
            expect(upstreamRequests.some((seen) => seen.body === accepted.body)).toBe(true)
          }
        }

        expect(transport.traffic()).toEqual({
          requests: protocol.accepted.length + 1,
          generationRequests: protocol.accepted.filter((request) => request.kind === 'generation').length,
          auxiliaryRequests: protocol.accepted.filter((request) => request.kind === 'auxiliary').length,
          rejectedRequests: 1,
          failedRequests: 0,
          inFlightRequests: 0,
        })
      } finally {
        await transport?.cleanup()
        await close(upstream)
      }
    }
  })

  it('rejects an over-limit chunked request before any upstream call', async () => {
    let upstreamRequests = 0
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1
      response.end('{}')
    })
    await listen(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

    const transport = await provisionPiInferenceTransport(fixtureTransport({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRequestBytes: 64,
    }))
    try {
      const localConfig = JSON.parse(readFileSync(join(transport.agentDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { apiKey: string }>
      }
      const scopedToken = localConfig.providers['isolated-test']!.apiKey
      const response = await fetch(`${transport.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'content-type': 'application/json',
        },
        body: Readable.from(['x'.repeat(32), 'x'.repeat(33)]) as never,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

      expect(response.status).toBe(413)
      expect(upstreamRequests).toBe(0)
      expect(transport.traffic()).toEqual({
        requests: 1,
        generationRequests: 0,
        auxiliaryRequests: 0,
        rejectedRequests: 1,
        failedRequests: 0,
        inFlightRequests: 0,
      })
    } finally {
      await transport.cleanup()
      await close(upstream)
    }
  })

  it('rejects a client abort while buffering without forwarding a partial request', async () => {
    let upstreamRequests = 0
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1
      response.end('{}')
    })
    await listen(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

    const transport = await provisionPiInferenceTransport(fixtureTransport({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRequestBytes: 1024,
    }))
    try {
      const localConfig = JSON.parse(readFileSync(join(transport.agentDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { apiKey: string }>
      }
      const scopedToken = localConfig.providers['isolated-test']!.apiKey
      const request = httpRequest(`${transport.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      })
      const requestClosed = new Promise<void>((resolvePromise) => {
        request.once('error', () => resolvePromise())
        request.once('close', () => resolvePromise())
      })
      request.write('{"model":"credential-check","unfinished":"')
      await waitFor(() => transport.traffic().requests === 1)
      request.destroy()
      await requestClosed
      await waitFor(() => transport.traffic().rejectedRequests === 1)

      expect(upstreamRequests).toBe(0)
      expect(transport.traffic()).toEqual({
        requests: 1,
        generationRequests: 0,
        auxiliaryRequests: 0,
        rejectedRequests: 1,
        failedRequests: 0,
        inFlightRequests: 0,
      })
    } finally {
      await transport.cleanup()
      await close(upstream)
    }
  })

  it('redacts an upstream credential split across streamed response chunks', async () => {
    const upstreamKey = 'sk_test_AZaz09-_+/=%25'
    const split = 11
    const upstream = createServer(async (request, response) => {
      await readBody(request)
      response.writeHead(502, { 'content-type': 'application/json' })
      response.write(`{"error":"percent%2F${upstreamKey.slice(0, split)}`)
      setTimeout(() => response.end(
        `${upstreamKey.slice(split)}%3Dbase64_${upstreamKey}ZZ"}`,
      ), 10)
    })
    await listen(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

    const transport = await provisionPiInferenceTransport(fixtureTransport({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      upstreamApiKey: upstreamKey,
    }))
    try {
      const localConfig = JSON.parse(readFileSync(join(transport.agentDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { apiKey: string }>
      }
      const scopedToken = localConfig.providers['isolated-test']!.apiKey
      const response = await fetch(`${transport.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'content-type': 'application/json',
        },
        body: '{"model":"credential-check"}',
      })
      const body = await response.text()

      expect(response.status).toBe(502)
      expect(body).toBe(`{"error":"percent%2F${scopedToken}%3Dbase64_${scopedToken}ZZ"}`)
      expect(body).not.toContain(upstreamKey)
    } finally {
      await transport.cleanup()
      await close(upstream)
    }
  })

  it('fails before opening a proxy when a provider model cannot be bound exactly', async () => {
    await expect(provisionPiInferenceTransport(fixtureTransport({
      model: 'partner/model/ambiguous-tail',
      apiMode: 'google-vertex',
      providerConfig: { api: 'google-vertex' },
      modelConfig: {
        ...fixtureTransport().modelConfig,
        id: 'partner/model/ambiguous-tail',
        api: 'google-vertex',
      },
    }))).rejects.toThrow(/cannot bind google-vertex model/u)

    await expect(provisionPiInferenceTransport(fixtureTransport({
      upstreamBaseUrl: 'https://azure.example/openai/deployments/another-model',
      apiMode: 'azure-openai-responses',
      providerConfig: { api: 'azure-openai-responses' },
      modelConfig: {
        ...fixtureTransport().modelConfig,
        api: 'azure-openai-responses',
      },
    }))).rejects.toThrow(/Azure deployment.*does not match selected model/u)
  })

  it('uses one opaque persistent directory per external session and rejects workspace aliases', async () => {
    const cwd = tempDir('cli-bridge-pi-session-cwd-')
    const sourceSessionDir = tempDir('cli-bridge-pi-session-root-')
    const resolved = fixtureTransport({ sourceSessionDir })
    const provisioned: Array<Awaited<ReturnType<typeof provisionPiInferenceTransport>>> = []
    try {
      const first = await provisionPiInferenceTransport(resolved, {
        sessionId: 'customer-visible-session-alpha',
        projectDir: cwd,
      })
      provisioned.push(first)
      const resumed = await provisionPiInferenceTransport(resolved, {
        sessionId: 'customer-visible-session-alpha',
        projectDir: cwd,
      })
      provisioned.push(resumed)
      const other = await provisionPiInferenceTransport(resolved, {
        sessionId: 'customer-visible-session-beta',
        projectDir: cwd,
      })
      provisioned.push(other)

      expect(first.sessionDir).toBe(resumed.sessionDir)
      expect(other.sessionDir).not.toBe(first.sessionDir)
      expect(first.sessionDir.startsWith(join(sourceSessionDir, 'cli-bridge'))).toBe(true)
      expect(basename(first.sessionDir)).toMatch(/^[a-f0-9]{64}$/u)
      expect(first.sessionDir).not.toContain('customer-visible-session-alpha')

      await expect(provisionPiInferenceTransport(
        fixtureTransport({ sourceSessionDir: join(cwd, 'sessions') }),
        { sessionId: 'inside', projectDir: cwd },
      )).rejects.toThrow(/inside the readable workspace/u)

      const alias = join(tempDir('cli-bridge-pi-session-alias-'), 'sessions')
      symlinkSync(cwd, alias)
      await expect(provisionPiInferenceTransport(
        fixtureTransport({ sourceSessionDir: alias }),
        { sessionId: 'symlinked-inside', projectDir: cwd },
      )).rejects.toThrow(/resolves inside the readable workspace/u)
    } finally {
      await Promise.all(provisioned.map(async (transport) => transport.cleanup()))
    }
  })

  it('refuses a production host Pi run before auth unless real read isolation was requested', async () => {
    let authResolutions = 0
    const spawner: Spawner = async () => {
      throw new Error('must not spawn')
    }
    spawner.executionEnvironment = 'host'
    const backend = new PiBackend({
      bin: realPiBin ?? 'pi',
      timeoutMs: 0,
      spawner,
      transportResolver: async () => {
        authResolutions += 1
        return fixtureTransport()
      },
    })

    await expect(collect(backend.chat({
      model: 'pi/isolated-test/credential-check',
      messages: [{ role: 'user', content: 'work' }],
      cwd: tempDir('cli-bridge-pi-no-jail-'),
    }, null, new AbortController().signal))).rejects.toThrow(/requires an enforced Linux fs-jail/u)
    expect(authResolutions).toBe(0)
  })

  it('refuses an undeclared custom executor before auth instead of assuming it is isolated', async () => {
    let authResolutions = 0
    const spawner: Spawner = async () => {
      throw new Error('must not spawn')
    }
    const backend = new PiBackend({
      bin: realPiBin ?? 'pi',
      timeoutMs: 0,
      spawner,
      transportResolver: async () => {
        authResolutions += 1
        return fixtureTransport()
      },
    })

    await expect(collect(backend.chat({
      model: 'pi/isolated-test/credential-check',
      messages: [{ role: 'user', content: 'work' }],
      cwd: tempDir('cli-bridge-pi-unknown-executor-'),
    }, null, new AbortController().signal))).rejects.toThrow(/executor that declares/u)
    expect(authResolutions).toBe(0)
  })

  it('does not expose auth-command stderr and refuses model headers before invoking auth', async () => {
    const sourceAgentDir = tempDir('cli-bridge-pi-invalid-config-')
    const fakePi = join(tempDir('cli-bridge-pi-leaky-auth-bin-'), 'pi')
    const leaked = 'provider-secret-from-stderr'
    writeFileSync(fakePi, [
      '#!/bin/sh',
      `printf %s '${leaked}' >&2`,
      'exit 1',
    ].join('\n'))
    chmodSync(fakePi, 0o700)

    writeFileSync(join(sourceAgentDir, 'models.json'), JSON.stringify({
      providers: {
        'isolated-test': {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          models: [{
            id: 'credential-check',
            headers: { 'x-hidden-auth': leaked },
          }],
        },
      },
    }))

    const resolver = createPiInferenceTransportResolver({ bin: fakePi, agentDir: sourceAgentDir })
    await expect(resolver(
      { provider: 'isolated-test', model: 'credential-check' },
      new AbortController().signal,
    )).rejects.not.toThrow(leaked)

    writeFileSync(join(sourceAgentDir, 'models.json'), JSON.stringify({
      providers: {
        'isolated-test': {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          models: [{ id: 'credential-check' }],
        },
      },
    }))
    await expect(resolver(
      { provider: 'isolated-test', model: 'credential-check' },
      new AbortController().signal,
    )).rejects.toThrow(/cannot establish isolated inference auth/u)
    await expect(resolver(
      { provider: 'isolated-test', model: 'credential-check' },
      new AbortController().signal,
    )).rejects.not.toThrow(leaked)
  })

  it.skipIf(!realPiBin)(
    'confines a real Pi Bash turn to its workspace and exact persistent session',
    async () => {
      const cwd = tempDir('cli-bridge-pi-real-isolation-')
      const sourceAgentDir = tempDir('cli-bridge-pi-source-')
      const sourceSessionDir = tempDir('cli-bridge-pi-real-sessions-')
      const hostSecretDir = tempDir('cli-bridge-pi-host-secret-')
      const hostSecretPath = join(hostSecretDir, 'credential.txt')
      const hostSecretSentinel = 'controlled-host-credential-sentinel-113'
      writeFileSync(hostSecretPath, hostSecretSentinel)
      const siblingSessionDir = join(sourceSessionDir, 'sibling-session')
      const siblingSessionPath = join(siblingSessionDir, 'private.txt')
      const siblingSessionSentinel = 'controlled-sibling-session-sentinel-113'
      mkdirSync(siblingSessionDir)
      writeFileSync(siblingSessionPath, siblingSessionSentinel)
      const probeCommand = [
        shellReadProbe('HOST_CREDENTIAL', hostSecretPath, true),
        shellReadProbe('SIBLING_SESSION', siblingSessionPath, true),
        shellReadProbe('PI_MODELS', '/home/drew/.pi/agent/models.json'),
        shellReadProbe('DREW_SECRETS', '/home/drew/company/devops/secrets/.env.keys'),
        'env',
        'tr "\\000" "\\n" </proc/self/environ',
        '/bin/sh -c \'env; tr "\\000" "\\n" </proc/self/environ\'',
      ].join('; ')
      const observedBodies: string[] = []
      const observedAuthorization: string[] = []
      const upstream = createServer((request, response) => {
        void answerOpenAiTurn(
          request,
          response,
          observedBodies,
          observedAuthorization,
          probeCommand,
        )
      })
      await listen(upstream)
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

      const previous = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(SENTINELS)) {
        previous.set(key, process.env[key])
        process.env[key] = value
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        const backend = new PiBackend({
          bin: realPiBin!,
          timeoutMs: 0,
          spawner: scopedHostSpawner,
          transportResolver: async ({ provider, model }) => ({
            provider,
            model,
            upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiMode: 'openai-completions',
            upstreamApiKey: SENTINELS.TANGLE_API_KEY,
            maxRequestBytes: 256 * 1024 * 1024,
            providerConfig: {
              api: 'openai-completions',
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
            },
            modelConfig: {
              id: model,
              name: 'Credential isolation fixture',
              api: 'openai-completions',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4_096,
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
            },
            sourceAgentDir,
            sourceSessionDir,
          }),
        })
        const externalSessionId = 'customer-visible-session-alpha'
        const request: ChatRequest = {
          model: 'pi/isolated-test/credential-check',
          messages: [{ role: 'user', content: 'Run the requested process check, then report completion.' }],
          cwd,
          session_id: externalSessionId,
          jailSpec: {
            root: join(cwd, '.agent-home'),
            projectDir: cwd,
            readConfine: true,
          },
          agent_profile: {
            harness: 'pi',
            model: { provider: 'isolated-test', default: 'credential-check' },
            prompt: { systemPrompt: 'Execute the supplied Bash tool call exactly.' },
            extensions: { pi: { load: [] } },
          },
        }

        const deltas: ChatDelta[] = []
        for await (const delta of backend.chat(request, null, controller.signal)) deltas.push(delta)

        expect(deltas.some((delta) => delta.content?.includes('credential-isolation-ok'))).toBe(true)
        // Pi executes the tool internally but the bridge retains the observed
        // tool-call terminal marker for downstream trace consumers.
        expect(deltas.at(-1)?.finish_reason).toBe('tool_calls')
        expect(observedBodies).toHaveLength(2)
        expect(observedAuthorization).toEqual([
          `Bearer ${SENTINELS.TANGLE_API_KEY}`,
          `Bearer ${SENTINELS.TANGLE_API_KEY}`,
        ])
        expect(observedBodies[1]).toContain('READ_BLOCKED_HOST_CREDENTIAL')
        expect(observedBodies[1]).toContain('READ_BLOCKED_SIBLING_SESSION')
        expect(observedBodies[1]).toContain('READ_BLOCKED_PI_MODELS')
        expect(observedBodies[1]).toContain('READ_BLOCKED_DREW_SECRETS')
        expect(observedBodies[1]).not.toContain(hostSecretSentinel)
        expect(observedBodies[1]).not.toContain(siblingSessionSentinel)
        for (const [key, sentinel] of Object.entries(SENTINELS)) {
          expect(observedBodies[1]).not.toContain(`${key}=`)
          expect(observedBodies[1]).not.toContain(sentinel)
        }
        expect(request.profile_materialization_receipt?.inference).toMatchObject({
          effectiveEndpoint: `http://127.0.0.1:${address.port}/v1`,
          apiMode: 'openai-completions',
          transport: 'scoped-loopback',
          observation: {
            requests: 2,
            generationRequests: 2,
            auxiliaryRequests: 0,
            usageReceipts: 2,
            rejectedRequests: 0,
            failedRequests: 0,
            inFlightRequests: 0,
            accountingMatched: true,
            usage: {
              inputTokens: 20,
              cacheReadInputTokens: 0,
              outputTokens: 4,
              costKnown: false,
            },
          },
        })
        expect(deltas).toContainEqual({ usage: { model_requests: 2, cost_known: false } })

        const internalId = deltas.find((delta) => delta.internal_session_id)?.internal_session_id
        expect(internalId).toBeTruthy()
        const sessionParent = join(sourceSessionDir, 'cli-bridge')
        expect(readdirSync(sessionParent)).toHaveLength(1)
        const persistedSessionDir = join(sessionParent, readdirSync(sessionParent)[0]!)
        expect(basename(persistedSessionDir)).toMatch(/^[a-f0-9]{64}$/u)
        expect(persistedSessionDir).not.toContain(externalSessionId)
        expect(allFiles(persistedSessionDir).some((path) => path.endsWith('.jsonl'))).toBe(true)

        const session: SessionRecord = {
          externalId: externalSessionId,
          backend: 'pi',
          internalId: internalId!,
          cwd,
          turns: 1,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          metadata: {},
        }
        const resumedRequest: ChatRequest = {
          ...request,
          messages: [{ role: 'user', content: 'Confirm this is the same exact Pi session.' }],
          jailSpec: {
            root: join(cwd, '.agent-home-resumed'),
            projectDir: cwd,
            readConfine: true,
          },
        }
        delete resumedRequest.profile_materialization_receipt
        const resumedDeltas: ChatDelta[] = []
        for await (const delta of backend.chat(resumedRequest, session, controller.signal)) {
          resumedDeltas.push(delta)
        }

        expect(resumedDeltas.some((delta) => delta.content?.includes('session-continuation-ok'))).toBe(true)
        expect(observedBodies).toHaveLength(3)
        expect(observedBodies[2]).toContain('Run the requested process check')
        expect(observedBodies[2]).toContain('READ_BLOCKED_HOST_CREDENTIAL')
        expect(observedBodies[2]).toContain('Confirm this is the same exact Pi session')
        expect(readdirSync(sessionParent)).toHaveLength(1)
        const resumedReceipt = resumedDeltas.findLast(
          (delta) => delta.profile_materialization?.inference?.observation !== undefined,
        )?.profile_materialization
        expect(resumedReceipt?.inference?.observation).toMatchObject({
          requests: 1,
          generationRequests: 1,
          usageReceipts: 1,
          accountingMatched: true,
          usage: { costKnown: false },
        })
      } finally {
        clearTimeout(timer)
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        await close(upstream)
      }
    },
    70_000,
  )

  it.skipIf(!realPiBin)(
    'records and refuses an extra model request made directly by a real Pi Bash tool',
    async () => {
      const cwd = tempDir('cli-bridge-pi-proxy-bypass-')
      const sourceAgentDir = tempDir('cli-bridge-pi-bypass-source-')
      const sourceSessionDir = tempDir('cli-bridge-pi-bypass-sessions-')
      const manualRequestMarker = 'manual-proxy-bypass'
      const nodeScript = [
        "const fs=require('node:fs')",
        "const cfg=JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.json','utf8'))",
        "const provider=cfg.providers['isolated-test']",
        `const body=JSON.stringify({model:'credential-check',messages:[{role:'user',content:'${manualRequestMarker}'}],stream:false})`,
        "fetch(provider.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+provider.apiKey,'content-type':'application/json'},body}).then(async response=>{if(!response.ok)throw new Error('manual request '+response.status);console.log('manual-response:'+await response.text())}).catch(error=>{console.error(error.message);process.exit(1)})",
      ].join(';')
      const bypassCommand = `node -e ${shellQuote(nodeScript)}`
      const observedBodies: string[] = []
      const observedAuthorization: string[] = []
      const upstream = createServer((request, response) => {
        void answerProxyBypassTurn(
          request,
          response,
          observedBodies,
          observedAuthorization,
          bypassCommand,
          manualRequestMarker,
        )
      })
      await listen(upstream)
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 40_000)
      try {
        const backend = new PiBackend({
          bin: realPiBin!,
          timeoutMs: 0,
          spawner: scopedHostSpawner,
          transportResolver: async ({ provider, model }) => ({
            ...fixtureTransport({
              provider,
              model,
              upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
              upstreamApiKey: SENTINELS.TANGLE_API_KEY,
              sourceAgentDir,
              sourceSessionDir,
              modelConfig: {
                ...fixtureTransport().modelConfig,
                id: model,
                name: 'Proxy accounting fixture',
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            }),
          }),
        })
        const request: ChatRequest = {
          model: 'pi/isolated-test/credential-check',
          messages: [{ role: 'user', content: 'Run the supplied accounting probe.' }],
          cwd,
          session_id: 'proxy-accounting-session',
          jailSpec: {
            root: join(cwd, '.agent-home'),
            projectDir: cwd,
            readConfine: true,
          },
          agent_profile: {
            harness: 'pi',
            model: { provider: 'isolated-test', default: 'credential-check' },
            prompt: { systemPrompt: 'Execute the supplied Bash tool call exactly.' },
            extensions: { pi: { load: [] } },
          },
        }

        const deltas: ChatDelta[] = []
        let failure: unknown
        try {
          for await (const delta of backend.chat(request, null, controller.signal)) deltas.push(delta)
        } catch (error) {
          failure = error
        }

        expect(observedBodies).toHaveLength(3)
        expect(observedBodies[1]).toContain(manualRequestMarker)
        expect(observedAuthorization).toEqual(Array(3).fill(`Bearer ${SENTINELS.TANGLE_API_KEY}`))
        expect(deltas.filter((delta) => delta.usage?.input_tokens !== undefined)).toEqual([
          { usage: { input_tokens: 10, fresh_input_tokens: 10, cache_read_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 } },
          { usage: { input_tokens: 10, fresh_input_tokens: 10, cache_read_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 } },
        ])
        expect(deltas).toContainEqual({ usage: { model_requests: 3, cost_known: false } })
        const completedReceipt = deltas.findLast(
          (delta) => delta.profile_materialization?.inference?.observation !== undefined,
        )?.profile_materialization
        expect(completedReceipt?.inference?.observation).toMatchObject({
          requests: 3,
          generationRequests: 3,
          auxiliaryRequests: 0,
          usageReceipts: 2,
          rejectedRequests: 0,
          failedRequests: 0,
          inFlightRequests: 0,
          accountingMatched: false,
          usage: {
            inputTokens: 20,
            outputTokens: 4,
            costKnown: false,
          },
        })
        expect(request.profile_materialization_receipt).toEqual(completedReceipt)
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toMatch(
          /3 generation request\(s\), 2 Pi usage receipt\(s\)/u,
        )
      } finally {
        clearTimeout(timer)
        await close(upstream)
      }
    },
    50_000,
  )

  it.skipIf(!realPiBin)(
    'rejects a wrong-model request from a real Pi Bash tool and preserves failure evidence',
    async () => {
      const cwd = tempDir('cli-bridge-pi-wrong-model-')
      const sourceAgentDir = tempDir('cli-bridge-pi-wrong-model-source-')
      const sourceSessionDir = tempDir('cli-bridge-pi-wrong-model-sessions-')
      const manualRequestMarker = 'manual-wrong-model-probe'
      const nodeScript = [
        "const fs=require('node:fs')",
        "const cfg=JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.json','utf8'))",
        "const provider=cfg.providers['isolated-test']",
        `const body=JSON.stringify({model:'another-model',messages:[{role:'user',content:'${manualRequestMarker}'}],stream:false})`,
        "fetch(provider.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+provider.apiKey,'content-type':'application/json'},body}).then(async response=>{if(!response.ok)throw new Error('manual request '+response.status);console.log('manual-response:'+await response.text())}).catch(error=>{console.error(error.message);process.exit(1)})",
      ].join(';')
      const bypassCommand = `node -e ${shellQuote(nodeScript)}`
      const observedBodies: string[] = []
      const observedAuthorization: string[] = []
      const upstream = createServer((request, response) => {
        void answerProxyBypassTurn(
          request,
          response,
          observedBodies,
          observedAuthorization,
          bypassCommand,
          manualRequestMarker,
        )
      })
      await listen(upstream)
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('fake upstream did not listen')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 40_000)
      try {
        const backend = new PiBackend({
          bin: realPiBin!,
          timeoutMs: 0,
          spawner: scopedHostSpawner,
          transportResolver: async ({ provider, model }) => ({
            ...fixtureTransport({
              provider,
              model,
              upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
              upstreamApiKey: SENTINELS.TANGLE_API_KEY,
              sourceAgentDir,
              sourceSessionDir,
              modelConfig: {
                ...fixtureTransport().modelConfig,
                id: model,
                name: 'Wrong-model fixture',
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            }),
          }),
        })
        const request: ChatRequest = {
          model: 'pi/isolated-test/credential-check',
          messages: [{ role: 'user', content: 'Run the supplied wrong-model probe.' }],
          cwd,
          session_id: 'wrong-model-session',
          jailSpec: {
            root: join(cwd, '.agent-home'),
            projectDir: cwd,
            readConfine: true,
          },
          agent_profile: {
            harness: 'pi',
            model: { provider: 'isolated-test', default: 'credential-check' },
            prompt: { systemPrompt: 'Execute the supplied Bash tool call exactly.' },
            extensions: { pi: { load: [] } },
          },
        }

        const deltas: ChatDelta[] = []
        let failure: unknown
        try {
          for await (const delta of backend.chat(request, null, controller.signal)) deltas.push(delta)
        } catch (error) {
          failure = error
        }

        expect(observedBodies).toHaveLength(2)
        expect(observedBodies.some((body) => isManualProbeRequest(body, manualRequestMarker))).toBe(false)
        expect(observedBodies[1]).toContain('manual request 403')
        expect(observedAuthorization).toEqual(Array(2).fill(`Bearer ${SENTINELS.TANGLE_API_KEY}`))
        expect(deltas.filter((delta) => delta.usage?.input_tokens !== undefined)).toHaveLength(2)
        expect(deltas).toContainEqual({ usage: { model_requests: 2, cost_known: false } })
        const completedReceipt = completedProfileReceipt(deltas)
        expect(completedReceipt?.inference?.observation).toMatchObject({
          requests: 3,
          generationRequests: 2,
          auxiliaryRequests: 0,
          usageReceipts: 2,
          rejectedRequests: 1,
          failedRequests: 0,
          inFlightRequests: 0,
          accountingMatched: false,
        })
        expect(request.profile_materialization_receipt).toEqual(completedReceipt)
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toMatch(
          /2 generation request\(s\), 2 Pi usage receipt\(s\), 0 auxiliary request\(s\), 1 rejected request\(s\)/u,
        )
      } finally {
        clearTimeout(timer)
        await close(upstream)
      }
    },
    50_000,
  )

  it.skipIf(process.env.CLI_BRIDGE_REAL_PI_ROUTER_TESTS !== '1' || !realPiBin)(
    'preserves prompt-cache usage through real Pi and Tangle Router DeepSeek V4 Flash',
    async () => {
      const cwd = tempDir('cli-bridge-pi-router-cache-')
      const sourceSessionDir = tempDir('cli-bridge-pi-router-sessions-')
      const backend = new PiBackend({
        bin: realPiBin!,
        timeoutMs: 0,
        spawner: scopedHostSpawner,
        transportResolver: createPiInferenceTransportResolver({
          bin: realPiBin!,
          sessionDir: sourceSessionDir,
        }),
      })
      const cachePrefix = Array.from(
        { length: 800 },
        (_, index) => `cache-proof-${String(index).padStart(4, '0')}: deterministic context retained unchanged.`,
      ).join('\n')
      const profile: NonNullable<ChatRequest['agent_profile']> = {
        name: 'deepseek-cache-proof',
        harness: 'pi',
        model: { provider: 'tangle-router', default: 'deepseek-v4-flash' },
        prompt: {
          systemPrompt: `${cachePrefix}\nAnswer with one short sentence. Do not call tools.`,
        },
        extensions: { pi: { load: [] } },
      }
      const externalId = 'deepseek-cache-proof-session'
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 100_000)
      try {
        const firstRequest: ChatRequest = {
          model: 'pi/tangle-router/deepseek-v4-flash',
          messages: [{ role: 'user', content: 'Reply exactly: cache proof first.' }],
          cwd,
          session_id: externalId,
          jailSpec: {
            root: join(cwd, '.agent-home-first'),
            projectDir: cwd,
            readConfine: true,
          },
          agent_profile: profile,
        }
        const first = await collect(backend.chat(firstRequest, null, controller.signal))
        const internalId = first.find((delta) => delta.internal_session_id)?.internal_session_id
        expect(internalId).toBeTruthy()
        const firstReceipt = completedProfileReceipt(first)
        expect(firstReceipt?.inference).toMatchObject({
          effectiveEndpoint: 'https://router.tangle.tools/v1',
          apiMode: 'openai-completions',
          transport: 'scoped-loopback',
          observation: {
            requests: 1,
            generationRequests: 1,
            usageReceipts: 1,
            accountingMatched: true,
            usage: { costKnown: false },
          },
        })

        const session: SessionRecord = {
          externalId,
          backend: 'pi',
          internalId: internalId!,
          cwd,
          turns: 1,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          metadata: {},
        }
        const secondRequest: ChatRequest = {
          model: 'pi/tangle-router/deepseek-v4-flash',
          messages: [{ role: 'user', content: 'Reply exactly: cache proof second.' }],
          cwd,
          session_id: externalId,
          jailSpec: {
            root: join(cwd, '.agent-home-second'),
            projectDir: cwd,
            readConfine: true,
          },
          agent_profile: profile,
        }
        const second = await collect(backend.chat(secondRequest, session, controller.signal))
        const secondReceipt = completedProfileReceipt(second)
        expect(secondReceipt?.effectiveProfileDigest).toBe(firstReceipt?.effectiveProfileDigest)
        expect(secondReceipt?.inference).toMatchObject({
          effectiveEndpoint: 'https://router.tangle.tools/v1',
          apiMode: 'openai-completions',
          transport: 'scoped-loopback',
          observation: {
            requests: 1,
            generationRequests: 1,
            usageReceipts: 1,
            accountingMatched: true,
            usage: { costKnown: false },
          },
        })
        const cacheRead = secondReceipt?.inference?.observation?.usage.cacheReadInputTokens
        expect(cacheRead).toBeTypeOf('number')
        expect(cacheRead).toBeGreaterThan(0)
        console.info(`[pi-router-cache-proof] ${JSON.stringify({
          effectiveProfileDigest: secondReceipt?.effectiveProfileDigest,
          provider: secondReceipt?.provider,
          model: secondReceipt?.model,
          first: firstReceipt?.inference?.observation,
          second: secondReceipt?.inference?.observation,
        })}`)
      } finally {
        clearTimeout(timer)
      }
    },
    120_000,
  )
})

function fixtureTransport(
  overrides: Partial<ResolvedPiInferenceTransport> = {},
): ResolvedPiInferenceTransport {
  return {
    provider: 'isolated-test',
    model: 'credential-check',
    upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    apiMode: 'openai-completions',
    upstreamApiKey: 'test-upstream-key',
    maxRequestBytes: 256 * 1024 * 1024,
    providerConfig: { api: 'openai-completions' },
    modelConfig: {
      id: 'credential-check',
      api: 'openai-completions',
      input: ['text'],
      contextWindow: 32_000,
      maxTokens: 4_096,
    },
    sourceAgentDir: tmpdir(),
    sourceSessionDir: join(tmpdir(), 'cli-bridge-pi-fixture-sessions'),
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = []
  for await (const delta of stream) deltas.push(delta)
  return deltas
}

function shellReadProbe(label: string, path: string, printOnLeak = false): string {
  const quoted = shellQuote(path)
  const leak = printOnLeak ? `; cat ${quoted}` : ''
  return `if [ -r ${quoted} ]; then echo READABLE_${label}${leak}; else echo READ_BLOCKED_${label}; fi`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function allFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...allFiles(path))
    else files.push(path)
  }
  return files
}

function completedProfileReceipt(
  deltas: ChatDelta[],
): ChatDelta['profile_materialization'] {
  return deltas.findLast(
    (delta) => delta.profile_materialization?.inference?.observation !== undefined,
  )?.profile_materialization
}

async function answerOpenAiTurn(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: string[],
  authorizations: string[],
  probeCommand: string,
): Promise<void> {
  const body = await readBody(request)
  bodies.push(body)
  authorizations.push(request.headers.authorization ?? '')
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  if (bodies.length === 1) {
    sendChunk(response, {
      id: 'chatcmpl-isolation-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'credential-check',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_environment_probe',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: probeCommand }) },
          }],
        },
        finish_reason: null,
      }],
    })
    sendChunk(response, {
      id: 'chatcmpl-isolation-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'credential-check',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  } else {
    const content = bodies.length === 2
      ? 'credential-isolation-ok'
      : 'session-continuation-ok'
    sendChunk(response, {
      id: 'chatcmpl-isolation-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'credential-check',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: null,
      }],
    })
    sendChunk(response, {
      id: 'chatcmpl-isolation-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'credential-check',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

async function answerProxyBypassTurn(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: string[],
  authorizations: string[],
  bypassCommand: string,
  manualRequestMarker: string,
): Promise<void> {
  const body = await readBody(request)
  bodies.push(body)
  authorizations.push(request.headers.authorization ?? '')
  const requestNumber = bodies.length

  if (isManualProbeRequest(body, manualRequestMarker)) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: 'chatcmpl-manual-bypass',
      object: 'chat.completion',
      created: 2,
      model: 'credential-check',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'manual request reached provider' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }))
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  if (requestNumber === 1) {
    sendChunk(response, {
      id: 'chatcmpl-bypass-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'credential-check',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_manual_proxy',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: bypassCommand }) },
          }],
        },
        finish_reason: null,
      }],
    })
    sendChunk(response, {
      id: 'chatcmpl-bypass-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'credential-check',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  } else {
    sendChunk(response, {
      id: 'chatcmpl-bypass-2',
      object: 'chat.completion.chunk',
      created: 3,
      model: 'credential-check',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'accounting-probe-finished' },
        finish_reason: null,
      }],
    })
    sendChunk(response, {
      id: 'chatcmpl-bypass-2',
      object: 'chat.completion.chunk',
      created: 3,
      model: 'credential-check',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

function isManualProbeRequest(body: string, marker: string): boolean {
  try {
    const parsed = JSON.parse(body) as { stream?: unknown; messages?: unknown }
    return parsed.stream === false && JSON.stringify(parsed.messages).includes(marker)
  } catch {
    return false
  }
}

function sendChunk(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for proxy observation')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
}
