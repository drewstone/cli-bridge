/**
 * Execution-router tests — verifies that POST /v1/chat/completions with
 * `execution: 'sandbox'` on a host harness model id (claude-code/sonnet,
 * kimi-code/kimi-k2.6, …) delegates to the registered SandboxBackend
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
  mountChatCompletions(app, { registry, sessions })
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
