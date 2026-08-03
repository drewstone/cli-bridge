import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PiBackend } from '../src/backends/pi.js'
import {
  AgentEnvironmentCapabilitiesSchema,
  CanonicalStreamEventSchema,
  InteractionRequestSchema,
  RuntimeEventEnvelopeSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationAcknowledgementSchema,
  NativeContextContinuationRequestSchema,
  nativeContextContinuationAcknowledgementMatches,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  canonicalCandidateDigest,
  permissionAnswerSpec,
  validateInteractionResponse,
} from '@tangle-network/agent-interface'

const capabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: true, instructions: true, tools: true },
    runtimeUpdate: false,
    validation: true,
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  interactions: {
    kinds: ['question', 'permission'],
    answerFieldTypes: ['text', 'boolean', 'select'],
    responseScopes: ['interaction'],
    secretAnswers: false,
    concurrentRequests: false,
    replay: true,
    responseIdempotency: true,
  },
  workspace: { read: true, write: true, exec: true, git: true, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
} as const

describe('Agent Interface 0.42 boundary', () => {
  it('uses the published contract instead of a source copy', () => {
    expect(existsSync(new URL('../src/contracts/agent-interface.ts', import.meta.url))).toBe(false)
  })

  it('accepts the public event envelope and keeps usage in the public raw carrier', () => {
    const envelope = {
      runId: 'run-1',
      eventId: 'run-1:1',
      sequence: 1,
      cursor: '1',
      receivedAt: '2026-08-02T05:00:00.000Z',
      event: { type: 'raw', backend: 'pi', event: { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } } },
    }
    expect(RuntimeEventEnvelopeSchema.parse(envelope)).toEqual(envelope)
    expect(CanonicalStreamEventSchema.parse({ type: 'status', status: 'completed' })).toEqual({ type: 'status', status: 'completed' })
    expect(() => CanonicalStreamEventSchema.parse({ type: 'bridge.event', value: true })).toThrow()
  })

  it('validates interaction scope and keeps secret defaults out of the journal', () => {
    const answerSpec = permissionAnswerSpec()
    const request = InteractionRequestSchema.parse({
      id: 'interaction-1',
      kind: 'permission',
      title: 'Run the tool?',
      answerSpec,
      responseScopes: ['interaction'],
    })
    expect(validateInteractionResponse(request, {
      id: request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })).toEqual({ ok: true })
    expect(validateInteractionResponse(request, {
      id: request.id,
      outcome: 'accepted',
      data: { grant: ['allow_session'] },
    })).toMatchObject({ ok: false })
    expect(() => InteractionRequestSchema.parse({
      id: 'secret-question',
      kind: 'question',
      title: 'Secret',
      answerSpec: { fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }] },
      default: { outcome: 'accepted', data: { token: 'must-not-persist' } },
    })).toThrow(/secret answers cannot be embedded/)
  })

  it('rejects an invalid capability advertisement and accepts Pi’s exact shape', () => {
    expect(AgentEnvironmentCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
    expect(() => AgentEnvironmentCapabilitiesSchema.parse({
      ...capabilities,
      interactions: { ...capabilities.interactions, answerFieldTypes: ['secret'], secretAnswers: false },
    })).toThrow(/secretAnswers must agree/)
  })

  it('keeps Pi unavailable for the atomic public native-continuation operation', () => {
    const backend = new PiBackend({ bin: 'pi', timeoutMs: 1 })
    const advertised = backend.nativeCapabilities?.()
    expect(advertised?.nativeContinuation).toBeUndefined()
    expect(advertised?.interactions).toMatchObject({
      kinds: ['permission'],
      answerFieldTypes: ['select'],
    })
    expect('continueNative' in backend).toBe(false)
  })

  it('requires a provider-native continuation boundary to carry its run binding', () => {
    const proof = {
      runId: 'run-1',
      provider: 'pi',
      environmentId: 'cli-bridge',
      sessionId: 'session-1',
      boundary: { kind: 'revision', revision: 'pi:session-1:4' },
      observedAt: '2026-08-02T05:00:00.000Z',
    }
    expect(NativeContextBoundaryProofSchema.parse(proof)).toEqual(proof)
  })

  it('matches the public native continuation request and acknowledgement contract', () => {
    const proof = {
      runId: 'run-1',
      provider: 'pi',
      environmentId: 'cli-bridge',
      sessionId: 'session-1',
      boundary: { kind: 'revision' as const, revision: 'pi:session-1:4' },
      observedAt: '2026-08-02T05:00:00.000Z',
    }
    const run = {
      runId: 'run-1',
      provider: 'pi',
      environmentId: 'cli-bridge',
      sessionId: 'session-1',
    }
    const turnDigest = nativeContextContinuationTurnDigest({ prompt: 'continue' })
    const request = NativeContextContinuationRequestSchema.parse({
      operationId: 'continuation-1',
      requestDigest: nativeContextContinuationRequestDigest({ turnDigest, run, expectedBoundary: proof }),
      turnDigest,
      run,
      expectedBoundary: proof,
    })
    const acknowledgement = NativeContextContinuationAcknowledgementSchema.parse({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: 'accepted',
      historyMessagesSent: 0,
      actualBoundary: { ...proof, observedAt: '2026-08-02T05:00:01.000Z' },
    })
    expect(nativeContextContinuationAcknowledgementMatches(request, acknowledgement)).toBe(true)
    expect(() => NativeContextContinuationRequestSchema.parse({
      ...request,
      requestDigest: canonicalCandidateDigest({ changed: true }),
    })).toThrow(/request digest does not match/)
    expect(() => NativeContextContinuationAcknowledgementSchema.parse({
      ...acknowledgement,
      historyMessagesSent: 1,
    })).toThrow(/never resend portable history/)
  })
})
