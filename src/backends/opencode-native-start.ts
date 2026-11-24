import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeReasoningControl, type AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { ChatRequest, NativeSession } from './types.js'
import { BackendError } from './types.js'
import { OpencodeNativeSession, type OpencodeModelRef } from './opencode-native-session.js'
import { OPENCODE_ENV_PASSTHROUGH_KEYS, opencodeInstallDir, opencodeModelSpec } from './opencode.js'
import { admitNativeSubscription, profileExecutionIdentity, provisionProfileWorkspace, resolveAgentProfile,
  resolveRequestedReasoningEffort } from './profile-support.js'
import { materializeMcpServersForOpencode, resolveMcpServers } from './profile-mcp.js'
import { registerJailReadable, registerJailWritable } from '../jail/index.js'
import { hostRequestJail } from '../jail/host-request.js'
import { toolchainReadPaths } from '../jail/linux-paths.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { createPrivateTemporaryRoot } from '../runtime/private-temporary.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { genericCliBridgeCapabilities } from '../sessions/retained/capabilities.js'

const SERVE_SOCKET_SHIM = fileURLToPath(new URL('./opencode-serve-socket.mjs', import.meta.url))

export interface OpencodeNativeStartOptions {
  bin: string
  spawner: Spawner
  jailEnv?: NodeJS.ProcessEnv
}

/**
 * One retained `opencode serve` per session, launched like a one-shot `opencode run`: the same
 * host jail and relay, private profile config, MCP config and subscription admission.
 */
export async function startOpencodeNativeSession(
  options: OpencodeNativeStartOptions,
  req: ChatRequest,
  session: SessionRecord | null,
  signal?: AbortSignal,
): Promise<NativeSession> {
  assertModeSupported('opencode', req.mode ?? 'byob', ['byob'],
    'opencode hosted-safe requires a verified per-provider tool-disable flag path')
  const spec = opencodeModelSpec(req.model)
  const model = spec ? opencodeModelRef(spec) : null
  const cwd = resolveSpawnerCwd(options.spawner, req.cwd ?? session?.cwd ?? undefined)
  // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
  req.jailSpec ??= hostRequestJail(req, 'opencode', options.jailEnv ?? process.env)
  const variant = nativeReasoningControl('opencode', resolveRequestedReasoningEffort(req, session), spec ?? undefined)
  const profile = resolveAgentProfile(req, session) as { permissions?: Record<string, unknown>; tools?: Record<string, boolean> } | null

  const cleanups: Array<() => void> = []
  const cleanup = (): void => {
    const failures: unknown[] = []
    for (const release of cleanups.splice(0).reverse()) {
      try { release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'opencode native session file cleanup failed')
  }
  let spawned: Awaited<ReturnType<Spawner>> | null = null
  let sessionOwnsFiles = false
  try {
    const provisioned = provisionProfileWorkspace(req, session, 'opencode', cwd,
      profileExecutionIdentity(req, session, 'opencode', variant))
    if (provisioned.cleanup) cleanups.push(() => provisioned.cleanup?.())
    // opencode's plan carries launch flags only for an `--agent` binding cli-bridge never asks for; `serve` takes none.
    if (provisioned.flags.length > 0) {
      throw new BackendError(`opencode serve cannot apply profile launch flags: ${provisioned.flags.join(' ')}`, 'capability_denied')
    }
    const mcp = materializeMcpServersForOpencode(
      resolveMcpServers(req, session, { backend: 'opencode', privateMcpConfig: true }),
      profile?.permissions, profile?.tools, req.session_id)
    if (mcp) {
      cleanups.push(() => mcp.cleanup())
      registerJailReadable(req.jailSpec, dirname(mcp.configPath))
    }
    const socketRoot = createPrivateTemporaryRoot(tmpdir(), '.cli-bridge-ocs-')
    cleanups.push(() => socketRoot.cleanup())
    registerJailWritable(req.jailSpec, socketRoot.path)
    // The jail derives its toolchain paths from the spawned binary, which is node running the shim.
    registerJailReadable(req.jailSpec, opencodeInstallDir(), SERVE_SOCKET_SHIM,
      ...(req.jailSpec ? toolchainReadPaths(options.bin, req.jailSpec.projectDir) : []))
    const socketPath = join(socketRoot.path, 's')
    const password = randomBytes(24).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...provisioned.env,
      ...(mcp ? { OPENCODE_CONFIG: mcp.configPath } : {}),
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: password,
    }
    const args = [SERVE_SOCKET_SHIM, socketPath, '--', options.bin, 'serve', '--port', '0', '--hostname', '127.0.0.1']
    const invocation = { env, args, envPassthroughKeys: OPENCODE_ENV_PASSTHROUGH_KEYS, flags: provisioned.flags,
      cwd: cwd ?? process.cwd(), model: req.model, executor: options.spawner.executionEnvironment }
    await admitNativeSubscription(req, invocation)
    req.subscriptionAdmission?.require()
    spawned = await options.spawner(process.execPath, args, {
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      envPassthroughKeys: OPENCODE_ENV_PASSTHROUGH_KEYS,
      cwd,
      env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
    })
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdout)
      throw new BackendError('opencode serve failed to start with a stdout pipe', 'upstream', spawnError)
    const native = new OpencodeNativeSession(spawned, {
      capabilities: opencodeNativeCapabilities(),
      socketPath,
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      model,
      ...(variant ? { variant } : {}),
      resumeSessionId: session?.internalId || null,
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

/** `<provider>/<model>` as opencode's prompt body names it. */
function opencodeModelRef(spec: string): OpencodeModelRef {
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) {
    throw new BackendError(`backend opencode needs opencode/<provider>/<model> for a retained session; got ${JSON.stringify(spec)}`,
      'not_configured', undefined, { providerDispatch: 'not_started' })
  }
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) }
}

export function opencodeNativeCapabilities(): AgentEnvironmentCapabilities {
  const generic = genericCliBridgeCapabilities('opencode')
  return {
    ...generic,
    sessions: { continue: true, list: true, messages: true },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true, admissionControl: true },
    interactions: { kinds: ['permission'], answerFieldTypes: ['select'], responseScopes: ['interaction'],
      secretAnswers: false, concurrentRequests: false, replay: true, responseIdempotency: true },
    workspace: { ...generic.workspace, read: true, write: true, exec: true, git: true },
  }
}
