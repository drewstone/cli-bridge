import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  type AgentEnvironmentCapabilities,
  nativeReasoningControl,
} from '@tangle-network/agent-interface'
import type { SessionRecord } from '../sessions/store.js'
import type { NativeSession, ChatRequest } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import {
  assertPiOutputTokenRequest,
  buildCanonicalMcpServers,
  materializeMcpServersForPi,
  profileExecutionIdentity,
  provisionPiProfile,
  resolveAgentProfile,
  resolveMcpServers,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import {
  parsePiModelId,
  piDirectToolSelection,
  piExtensionArgs,
  piMcpAdapterAvailable,
  piToolProcessEnvironment,
  resolvePiMcpAdapterInstallPath,
} from './pi.js'
import { piInteractionExtension } from './pi-interaction.js'
import { PiNativeSession } from './pi-native-session.js'
import {
  ensurePiSessionFile,
  provisionPiInferenceTransport,
  type PiInferenceTransportResolver,
} from './pi-inference-transport.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { createPrivateTemporaryRoot, type PrivateTemporaryRoot } from '../runtime/private-temporary.js'
import { registerJailReadable, selectJailBackend } from '../jail/index.js'
import { resolveJailSpec } from '../jail/resolve-spec.js'
import { traceContextToChildEnv } from '../trace/ids.js'

const PI_RPC_REQUEST_TIMEOUT_CAP_MS = 30_000

export interface PiNativeStartOptions {
  bin: string
  timeoutMs: number
  spawner: Spawner
  transportResolver: PiInferenceTransportResolver
}

/** Start one retained Pi RPC process with the same credential and jail rules as one-shot Pi. */
export async function startPiNativeSession(
  options: PiNativeStartOptions,
  req: ChatRequest,
  session: SessionRecord | null,
  signal?: AbortSignal,
): Promise<NativeSession> {
  assertModeSupported(
    'pi',
    req.mode ?? 'byob',
    ['byob'],
    'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path',
  )
  if (req.interaction_policy === 'unattended-allow') {
    throw new BackendError(
      'native Pi sessions require interaction_policy=interactive; use one-shot for explicit unattended policy',
      'capability_denied',
    )
  }

  if (options.spawner.executionEnvironment === undefined) {
    throw new BackendError(
      'backend pi requires an executor that declares host or docker isolation; '
      + 'an undeclared executor cannot prove that Pi tools are separated from host credentials',
      'not_configured',
    )
  }
  if (options.spawner.executionEnvironment === 'test-double' && process.env.VITEST !== 'true') {
    throw new BackendError(
      'backend pi test-double executors are only accepted by the test runner',
      'not_configured',
    )
  }
  if (options.spawner.executionEnvironment === 'docker') {
    throw new BackendError(
      'backend pi retained inference uses a bridge-owned loopback transport that is not reachable from the '
      + 'Docker network namespace; set PI_EXECUTOR=host rather than falling back to mounted provider credentials',
      'not_configured',
    )
  }

  const runCwd = resolveSpawnerCwd(options.spawner, req.cwd ?? session?.cwd ?? undefined)
  if (options.spawner.executionEnvironment === 'host') {
    if (!req.jailSpec) {
      req.jailSpec = resolveJailSpec({ cwd: runCwd ?? process.cwd(), env: process.env })
    }
    const jailBackend = selectJailBackend()
    if (!req.jailSpec?.readConfine || jailBackend.name !== 'bwrap' || !(await jailBackend.isAvailable())) {
      throw new BackendError(
        'backend pi requires an enforced Linux fs-jail so Bash and descendants cannot read host credentials '
        + 'or sibling sessions; set BRIDGE_JAIL_MODE=fs-jail and enable bubblewrap',
        'not_configured',
      )
    }
    req.jailSpec.requireEnforcement = true
    req.jailSpec.authSources = []
  }

  const spec = parsePiModelId(req.model)
  if (!spec.provider || !spec.model) {
    throw new BackendError(
      'backend pi requires an explicit pi/<provider>/<model> so it can pin the isolated inference endpoint',
      'not_configured',
    )
  }

  const profile = resolveAgentProfile(req, session)
  assertPiOutputTokenRequest(req, profile)
  const requestedReasoningEffort = resolveRequestedReasoningEffort(req, session)
  const thinking = nativeReasoningControl('pi', requestedReasoningEffort)
  const executionIdentity = profileExecutionIdentity(req, session, 'pi', thinking)
  const mcpSpecs = resolveMcpServers(req, session)
  const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
  const mcpAdapterPath = requestedMcpNames.length > 0 ? resolvePiMcpAdapterInstallPath() : null
  if (requestedMcpNames.length > 0 && (!piMcpAdapterAvailable() || !mcpAdapterPath)) {
    throw new BackendError(
      'backend pi cannot mount MCP servers: no loadable pi-mcp-adapter install was found '
      + `(run \`pi install npm:pi-mcp-adapter\` or set PI_CODING_AGENT_DIR to its install); `
      + `requested: ${requestedMcpNames.join(', ')}`,
      'not_configured',
    )
  }

  const providerSessionId = session?.internalId || randomUUID()
  const args: string[] = ['--mode', 'rpc', '--provider', spec.provider, '--model', spec.model]
  if (session?.internalId) args.push('--session', session.internalId)
  else args.push('--session-id', providerSessionId)
  if (thinking) args.push('--thinking', thinking)
  args.push(...piExtensionArgs(req, session, mcpAdapterPath))

  let interactionRoot: PrivateTemporaryRoot | null = null
  let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
  let provisioned: ReturnType<typeof provisionPiProfile> = null
  let inference: Awaited<ReturnType<typeof provisionPiInferenceTransport>> | null = null
  let spawned: Awaited<ReturnType<Spawner>> | null = null

  const cleanupOwnedFiles = async (): Promise<void> => {
    const failures: unknown[] = []
    try { mcpMounted?.cleanup() } catch (error) { failures.push(error) }
    try { provisioned?.cleanup() } catch (error) { failures.push(error) }
    try { await inference?.cleanup() } catch (error) { failures.push(error) }
    try { interactionRoot?.cleanup() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'pi native session file cleanup failed')
  }

  try {
    interactionRoot = createPrivateTemporaryRoot(runCwd ?? process.cwd(), '.cli-bridge-pi-rpc-')
    const interactionExtension = join(interactionRoot.path, 'interaction-gate.mjs')
    writeFileSync(interactionExtension, piInteractionExtension(randomUUID().replaceAll('-', '')), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    registerJailReadable(req.jailSpec, interactionExtension)
    args.push('--extension', interactionExtension)

    const resolvedInference = await options.transportResolver({
      provider: spec.provider,
      model: spec.model,
    }, signal ?? new AbortController().signal, req.protectedModelCredential)
    inference = await provisionPiInferenceTransport(resolvedInference, {
      sessionId: req.session_id,
      ...(runCwd ? { projectDir: runCwd } : {}),
      ...(profile?.model === undefined ? {} : { modelHints: profile.model }),
    })
    if (req.jailSpec) {
      req.jailSpec.extraWritablePaths = [
        ...new Set([
          ...(req.jailSpec.extraWritablePaths ?? []),
          inference.agentDir,
          inference.sessionDir,
        ]),
      ]
      registerJailReadable(req.jailSpec, inference.agentDir, inference.sessionDir)
    }
    args.push('--session-dir', inference.sessionDir)
    ensurePiSessionFile(
      inference.sessionDir,
      providerSessionId,
      runCwd ?? process.cwd(),
      { createIfMissing: !session?.internalId },
    )

    mcpMounted = requestedMcpNames.length > 0 ? materializeMcpServersForPi(mcpSpecs, runCwd) : null
    if (mcpMounted) {
      args.push('--mcp-config', mcpMounted.configPath)
      registerJailReadable(req.jailSpec, mcpMounted.configPath, dirname(mcpMounted.configPath))
    }
    provisioned = provisionPiProfile(
      req,
      session,
      runCwd,
      executionIdentity,
      {
        effectiveEndpoint: inference.requestScopedEndpoint
          ? new URL(inference.upstreamBaseUrl).origin
          : inference.upstreamBaseUrl,
        apiMode: inference.apiMode,
        transport: 'scoped-loopback',
        ...(inference.appliedMaxTotalOutputTokens === undefined
          ? {}
          : { appliedMaxTokens: inference.appliedMaxTotalOutputTokens }),
      },
    )
    if (provisioned) args.push(...provisioned.flags)

    spawned = await options.spawner(options.bin, args, {
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runCwd,
      env: {
        ...piToolProcessEnvironment(process.env, req.env ?? {}),
        PI_CODING_AGENT_DIR: inference.agentDir,
        ...traceContextToChildEnv(req.childTrace),
        ...(provisioned?.env ?? {}),
        ...(requestedMcpNames.length > 0
          ? { MCP_DIRECT_TOOLS: piDirectToolSelection(requestedMcpNames, process.env.MCP_DIRECT_TOOLS) }
          : {}),
      },
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
    })
    if (!spawned.child.stdin || !spawned.child.stdout) {
      throw new BackendError('pi RPC subprocess has no stdin/stdout pipes', 'upstream')
    }
    return new PiNativeSession(spawned, {
      capabilities: piNativeCapabilities(),
      requestTimeoutMs: options.timeoutMs > 0
        ? Math.min(options.timeoutMs, PI_RPC_REQUEST_TIMEOUT_CAP_MS)
        : 0,
      providerSessionId,
      cleanup: cleanupOwnedFiles,
    })
  } catch (error) {
    const cleanupFailures: unknown[] = []
    try {
      if (spawned) await terminateSpawned(spawned)
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    try {
      await cleanupOwnedFiles()
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    try { spawned?.release() } catch (cleanupError) { cleanupFailures.push(cleanupError) }
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], 'pi native session startup and cleanup failed')
    throw error
  }
}

const PI_NATIVE_CAPABILITIES: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: false, instructions: true, tools: false, skills: true, agents: true, commands: true },
    hooks: false,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: ['pi'],
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  nativeContinuation: {
    atomicBoundary: true,
    requestIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  interactions: {
    kinds: ['permission'],
    answerFieldTypes: ['select'],
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
}

export function piNativeCapabilities(): AgentEnvironmentCapabilities {
  return {
    ...PI_NATIVE_CAPABILITIES,
    profile: {
      ...PI_NATIVE_CAPABILITIES.profile,
      mcp: piMcpAdapterAvailable(),
    },
  }
}
