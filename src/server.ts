/**
 * cli-bridge server entry — Hono on Node.
 *
 * Wires config → session store → backend registry → routes. The bearer
 * guard runs in one place (as Hono middleware); everything downstream
 * trusts the caller is authorized if it got this far.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig, type Config } from './config.js'
import { SessionStore } from './sessions/store.js'
import { BackendRegistry } from './backends/registry.js'
import { ClaudeBackend } from './backends/claude.js'
import { CodexBackend } from './backends/codex.js'
import { OpencodeBackend } from './backends/opencode.js'
import { PassthroughBackend } from './backends/passthrough.js'
import { mountChatCompletions } from './routes/chat-completions.js'
import { mountHealth } from './routes/health.js'
import { mountModels } from './routes/models.js'
import { mountSessions } from './routes/sessions.js'

export function buildApp(config: Config): { app: Hono; sessions: SessionStore; registry: BackendRegistry } {
  const sessions = new SessionStore(config.dataDir)
  const registry = new BackendRegistry()

  if (config.backends.has('claude')) {
    registry.register(new ClaudeBackend(config.claudeBin, config.claudeTimeoutMs, config.claudeAnthropicBaseUrl))
  }
  if (config.backends.has('codex')) {
    registry.register(new CodexBackend())
  }
  if (config.backends.has('opencode')) {
    registry.register(new OpencodeBackend())
  }
  if (config.backends.has('passthrough')) {
    registry.register(new PassthroughBackend({
      openaiApiKey: config.openaiApiKey,
      anthropicApiKey: config.anthropicApiKey,
      moonshotApiKey: config.moonshotApiKey,
      zaiApiKey: config.zaiApiKey,
    }))
  }

  const app = new Hono()

  // Bearer guard — only active when BRIDGE_BEARER is set. Loopback users
  // can skip this; remote deploys cannot (config.ts refuses to load
  // without a bearer when host is non-loopback).
  if (config.bearer) {
    app.use('*', async (c, next) => {
      // Health is intentionally open — liveness probes don't need auth
      if (c.req.path === '/health') return next()
      const header = c.req.header('authorization') ?? ''
      const tok = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!constantTimeEqual(tok, config.bearer!)) {
        return c.json({ error: { message: 'Unauthorized', type: 'invalid_authentication_error' } }, 401)
      }
      return next()
    })
  }

  mountHealth(app, { registry })
  mountModels(app, { registry })
  mountSessions(app, { sessions })
  mountChatCompletions(app, { registry, sessions })

  app.get('/', (c) => c.json({
    name: 'cli-bridge',
    version: '0.1.0',
    backends: registry.all().map(b => b.name),
    endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/sessions'],
  }))

  return { app, sessions, registry }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return acc === 0
}

// Entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const { app, sessions } = buildApp(config)
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[cli-bridge] listening on http://${info.address}:${info.port}  (host=${config.host})`)
    console.log(`[cli-bridge] backends: ${[...config.backends].join(', ')}`)
    console.log(`[cli-bridge] bearer: ${config.bearer ? 'required' : 'none (loopback only)'}`)
  })

  const shutdown = (sig: string) => {
    console.log(`[cli-bridge] ${sig} — shutting down`)
    server.close(() => {
      sessions.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
