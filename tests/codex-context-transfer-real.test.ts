/** Real pinned Codex and loopback model fixture; the test never reads account or native history files directly. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalAgentProfileDigest, createContextTransferRequest,
  portableContextPlanDigest, portableConversationContextDigest,
  type AgentProfile, type ContextTransferRequest,
} from '@tangle-network/agent-interface'
import { CodexBackend } from '../src/backends/codex.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner } from '../src/executors/types.js'
import { SessionStore } from '../src/sessions/store.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { ensurePrivateDataDirectory } from '../src/runtime/single-instance.js'

const frozenProfile: AgentProfile = {
  name: 'native-transfer-conformance', harness: 'codex',
  model: { provider: 'fixture', default: 'gpt-5.4', reasoningEffort: 'low' },
  prompt: {
    systemPrompt: 'You are the native context conformance assistant 284e.',
    instructions: ['Native profile instruction 91ca.'],
  },
  resources: { instructions: 'Materialized profile resource 18de.' },
}

const omittedMarker = 'Omitted source note 9d3f.'

function nativeRequest(cwd: string): ContextTransferRequest {
  const boundary = {
    runId: 'source-run', messageId: 'source-assistant', provider: 'tangle', environmentId: 'source-environment',
    sessionId: 'source-session', executionId: 'source-execution', requestDigest: `sha256:${'a'.repeat(64)}` as const,
  }
  const omitted = { id: 'source-omitted', role: 'user' as const, parts: [{ type: 'text' as const, text: omittedMarker }], timestamp: '2026-08-01T19:59:59.000Z' }
  const selected = [
    { id: 'source-user', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Selected user part 74f2.' }, { type: 'text' as const, text: 'Second selected part b51a.' }], timestamp: '2026-08-01T20:00:00.000Z' },
    { id: 'source-assistant', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'Selected assistant acknowledgement c184.' }], timestamp: '2026-08-01T20:00:01.000Z' },
  ]
  const sourceMaterial = { source: boundary, completeness: 'complete' as const, messages: [omitted, ...selected], attachments: [] }
  const source = { ...sourceMaterial, digest: portableConversationContextDigest(sourceMaterial) }
  const contextMaterial = { source: boundary, completeness: 'partial' as const, messages: selected, attachments: [] }
  const context = { ...contextMaterial, digest: portableConversationContextDigest(contextMaterial) }
  const reason = 'Not selected for this handoff.'
  const planMaterial = {
    planId: 'native-plan', source, destination: {
      runner: 'codex', provider: 'cli-bridge', sessionId: 'native-logical-session', runId: 'native-first-run',
      executionId: 'native-first-execution', model: 'fixture/gpt-5.4', profileDigest: canonicalAgentProfileDigest(frozenProfile),
    },
    messages: [
      { messageId: omitted.id, action: 'omit' as const, reason, parts: [{ partIndex: 0, action: 'omit' as const, reason }] },
      ...selected.map((message) => ({ messageId: message.id, action: 'include' as const, parts: message.parts.map((_, partIndex) => ({ partIndex, action: 'include' as const })) })),
    ],
    context, requiresAcceptance: true,
  }
  const plan = { ...planMaterial, digest: portableContextPlanDigest(planMaterial) }
  // The consumer path: the shared constructor sends only the selected projection.
  return createContextTransferRequest({
    operationId: 'native-import-operation', plan, profile: frozenProfile,
    workspace: { cwd: { base: 'host' as const, path: cwd } },
    acceptance: { planDigest: plan.digest, acceptedAt: new Date().toISOString(), acceptedBy: 'policy' as const },
  })
}

describe('real Codex native context consumer', () => {
  it('preserves selected typed history once across HTTP ACK loss, receiver restart, and the first resumed model turn', async () => {
    const directory = mkdtempSync(join(ensurePrivateDataDirectory(join(homedir(), '.cache', 'cli-bridge-native-conformance')), 'case-'))
    const workspace = join(directory, 'workspace')
    const fixtureHome = join(directory, 'home')
    mkdirSync(workspace, { mode: 0o700 })
    mkdirSync(fixtureHome, { mode: 0o700 })
    vi.stubEnv('HOME', fixtureHome)
    vi.stubEnv('CODEX_HOME', fixtureHome)
    const modelRequests: Array<Record<string, unknown>> = []
    const modelServer = createServer(async (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      modelRequests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const events = [
        { type: 'response.created', response: { id: 'fixture-response' } },
        { type: 'response.output_item.done', item: { id: 'fixture-message', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native fixture completion' }] } },
        { type: 'response.completed', response: { id: 'fixture-response', usage: { input_tokens: 16, output_tokens: 4, total_tokens: 20 } } },
      ]
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>((complete) => modelServer.listen(0, '127.0.0.1', complete))
    const address = modelServer.address()
    if (!address || typeof address === 'string') throw new Error('model fixture address missing')
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const spawner: Spawner = (bin, args, options) => hostSpawner(bin, args[0] === '--version' ? args : [
      ...args,
      '-c', 'model_providers.fixture.name="Loopback fixture"',
      '-c', `model_providers.fixture.base_url=${JSON.stringify(endpoint)}`,
      '-c', 'model_providers.fixture.wire_api="responses"',
      '-c', 'model_providers.fixture.supports_websockets=false',
      '-c', 'model_providers.fixture.request_max_retries=0',
      '-c', 'model_providers.fixture.stream_max_retries=0',
    ], {
      ...options,
      env: {
        ...options.env, HOME: fixtureHome,
        CODEX_API_KEY: 'public-loopback-fixture', OPENAI_API_KEY: 'public-loopback-fixture',
        CODEX_ACCESS_TOKEN: undefined, OPENAI_BASE_URL: endpoint,
      },
    })
    const request = nativeRequest(workspace)
    expect(request.plan.kind).toBe('portable-context-transfer-plan')
    expect(JSON.stringify(request)).not.toContain(omittedMarker)
    const authorization = 'Bearer fixture-owner'
    const headers = { authorization, 'content-type': 'application/json' }
    let store: SessionStore | undefined
    let service: RetainedSessionService | undefined
    let runs: RunRegistry | undefined
    const startReceiver = (): Hono => {
      store = new SessionStore(join(directory, 'store'))
      const registry = new BackendRegistry().register(new CodexBackend({
        bin: resolve('node_modules/.bin/codex'), timeoutMs: 60_000, stateDir: join(directory, 'native'), spawner,
      }))
      runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
      service = new RetainedSessionService({ store, registry, runs, healthProbeTimeoutMs: 15_000 })
      const app = new Hono()
      mountRetainedSessions(app, service)
      mountChatCompletions(app, { registry, sessions: store, retainedRuns: store, runs, contextTransfers: service })
      return app
    }
    try {
      const first = startReceiver()
      // Receiver completes, but the caller discards the HTTP receipt.
      await first.request('/v1/context-transfers', { method: 'POST', headers, body: JSON.stringify(request) })
      expect(store!.getRetainedControlOperation(request.operationId)?.acknowledgement).toMatchObject({ status: 'accepted', native: { phase: 'imported' } })
      const nativeId = store!.get(request.plan.destination.sessionId, 'codex')!.internalId
      expect(nativeId).toMatch(/^[a-f0-9-]{36}$/u)
      expect(modelRequests).toHaveLength(0)
      await service!.shutdown(1_000)
      await runs!.shutdown(1_000)
      store!.close()
      store = undefined
      const restarted = startReceiver()
      const replayResponse = await restarted.request('/v1/context-transfers', { method: 'POST', headers, body: JSON.stringify(request) })
      expect(replayResponse.status).toBe(200)
      const receipt = await replayResponse.json() as { status: string; environmentId: string; omittedMessageIds: string[] }
      expect(receipt.status).toBe('replayed')
      expect(receipt.omittedMessageIds).toEqual(['source-omitted'])
      expect(store!.get(request.plan.destination.sessionId, 'codex')?.internalId).toBe(nativeId)
      expect(modelRequests).toHaveLength(0)
      const result = await restarted.request('/v1/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify({
          model: 'codex/fixture/gpt-5.4', agent_profile: frozenProfile, context_transfer: request,
          provider: 'cli-bridge', environment_id: receipt.environmentId,
          session_id: request.plan.destination.sessionId, run_id: request.plan.destination.runId,
          execution_id: request.plan.destination.executionId, cwd: workspace,
          messages: [{ role: 'user', content: 'First destination user turn e083.' }],
        }),
      })
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ choices: [{ message: { content: 'native fixture completion' } }] })
      expect(modelRequests).toHaveLength(1)
      const input = modelRequests[0]!.input as Array<Record<string, unknown>>
      const selected = input.filter((item) => JSON.stringify(item).includes('Selected '))
      expect(selected).toEqual([
        expect.objectContaining({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Selected user part 74f2.' }, { type: 'input_text', text: 'Second selected part b51a.' }] }),
        expect.objectContaining({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Selected assistant acknowledgement c184.' }] }),
      ])
      const firstUser = input.find((item) => JSON.stringify(item).includes('First destination user turn e083.'))!
      expect(firstUser.role).toBe('user')
      expect(JSON.stringify(firstUser)).not.toContain('Selected ')
      expect(JSON.stringify(modelRequests[0])).not.toContain(omittedMarker)
      expect(JSON.stringify(modelRequests[0])).toContain('native context conformance assistant 284e')
      expect(JSON.stringify(modelRequests[0])).toContain('Native profile instruction 91ca')
      expect(JSON.stringify(modelRequests[0])).toContain('Materialized profile resource 18de')
      expect(store!.get(request.plan.destination.sessionId, 'codex')?.internalId).toBe(nativeId)
    } finally {
      await service?.shutdown(1_000)
      await runs?.shutdown(1_000)
      store?.close()
      await new Promise<void>((complete, fail) => modelServer.close((error) => error ? fail(error) : complete()))
      vi.unstubAllEnvs()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
