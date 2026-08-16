/**
 * Execution-router tests — verifies that POST /v1/chat/completions with
 * `execution: 'sandbox'` on a host harness model id (claude-code/sonnet,
 * kimi-code/kimi-k2.6, gemini/gemini-2.5-pro, …) delegates to the registered SandboxBackend
 * instead of spawning the local CLI.
 *
 * Stubs out both backends so the test never touches a real subprocess
 * or sandbox-api endpoint. Asserts:
 *
 *   - execution: 'host' (default) → host backend's chat() is called
 *   - execution: 'sandbox' → SandboxBackend's chat() is called and
 *     the request's metadata.sandboxBackendType is set to the
 *     in-container type (claude-code, kimi-code, …)
 *   - sandbox provisioning hints (repoUrl, gitRef, capability,
 *     ttlSeconds) survive the routing
 *   - missing SandboxBackend → 503
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class StubBackend implements Backend {
  readonly name: string
  readonly received: Array<{ req: ChatRequest; routedVia: string }> = []
  constructor(name: string) { this.name = name }
  matches(model: string): boolean {
    return model.startsWith(`${this.name}/`) || model === this.name
  }
  async health(): Promise<BackendHealth> { return { name: this.name, state: 'ready' } }
  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.received.push({ req, routedVia: this.name })
    yield { content: `stub-${this.name}: ok` }
    yield { finish_reason: 'stop' }
  }
}

function buildApp(backends: Backend[]): { app: Hono; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-router-'))
  const sessions = new SessionStore(dir)
  const registry = new BackendRegistry()
  for (const b of backends) registry.register(b)
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions, runs: new RunRegistry() })
  return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function postChat(app: Hono, body: object): Promise<{ status: number; text: string }> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

describe('execution-router', () => {
  it('execution: host (default) routes to the host harness backend', async () => {
    const claude = new StubBackend('claude-code')
    const sandbox = new StubBackend('sandbox')
    const { app, cleanup } = buildApp([claude, sandbox])
    try {
      const res = await postChat(app, {
        model: 'claude-code/sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(200)
      expect(claude.received).toHaveLength(1)
      expect(sandbox.received).toHaveLength(0)
    } finally { cleanup() }
  })

  it('keeps the one-shot OpenAI-compatible schema permissive for standard extensions', async () => {
    const claude = new StubBackend('claude-code')
    const { app, cleanup } = buildApp([claude])
    try {
      const res = await postChat(app, {
        model: 'claude-code/sonnet',
        messages: [{
          role: 'user',
          content: [{ type: 'file', path: '/workspace/input.txt', vendor_field: 'preserve-compatible' }],
        }],
        response_format: { type: 'json_object', vendor_field: 'accepted' },
        execution: { kind: 'host', vendor_field: 'accepted' },
      })
      expect(res.status).toBe(200)
      expect(claude.received[0]!.req.messages[0]!.content).toEqual([
        { type: 'file', path: '/workspace/input.txt', vendor_field: 'preserve-compatible' },
      ])
    } finally { cleanup() }
  })

  it('execution: sandbox on a host harness delegates to SandboxBackend with mapped backend type', async () => {
    const claude = new StubBackend('claude-code')
    const sandbox = new StubBackend('sandbox')
    const { app, cleanup } = buildApp([claude, sandbox])
    try {
      const res = await postChat(app, {
        model: 'claude-code/sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        execution: { kind: 'sandbox', repoUrl: 'https://example.com/repo.git', gitRef: 'develop' },
      })
      expect(res.status).toBe(200)
      // Host backend NEVER called.
      expect(claude.received).toHaveLength(0)
      // SandboxBackend called with the right metadata + execution payload.
      expect(sandbox.received).toHaveLength(1)
      const r = sandbox.received[0]!.req
      expect(r.metadata?.sandboxBackendType).toBe('claude-code')
      expect(r.execution).toEqual({
        kind: 'sandbox',
        repoUrl: 'https://example.com/repo.git',
        gitRef: 'develop',
      })
    } finally { cleanup() }
  })

  it('reapplies sandbox coordinates, public env, profile binding, metadata, and input parts after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-router-restart-'))
    const profile = {
      harness: 'claude-code',
      model: { provider: 'anthropic', default: 'sonnet' },
      prompt: { instructions: ['persist this profile'] },
    }
    const firstHost = new StubBackend('claude-code')
    const firstSandbox = new StubBackend('sandbox')
    const firstRegistry = new BackendRegistry().register(firstHost).register(firstSandbox)
    const firstSessions = new SessionStore(dir)
    const firstApp = new Hono()
    mountChatCompletions(firstApp, { registry: firstRegistry, sessions: firstSessions, runs: new RunRegistry() })
    try {
      const first = await postChat(firstApp, {
        model: 'claude-code/anthropic/sonnet',
        session_id: 'sdk-restart-session',
        agent_profile: profile,
        execution: {
          kind: 'sandbox',
          repoUrl: 'https://example.test/repo.git',
          gitRef: 'release-1',
        },
        env: { BRIDGE_PUBLIC_VALUE: 'persisted' },
        context: { session_context: 'default' },
        provider_options: { session_option: { temperature: 0.1 } },
        metadata: { caller_marker: 'persisted' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'inspect input' },
            { type: 'file', filename: 'input.txt', path: '/workspace/input.txt' },
            { type: 'image', filename: 'diagram.png', url: 'https://example.test/diagram.png' },
          ],
        }],
      })
      expect(first.status).toBe(200)
      expect(firstSandbox.received[0]!.req).toMatchObject({
        execution: { kind: 'sandbox', repoUrl: 'https://example.test/repo.git', gitRef: 'release-1' },
        env: { BRIDGE_PUBLIC_VALUE: 'persisted' },
        context: { session_context: 'default' },
        providerOptions: { session_option: { temperature: 0.1 } },
        agent_profile: profile,
        metadata: { caller_marker: 'persisted' },
      })
      expect(firstSandbox.received[0]!.req.messages[0]!.content).toEqual([
        { type: 'text', text: 'inspect input' },
        { type: 'file', filename: 'input.txt', path: '/workspace/input.txt' },
        { type: 'image', filename: 'diagram.png', url: 'https://example.test/diagram.png' },
      ])
    } finally {
      firstSessions.close()
    }

    const secondHost = new StubBackend('claude-code')
    const secondSandbox = new StubBackend('sandbox')
    const secondRegistry = new BackendRegistry().register(secondHost).register(secondSandbox)
    const secondSessions = new SessionStore(dir)
    const secondApp = new Hono()
    mountChatCompletions(secondApp, { registry: secondRegistry, sessions: secondSessions, runs: new RunRegistry() })
    try {
      const second = await postChat(secondApp, {
        // This is the provider default a restarted SDK instance would infer.
        // The durable session binding must select the stored exact model.
        model: 'claude-code/sonnet',
        session_id: 'sdk-restart-session',
        messages: [{ role: 'user', content: 'continue' }],
      })
      expect(second.status).toBe(200)
      expect(secondHost.received).toHaveLength(0)
      expect(secondSandbox.received).toHaveLength(1)
      expect(secondSandbox.received[0]!.req).toMatchObject({
        model: 'claude-code/anthropic/sonnet',
        execution: { kind: 'sandbox', repoUrl: 'https://example.test/repo.git', gitRef: 'release-1' },
        env: { BRIDGE_PUBLIC_VALUE: 'persisted' },
        context: { session_context: 'default' },
        providerOptions: { session_option: { temperature: 0.1 } },
        agent_profile: profile,
        metadata: { caller_marker: 'persisted' },
      })
      expect(secondSandbox.received[0]!.req.metadata).not.toHaveProperty('session_context')
      expect(secondSandbox.received[0]!.req.metadata).not.toHaveProperty('session_option')
    } finally {
      secondSessions.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('factory harness maps to factory-droids in-container type', async () => {
    const factory = new StubBackend('factory')
    const sandbox = new StubBackend('sandbox')
    const { app, cleanup } = buildApp([factory, sandbox])
    try {
      const res = await postChat(app, {
        model: 'factory/droid-base',
        messages: [{ role: 'user', content: 'hi' }],
        execution: { kind: 'sandbox' },
      })
      expect(res.status).toBe(200)
      expect(sandbox.received[0]!.req.metadata?.sandboxBackendType).toBe('factory-droids')
    } finally { cleanup() }
  })

  it('gemini harness is preserved as the in-container backend type', async () => {
    const gemini = new StubBackend('gemini')
    const sandbox = new StubBackend('sandbox')
    const { app, cleanup } = buildApp([gemini, sandbox])
    try {
      const res = await postChat(app, {
        model: 'gemini/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        execution: { kind: 'sandbox' },
      })
      expect(res.status).toBe(200)
      expect(gemini.received).toHaveLength(0)
      expect(sandbox.received[0]!.req.metadata?.sandboxBackendType).toBe('gemini')
    } finally { cleanup() }
  })

  it('missing SandboxBackend produces 503', async () => {
    const claude = new StubBackend('claude-code')
    const { app, cleanup } = buildApp([claude])
    try {
      const res = await postChat(app, {
        model: 'claude-code/sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        execution: { kind: 'sandbox' },
      })
      expect(res.status).toBe(503)
      expect(res.text).toMatch(/sandbox backend is not registered/)
    } finally { cleanup() }
  })

  it('execution: sandbox on a model that already targets sandbox/* backend stays direct', async () => {
    const sandbox = new StubBackend('sandbox')
    const { app, cleanup } = buildApp([sandbox])
    try {
      const res = await postChat(app, {
        model: 'sandbox/my-profile',
        messages: [{ role: 'user', content: 'hi' }],
        execution: { kind: 'sandbox' },
      })
      expect(res.status).toBe(200)
      expect(sandbox.received).toHaveLength(1)
      // No metadata.sandboxBackendType set — direct sandbox/* path
      // doesn't go through the harness mapping.
      expect(sandbox.received[0]!.req.metadata?.sandboxBackendType).toBeUndefined()
    } finally { cleanup() }
  })
})
