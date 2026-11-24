import { fileURLToPath } from 'node:url'
import { nativeReasoningControl, type AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { ChatRequest, NativeSession } from './types.js'
import { BackendError } from './types.js'
import { KimiNativeSession, type KimiAgentConfig } from './kimi-native-session.js'
import { admitNativeSubscription, profileExecutionIdentity, provisionProfileWorkspace,
  resolveRequestedReasoningEffort } from './profile-support.js'
import { materializeMcpServersForKimi, resolveMcpServers } from './profile-mcp.js'
import { registerJailReadable } from '../jail/index.js'
import { hostRequestJail } from '../jail/host-request.js'
import { toolchainReadPaths } from '../jail/linux-paths.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { genericCliBridgeCapabilities } from '../sessions/retained/capabilities.js'

const KAP_STDIO_SHIM = fileURLToPath(new URL('./kimi-kap-stdio.mjs', import.meta.url))
const REQUEST_TIMEOUT_CAP_MS = 30_000

export interface KimiNativeStartOptions {
  backend: string
  bin: string
  spawner: Spawner
  timeoutMs: number
  jailEnv?: NodeJS.ProcessEnv
  /** The `kimi-code/<model>` alias the one-shot passes to `--model`; null keeps Kimi's configured default. */
  cliModel(model: string): string | null
}

/**
 * One retained `kimi web` per session, launched like a one-shot `kimi --prompt`: the same host jail and relay,
 * profile workspace (its prompt as Kimi's project agent), MCP file with a trusted workspace, and subscription admission.
 */
export async function startKimiNativeSession(
  options: KimiNativeStartOptions,
  req: ChatRequest,
  session: SessionRecord | null,
  signal?: AbortSignal,
): Promise<NativeSession> {
  assertModeSupported(options.backend, req.mode ?? 'byob', ['byob'],
    'kimi hosted-safe requires a verified tool-disable flag path on kimi-cli')
  const cwd = resolveSpawnerCwd(options.spawner, req.cwd ?? session?.cwd ?? undefined)
  // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
  req.jailSpec ??= hostRequestJail(req, options.backend, options.jailEnv ?? process.env)
  const thinkingFlag = nativeReasoningControl('kimi-code', resolveRequestedReasoningEffort(req, session))
  const provisioned = provisionProfileWorkspace(req, session, 'kimi-code', cwd,
    profileExecutionIdentity(req, session, 'kimi-code', thinkingFlag))
  // Kimi's plan binds its prompt as the project agent file; `kimi web` takes no launch flags.
  if (provisioned.flags.length > 0) {
    provisioned.cleanup?.()
    throw new BackendError(`kimi web cannot apply profile launch flags: ${provisioned.flags.join(' ')}`, 'capability_denied')
  }
  const mcp = materializeMcpServersForKimi(resolveMcpServers(req, session, { backend: options.backend, privateMcpConfig: false }), cwd)
  const cleanup = (): void => {
    try { mcp?.cleanup() } finally { provisioned.cleanup?.() }
  }
  let spawned: Awaited<ReturnType<Spawner>> | null = null
  let sessionOwnsFiles = false
  try {
    // The jail derives its toolchain paths from the spawned binary, which is node running the stdio bridge.
    registerJailReadable(req.jailSpec, KAP_STDIO_SHIM, ...(req.jailSpec ? toolchainReadPaths(options.bin, req.jailSpec.projectDir) : []))
    // Kimi loads `<cwd>/.kimi-code/mcp.json` only in a trusted workspace; trust it exactly when the Bridge mounted it there.
    const env: NodeJS.ProcessEnv = { ...process.env, ...provisioned.env, ...(mcp ? { KIMI_CODE_TRUST_WORKSPACE: '1' } : {}) }
    const args = [KAP_STDIO_SHIM, options.bin, 'web', '--json', '--host', '127.0.0.1', '--port', '0']
    const invocation = { env, args, flags: provisioned.flags, cwd: cwd ?? process.cwd(), model: req.model,
      executor: options.spawner.executionEnvironment }
    await admitNativeSubscription(req, invocation)
    req.subscriptionAdmission?.require()
    spawned = await options.spawner(process.execPath, args, {
      signal, stdio: ['pipe', 'pipe', 'pipe'], cwd, env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
    })
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdin || !spawned.child.stdout)
      throw new BackendError('kimi web failed to start with stdin and stdout pipes', 'upstream', spawnError)
    const model = options.cliModel(req.model)
    const agentConfig: KimiAgentConfig = { permission_mode: 'manual', ...(model ? { model } : {}),
      ...(thinkingFlag === '--thinking' ? { thinking: 'on' } : thinkingFlag === '--no-thinking' ? { thinking: 'off' } : {}) }
    const native = new KimiNativeSession(spawned, {
      capabilities: kimiNativeCapabilities(options.backend),
      cwd: cwd ?? process.cwd(),
      agentConfig,
      resumeSessionId: session?.internalId || null,
      requestTimeoutMs: options.timeoutMs > 0 ? Math.min(options.timeoutMs, REQUEST_TIMEOUT_CAP_MS) : REQUEST_TIMEOUT_CAP_MS,
      cleanup,
    })
    spawned = null
    sessionOwnsFiles = true
    try {
      await native.start(signal)
    } catch (error) {
      await native.close().catch(() => {})
      throw error
    }
    return Object.assign(native, {
      // A later turn reuses this server, so it re-presents the launch that was admitted.
      async admitSubscription(admission: NonNullable<ChatRequest['subscriptionAdmission']>): Promise<void> {
        await admitNativeSubscription({ ...req, subscriptionAdmission: admission }, invocation)
        admission.require()
      },
    })
  } catch (error) {
    // Until the session is constructed this function owns the process and files; after, its close released them.
    if (spawned) {
      const owned = spawned
      await terminateSpawned(owned).finally(() => owned.release())
    }
    if (!sessionOwnsFiles) cleanup()
    throw error
  }
}

export function kimiNativeCapabilities(backend: string): AgentEnvironmentCapabilities {
  const generic = genericCliBridgeCapabilities(backend)
  return {
    ...generic,
    sessions: { continue: true, list: true, messages: true },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true, admissionControl: true },
    interactions: { kinds: ['permission'], answerFieldTypes: ['select'], responseScopes: ['interaction'],
      secretAnswers: false, concurrentRequests: false, replay: true, responseIdempotency: true },
    workspace: { ...generic.workspace, read: true, write: true, exec: true, git: true },
  }
}
