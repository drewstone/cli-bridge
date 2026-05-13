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
import { ClaudishBackend } from './backends/claudish.js'
import { CodexBackend } from './backends/codex.js'
import { OpencodeBackend } from './backends/opencode.js'
import { KimiBackend } from './backends/kimi.js'
import { FactoryBackend } from './backends/factory.js'
import { AmpBackend } from './backends/amp.js'
import { ForgeBackend } from './backends/forge.js'
import { PassthroughBackend } from './backends/passthrough.js'
import { SandboxBackend } from './backends/sandbox.js'
import { createProfileCatalog, type ProfileCatalog } from './profiles/loader.js'
import { mountChatCompletions } from './routes/chat-completions.js'
import { mountHealth } from './routes/health.js'
import { mountModels } from './routes/models.js'
import { mountProfiles } from './routes/profiles.js'
import { mountSessions } from './routes/sessions.js'
import { mountCadRender } from './routes/cad-render.js'
import { mountImagesGenerate } from './routes/images-generate.js'
import { ContainerPool } from './executors/container-pool.js'
import { createDockerSpawner } from './executors/docker.js'
import type { Spawner } from './executors/types.js'
import type { BackendExecutorConfig } from './config.js'

export interface BuildAppExtras {
  /** Disposers to await on graceful shutdown — pool teardown lives here. */
  shutdownHooks: Array<() => Promise<void>>
}

/**
 * Build a Spawner for a backend, plus the shutdown hook that tears down
 * the underlying container pool when the bridge exits. Returns null when
 * the backend's executor is `host` — backends fall back to their default
 * hostSpawner in that case.
 */
async function buildExecutorForBackend(
  cfg: BackendExecutorConfig | undefined,
  extras: BuildAppExtras,
): Promise<Spawner | null> {
  if (!cfg || cfg.kind !== 'docker') return null
  if (!cfg.image || !cfg.poolSize || !cfg.containerConfigDir) {
    throw new Error(`backend ${cfg.name} executor=docker but missing image/poolSize/containerConfigDir`)
  }
  const pool = await ContainerPool.create({
    size: cfg.poolSize,
    image: cfg.image,
    namePrefix: cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`,
    oauthMode: cfg.oauthMode ?? 'share',
    ...(cfg.oauthMode === 'share' || !cfg.oauthMode
      ? { shareMounts: [`${cfg.hostConfigDir}:${cfg.containerConfigDir}`] }
      : {
          perSlotVolumePrefix: `${cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`}-oauth`,
          perSlotMountTarget: cfg.containerConfigDir,
        }),
    onProgress: (m) => console.log(`[${cfg.name}-pool] ${m}`),
  })
  extras.shutdownHooks.push(() => pool.destroy())
  return createDockerSpawner({ pool })
}

