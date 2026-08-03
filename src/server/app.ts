import { Hono } from 'hono'
import type { Config } from '../config.js'
import { SessionStore } from '../sessions/store.js'
import { BackendRegistry } from '../backends/registry.js'
import { ClaudeBackend } from '../backends/claude.js'
import { ClaudishBackend } from '../backends/claudish.js'
import { CodexBackend } from '../backends/codex.js'
import { OpencodeBackend } from '../backends/opencode.js'
import { KimiBackend } from '../backends/kimi.js'
import { GeminiBackend } from '../backends/gemini.js'
import { FactoryBackend } from '../backends/factory.js'
import { AmpBackend } from '../backends/amp.js'
import { ForgeBackend } from '../backends/forge.js'
import { AcpBackend } from '../backends/acp.js'
import { NanoclawBackend } from '../backends/nanoclaw.js'
import { PiBackend } from '../backends/pi.js'
import { PassthroughBackend } from '../backends/passthrough.js'
import { SandboxBackend } from '../backends/sandbox.js'
import { createProfileCatalog, type ProfileCatalog } from '../profiles/loader.js'
import { mountChatCompletions } from '../routes/chat-completions.js'
import { mountHealth } from '../routes/health.js'
import { mountModels } from '../routes/models.js'
import { mountProfiles } from '../routes/profiles.js'
import { RetainedSessionService, mountRetainedSessions } from '../sessions/retained.js'
import { mountRuns } from '../routes/runs.js'
import { mountCadRender } from '../routes/cad-render.js'
import { mountImagesGenerate } from '../routes/images-generate.js'
import { mountMetrics } from '../routes/metrics.js'
import { AdmissionGate } from '../admission.js'
import { RunRegistry } from '../runs/registry.js'
import { TraceEmitter } from '../trace/emitter.js'
import { JsonlSpanSink, nullSpanSink } from '../trace/sink.js'
import { buildExecutorForBackend, parseEnvPositiveInt } from './executors.js'
import type { BuildAppExtras } from './types.js'

