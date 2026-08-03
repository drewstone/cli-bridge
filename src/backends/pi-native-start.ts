import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { ChatRequest, NativeSession } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildCanonicalMcpServers,
  materializeMcpServersForPi,
  provisionPiProfile,
  resolveAgentProfile,
  resolveMcpServers,
} from './profile-support.js'
import { prepareSpawnerPrivatePath, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { finalizeSpawned } from '../executors/process-tree.js'
import { createPrivateTemporaryRoot, type PrivateTemporaryRoot } from '../runtime/private-temporary.js'
import {
  mapPrivateTreeArgs,
  mapPrivateTreeEnv,
  parsePiModelId,
  piChildEnv,
  piDirectToolSelection,
  piExtensionArgs,
  piMcpAdapterAvailable,
  resolvePiModelSpec,
  resolveReasoningEffort,
  thinkingFlagForEffort,
  piNativeCapabilities,
} from './pi-config.js'
import { piInteractionExtension } from './pi-one-shot.js'
import { PiNativeSession } from './pi-native-session.js'

const PI_RPC_REQUEST_TIMEOUT_CAP_MS = 30_000

export interface PiNativeStartOptions {
  bin: string
  timeoutMs: number
  spawner: Spawner
}

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
      'parse_error',
    )
  }

  const spec = resolvePiModelSpec(parsePiModelId(req.model))
  const profile = resolveAgentProfile(req, session)
  const runCwd = resolveSpawnerCwd(options.spawner, req.cwd ?? session?.cwd ?? undefined)
  const mcpSpecs = resolveMcpServers(req, session)
  const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
  if (requestedMcpNames.length > 0 && !piMcpAdapterAvailable()) {
    throw new BackendError(
      `backend pi cannot mount MCP servers: pi-mcp-adapter extension not installed; requested: ${requestedMcpNames.join(', ')}`,
      'not_configured',
    )
  }

  let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
  let provisioned: ReturnType<typeof provisionPiProfile> = null
  let runtimeProvisionedEnv: Record<string, string> | undefined
  let adapterRoot: PrivateTemporaryRoot | null = null
  let spawned: Awaited<ReturnType<Spawner>> | null = null
  const cleanupOwnedFiles = (): void => {
    const failures: unknown[] = []
    for (const cleanup of [
      mcpMounted ? () => mcpMounted?.cleanup() : null,
      provisioned ? () => provisioned?.cleanup() : null,
      adapterRoot ? () => adapterRoot?.cleanup() : null,
    ]) {
      if (!cleanup) continue
      try {
        cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'pi native session file cleanup failed')
  }
  try {
    const args: string[] = ['--mode', 'rpc']
    if (spec.provider) args.push('--provider', spec.provider)
    if (spec.model) args.push('--model', spec.model)
    if (session?.internalId) args.push('--session', session.internalId)
    else args.push('--session-id', randomUUID())
    const thinking = thinkingFlagForEffort(resolveReasoningEffort(req, profile))
    if (thinking) args.push('--thinking', thinking)
    args.push(...piExtensionArgs(req, session, requestedMcpNames.length > 0, options.spawner))

    // Pi's extension UI is the native approval transport. This adapter is
    // deliberately tiny: it asks Pi to display its own dialog and only
    // translates the resulting JSONL request/response at the bridge edge.
    adapterRoot = createPrivateTemporaryRoot(runCwd ?? process.cwd(), '.cli-bridge-pi-rpc-')
    const interactionExtension = join(adapterRoot.path, 'interaction-gate.mjs')
    const interactionNonce = randomUUID().replaceAll('-', '')
    writeFileSync(interactionExtension, piInteractionExtension(false, interactionNonce), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    const runtimeAdapterRoot = await prepareSpawnerPrivatePath(options.spawner, adapterRoot.path)
    args.push('--extension', join(runtimeAdapterRoot, 'interaction-gate.mjs'))

    provisioned = provisionPiProfile(req, session, runCwd)
    if (provisioned) {
      const runtimeProfileRoot = await prepareSpawnerPrivatePath(options.spawner, provisioned.rootPath)
      args.push(...mapPrivateTreeArgs(provisioned.flags, provisioned.rootPath, runtimeProfileRoot))
      runtimeProvisionedEnv = mapPrivateTreeEnv(provisioned.env, provisioned.rootPath, runtimeProfileRoot)
    }
    if (requestedMcpNames.length > 0) {
      const mounted = materializeMcpServersForPi(mcpSpecs, runCwd, { isolateChildren: true })
      if (!mounted)
        throw new BackendError('backend pi could not materialize the requested MCP servers', 'not_configured')
      mcpMounted = mounted
      const runtimeMcpRoot = await prepareSpawnerPrivatePath(options.spawner, dirname(mounted.configPath))
      args.push('--mcp-config', join(runtimeMcpRoot, basename(mounted.configPath)))
    }

    spawned = await options.spawner(options.bin, args, {
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runCwd,
      env: piChildEnv(
        spec,
        runCwd,
        runtimeProvisionedEnv,
        requestedMcpNames.length > 0
          ? piDirectToolSelection(requestedMcpNames, process.env.MCP_DIRECT_TOOLS)
          : undefined,
      ),
      exactEnv: true,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
    })
    const child = spawned.child
    if (!child.stdin || !child.stdout) {
      throw new BackendError('pi RPC subprocess has no stdin/stdout pipes', 'upstream')
    }
    return new PiNativeSession(spawned, {
      capabilities: piNativeCapabilities(),
      requestTimeoutMs: Math.max(1, Math.min(options.timeoutMs, PI_RPC_REQUEST_TIMEOUT_CAP_MS)),
      cleanup: cleanupOwnedFiles,
    })
  } catch (error) {
    try {
      if (spawned) await finalizeSpawned(spawned, [cleanupOwnedFiles])
      else cleanupOwnedFiles()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'pi native session startup and cleanup failed')
    }
    throw error
  }
}