export async function buildApp(config: Config): Promise<{
  app: Hono
  sessions: SessionStore
  registry: BackendRegistry
  catalog: ProfileCatalog
  extras: BuildAppExtras
}> {
  const sessions = new SessionStore(config.dataDir)
  const registry = new BackendRegistry()
  const extras: BuildAppExtras = { shutdownHooks: [] }
  const catalog = createProfileCatalog(config.sandboxProfilesDir)

  // Register order matters — first match wins. Harness-specific backends
  // come first so a `claude-code/sonnet` doesn't get claimed by a
  // passthrough that happens to know a provider-prefixed model id.
  if (config.backends.has('claude')) {
    const spawner = await buildExecutorForBackend(config.executors.claude, extras)
    registry.register(new ClaudeBackend({
      bin: config.claudeBin,
      timeoutMs: config.claudeTimeoutMs,
      harness: 'claude-code',
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('claudish')) {
    if (!config.claudishUrl) {
      throw new Error('claudish backend enabled but CLAUDISH_URL is not set')
    }
    registry.register(new ClaudishBackend({
      bin: config.claudeBin,
      timeoutMs: config.claudeTimeoutMs,
      claudishUrl: config.claudishUrl,
    }))
  }
  if (config.backends.has('codex')) {
    const spawner = await buildExecutorForBackend(config.executors.codex, extras)
    registry.register(new CodexBackend({
      bin: config.codexBin,
      timeoutMs: config.codexTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('opencode')) {
    const spawner = await buildExecutorForBackend(config.executors.opencode, extras)
    registry.register(new OpencodeBackend({
      bin: config.opencodeBin,
      timeoutMs: config.opencodeTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('kimi')) {
    const spawner = await buildExecutorForBackend(config.executors.kimi, extras)
    registry.register(new KimiBackend({
      bin: config.kimiBin,
      timeoutMs: config.kimiTimeoutMs,
      harness: 'kimi-code',
      ...(spawner ? { spawner } : {}),
    }))
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
  if (config.backends.has('passthrough')) {
    registry.register(new PassthroughBackend({
      openaiApiKey: config.openaiApiKey,
      anthropicApiKey: config.anthropicApiKey,
      moonshotApiKey: config.moonshotApiKey,
      zaiApiKey: config.zaiApiKey,
    }))
  }
  if (config.backends.has('sandbox')) {
    if (!config.sandboxApiUrl || !config.sandboxApiKey) {
      throw new Error('sandbox backend enabled but SANDBOX_API_URL + SANDBOX_API_KEY not set')
    }
    registry.register(new SandboxBackend({
      apiUrl: config.sandboxApiUrl,
      apiKey: config.sandboxApiKey,
      timeoutMs: config.sandboxTimeoutMs,
      resolveProfile: (id) => catalog.get(id),
    }))
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

  mountHealth(app, { registry })
  mountModels(app, { registry, catalog })
  mountSessions(app, { sessions })
  mountProfiles(app, { catalog })
  mountChatCompletions(app, { registry, sessions })
  mountCadRender(app)
  mountImagesGenerate(app)

  app.get('/', (c) => c.json({
    name: 'cli-bridge',
    version: '0.2.0',
    scheme: 'bridge/<harness>/<model>',
    backends: registry.all().map(b => b.name),
    endpoints: [
      '/health',
      '/v1/models',
      '/v1/chat/completions',
      '/v1/sessions',
      '/cad/render',
      '/images/generate',
    ],
  }))

  return { app, sessions, registry, catalog, extras }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return acc === 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const { app, sessions, extras } = await buildApp(config)
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // Pass timeouts at create-time so they apply to the http.Server
    // before it starts accepting. Setting them post-listen has the
    // same effect for new sockets, but doing it here is bulletproof.
    serverOptions: {
      requestTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 0,
    },
  }, (info) => {
    console.log(`[cli-bridge] listening on http://${info.address}:${info.port}  (host=${config.host})`)
    console.log(`[cli-bridge] backends: ${[...config.backends].join(', ')}`)
    console.log(`[cli-bridge] bearer: ${config.bearer ? 'required' : 'none (loopback only)'}`)
    for (const cfg of Object.values(config.executors)) {
      if (cfg.kind === 'docker') {
        console.log(`[cli-bridge] ${cfg.name} executor: docker pool size=${cfg.poolSize} image=${cfg.image}`)
      }
    }
  })
  // Node's http server defaults requestTimeout=300_000 (5 min). Long
  // audit runs that stream tool_use deltas for 10–30 min get severed
  // mid-flight by that ceiling; without this bump every long run dies
  // at 300_700ms and the caller sees a truncated SSE stream with no
  // final stop event. 0 = no per-request ceiling — the per-backend
  // CLI_TIMEOUT_MS still bounds the underlying subprocess.
  ;(server as { requestTimeout?: number }).requestTimeout = 0
  ;(server as { headersTimeout?: number }).headersTimeout = 0

  const shutdown = async (sig: string) => {
    console.log(`[cli-bridge] ${sig} — shutting down`)
    for (const hook of extras.shutdownHooks) {
      try { await hook() } catch {}
    }
    server.close(() => {
      sessions.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // ─── Anti-fragile error handlers ──────────────────────────────────
  // The bridge spawns long-running CLI subprocesses (claude-code,
  // kimi-code, opencode) and pipes their stdout/stderr through async
  // generators. A single unhandled promise rejection ANYWHERE in that
  // tree — a stream error mid-spawn, a backend throwing during a
  // request, an MCP stdio pipe glitch — would crash the whole bridge
  // under Node's default `--unhandled-rejections=throw`.
  // That killed in-flight requests + every other concurrent caller.
  //
  // The bridge is the local agentic sandbox for every harness on this
  // host (physim, codebench-matrix, blueprint-agent, manual curl). One
  // misbehaving caller should not take it down. Convert these into
  // structured log entries so we know they happened, but keep serving.
  //
  // Honest tradeoff: a true OOM or DB-corruption-on-startup will get
  // logged-and-survived here instead of crashing loud. Watchdogs that
  // pre-existed will not get the SIGCHLD they expect. Net: caller-level
  // failures stay isolated; consumers see error responses on their own
  // requests rather than every concurrent caller losing its connection.
  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error(`[cli-bridge] unhandledRejection — keeping process alive`, {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
      promise: String(promise).slice(0, 120),
    })
  })
  process.on('uncaughtException', (err) => {
    console.error(`[cli-bridge] uncaughtException — keeping process alive`, {
      message: err.message,
      name: err.name,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    })
  })
}