export async function buildApp(config: Config): Promise<{
  app: Hono
  sessions: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  catalog: ProfileCatalog
  extras: BuildAppExtras
}> {
  const sessions = new SessionStore(config.dataDir)
  const registry = new BackendRegistry()
  const runs = new RunRegistry({
    replayRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_REPLAY_RETENTION_MS', 60_000),
    identityRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_IDENTITY_RETENTION_MS', 86_400_000),
    maxReplayDeltas: parseEnvPositiveInt('BRIDGE_RUN_MAX_REPLAY_DELTAS', 10_000),
  })
  const extras: BuildAppExtras = { shutdownHooks: [], netJail: new Map() }
  try {
    const catalog = createProfileCatalog(config.sandboxProfilesDir)
    const admission = new AdmissionGate(config.admission)
    const trace = new TraceEmitter({
      sink: config.trace.enabled
        ? new JsonlSpanSink({
            file: config.trace.file,
            maxBytes: config.trace.maxBytes,
            maxFiles: config.trace.maxFiles,
          })
        : nullSpanSink,
      maxToolSpans: config.trace.maxToolSpans,
    })

    // Register order matters — first match wins. Harness-specific backends
    // come first so a `claude-code/sonnet` doesn't get claimed by a
    // passthrough that happens to know a provider-prefixed model id.
    if (config.backends.has('claude')) {
      const spawner = await buildExecutorForBackend(config.executors.claude, extras, config.claudeBin, config)
      registry.register(
        new ClaudeBackend({
          bin: config.claudeBin,
          timeoutMs: config.claudeTimeoutMs,
          harness: 'claude-code',
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('claudish')) {
      if (!config.claudishUrl) {
        throw new Error('claudish backend enabled but CLAUDISH_URL is not set')
      }
      registry.register(
        new ClaudishBackend({
          bin: config.claudeBin,
          timeoutMs: config.claudeTimeoutMs,
          claudishUrl: config.claudishUrl,
        }),
      )
    }
    if (config.backends.has('codex')) {
      const spawner = await buildExecutorForBackend(config.executors.codex, extras, config.codexBin, config)
      registry.register(
        new CodexBackend({
          bin: config.codexBin,
          timeoutMs: config.codexTimeoutMs,
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('opencode')) {
      const spawner = await buildExecutorForBackend(config.executors.opencode, extras, config.opencodeBin, config)
      registry.register(
        new OpencodeBackend({
          bin: config.opencodeBin,
          timeoutMs: config.opencodeTimeoutMs,
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('kimi')) {
      const spawner = await buildExecutorForBackend(config.executors.kimi, extras, config.kimiBin, config)
      registry.register(
        new KimiBackend({
          bin: config.kimiBin,
          timeoutMs: config.kimiTimeoutMs,
          harness: 'kimi-code',
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('gemini')) {
      const spawner = await buildExecutorForBackend(config.executors.gemini, extras, config.geminiBin, config)
      registry.register(
        new GeminiBackend({
          bin: config.geminiBin,
          timeoutMs: config.geminiTimeoutMs,
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('factory')) {
      registry.register(new FactoryBackend({ bin: config.factoryBin, timeoutMs: config.cliTimeoutMsDefault }))
    }
    if (config.backends.has('amp')) {
      registry.register(new AmpBackend({ bin: config.ampBin, timeoutMs: config.cliTimeoutMsDefault }))
    }
    if (config.backends.has('forge')) {
      registry.register(new ForgeBackend({ bin: config.forgeBin, timeoutMs: config.cliTimeoutMsDefault }))
    }
    // ACP-protocol agents (driven via `<bin> acp`): hermes, openclaw. Registered when
    // BRIDGE_BACKENDS lists them; health reports `unavailable` if the binary is absent.
    if (config.backends.has('hermes')) {
      registry.register(
        new AcpBackend({ name: 'hermes', bin: config.hermesBin, timeoutMs: config.cliTimeoutMsDefault }),
      )
    }
    if (config.backends.has('openclaw')) {
      registry.register(
        new AcpBackend({ name: 'openclaw', bin: config.openclawBin, timeoutMs: config.cliTimeoutMsDefault }),
      )
    }
    // NanoClaw: a Unix-socket client to the running NanoClaw daemon (not a spawned CLI).
    if (config.backends.has('nanoclaw')) {
      registry.register(
        new NanoclawBackend({ socketPath: config.nanoclawSocket, timeoutMs: config.cliTimeoutMsDefault }),
      )
    }
    if (config.backends.has('pi')) {
      const spawner = await buildExecutorForBackend(config.executors.pi, extras, config.piBin, config)
      registry.register(
        new PiBackend({
          bin: config.piBin,
          timeoutMs: config.piTimeoutMs,
          ...(spawner ? { spawner } : {}),
        }),
      )
    }
    if (config.backends.has('passthrough')) {
      registry.register(
        new PassthroughBackend({
          openaiApiKey: config.openaiApiKey,
          anthropicApiKey: config.anthropicApiKey,
          moonshotApiKey: config.moonshotApiKey,
          zaiApiKey: config.zaiApiKey,
        }),
      )
    }
    if (config.backends.has('sandbox')) {
      if (!config.sandboxApiUrl || !config.sandboxApiKey) {
        throw new Error('sandbox backend enabled but SANDBOX_API_URL + SANDBOX_API_KEY not set')
      }
      registry.register(
        new SandboxBackend({
          apiUrl: config.sandboxApiUrl,
          apiKey: config.sandboxApiKey,
          timeoutMs: config.sandboxTimeoutMs,
          resolveProfile: (id) => catalog.get(id),
        }),
      )
    }

    const app = new Hono()

    // Bearer guard — only active when BRIDGE_BEARER is set.
    if (config.bearer) {
      app.use('*', async (c, next) => {
        if (c.req.path === '/health') return next()
        const header = c.req.header('authorization') ?? ''
        const tok = header.startsWith('Bearer ') ? header.slice(7) : ''
        if (!constantTimeEqual(tok, config.bearer!)) {
          return c.json({ error: { message: 'Unauthorized', type: 'invalid_authentication_error' } }, 401)
        }
        return next()
      })
    }

    mountHealth(app, { registry, admission })
    mountModels(app, { registry, catalog, opencodeBin: config.opencodeBin, piBin: config.piBin })
    const retained = new RetainedSessionService({ store: sessions, registry, runs })
    extras.shutdownHooks.unshift(() => retained.shutdown())
    mountRetainedSessions(app, retained)
    mountRuns(app, { runs, retainedRuns: retained })
    mountProfiles(app, { catalog })
    mountChatCompletions(app, { registry, sessions, runs, admission, netJail: extras.netJail, trace })
    mountCadRender(app)
    mountImagesGenerate(app)
    mountMetrics(app)

    app.get('/', (c) =>
      c.json({
        name: 'cli-bridge',
        version: '0.2.0',
        scheme: 'bridge/<harness>/<model>',
        backends: registry.all().map((b) => b.name),
        endpoints: [
          '/health',
          '/v1/models',
          '/v1/chat/completions',
          '/v1/sessions',
          '/v1/sessions/:id/turns',
          '/v1/sessions/:id/input',
          '/v1/sessions/:id/events',
          '/v1/runs/:runId/events',
          '/v1/sessions/:id/transcript',
          '/v1/sessions/:id/status',
          '/v1/sessions/:id/steer',
          '/v1/sessions/:id/cancel',
          '/v1/sessions/:id/detach',
          '/v1/sessions/:id/close',
          '/v1/runs/:runId/interactions/:interactionId/respond',
          '/v1/runs/:id',
          '/v1/runs/:id/cancel',
          '/cad/render',
          '/images/generate',
        ],
      }),
    )

    return { app, sessions, registry, runs, catalog, extras }
  } catch (error) {
    const cleanupFailures: unknown[] = []
    try {
      await runs.shutdown(5_000)
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    for (const hook of extras.shutdownHooks) {
      try {
        await hook()
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
    }
    try {
      sessions.close()
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'cli-bridge startup and cleanup failed')
    }
    throw error
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return acc === 0
}
