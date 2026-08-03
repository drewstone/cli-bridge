import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { basename, dirname, join } from 'node:path'
import type { ChatDelta, ChatRequest } from './types.js'
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
import { contentToText } from './content.js'
import { prepareSpawnerPrivatePath, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { finalizeSpawned, terminateSpawned } from '../executors/process-tree.js'
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
} from './pi-config.js'
import { PI_PERMISSION_MARKER_PREFIX } from './pi-interaction.js'
import { PiToolCallTracker } from './pi-tool-calls.js'
import {
  piAssistantFailure,
  piFailureKind,
  piTokenUsage,
  piUsageReceiptsFromEvent,
  recordPiUsageCost,
  type PiUsageCost,
} from './pi-usage.js'

export interface PiOneShotOptions {
  bin: string
  timeoutMs: number
  spawner: Spawner
}

export async function* chatPi(
  options: PiOneShotOptions,
  req: ChatRequest,
  session: SessionRecord | null,
  signal: AbortSignal,
): AsyncIterable<ChatDelta> {
  assertOneShotInteractionPolicy(req, session)
  assertModeSupported(
    'pi',
    req.mode ?? 'byob',
    ['byob'],
    'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path',
  )

  const spec = resolvePiModelSpec(parsePiModelId(req.model))
  const prompt = buildPiPrompt(req)
  const profile = resolveAgentProfile(req, session)
  const unattendedAllow = req.interaction_policy === 'unattended-allow'

  const args: string[] = ['--print', '--mode', 'json']
  if (spec.provider) args.push('--provider', spec.provider)
  if (spec.model) args.push('--model', spec.model)
  if (session?.internalId) {
    args.push('--session', session.internalId)
  } else if (req.session_id) {
    // Pi's implicit persistent-session path drops request-scoped system
    // prompt overrides while creating the first session. Give Pi an explicit
    // internal id so the first turn uses the profile and report that id back
    // through the normal session event for subsequent `--session` resumes.
    args.push('--session-id', randomUUID())
  } else if (!req.session_id) {
    // Only a truly anonymous call is stateless.
    args.push('--no-session')
  }
  const thinking = thinkingFlagForEffort(resolveReasoningEffort(req, profile))
  if (thinking) args.push('--thinking', thinking)
  if (!unattendedAllow) args.push('--no-tools')

  const runCwd = resolveSpawnerCwd(options.spawner, req.cwd ?? session?.cwd ?? undefined)

  // MCP servers (X-Mcp-Config header ∪ body `mcp.mcpServers` ∪
  // `agent_profile.mcp`) reach pi-mcp-adapter through its per-process
  // config flag. FAIL-LOUD, not fail-safe: if the caller
  // requested MCP tools pi can't provide, reject the request — a
  // silently tool-less run scores zero for the wrong reason.
  const mcpSpecs = resolveMcpServers(req, session)
  const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
  if (requestedMcpNames.length > 0 && !piMcpAdapterAvailable()) {
    throw new BackendError(
      `backend pi cannot mount MCP servers: pi-mcp-adapter extension not installed ` +
        `(run \`pi install npm:pi-mcp-adapter\` or set CLI_BRIDGE_PI_MCP_ADAPTER=1); ` +
        `requested: ${requestedMcpNames.join(', ')}`,
      'not_configured',
    )
  }

  // The provider-specific extension namespace, MCP config, and canonical profile
  // files all use Pi's per-process loaders. Every flag precedes the positional
  // prompt, and large prompt material rides file paths rather than argv.
  args.push(...piExtensionArgs(req, session, requestedMcpNames.length > 0, options.spawner))
  let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
  let provisioned: ReturnType<typeof provisionPiProfile> = null
  let runtimeProvisionedEnv: Record<string, string> | undefined
  let interactionRoot: PrivateTemporaryRoot | null = null
  let spawned: Awaited<ReturnType<Spawner>>
  try {
    provisioned = provisionPiProfile(req, session, runCwd)
    if (provisioned) {
      const runtimeProfileRoot = await prepareSpawnerPrivatePath(options.spawner, provisioned.rootPath)
      args.push(...mapPrivateTreeArgs(provisioned.flags, provisioned.rootPath, runtimeProfileRoot))
      runtimeProvisionedEnv = mapPrivateTreeEnv(provisioned.env, provisioned.rootPath, runtimeProfileRoot)
    }
    mcpMounted =
      requestedMcpNames.length > 0 ? materializeMcpServersForPi(mcpSpecs, runCwd, { isolateChildren: true }) : null
    if (mcpMounted) {
      const runtimeMcpRoot = await prepareSpawnerPrivatePath(options.spawner, dirname(mcpMounted.configPath))
      args.push('--mcp-config', join(runtimeMcpRoot, basename(mcpMounted.configPath)))
    }
    if (unattendedAllow) {
      interactionRoot = createPrivateTemporaryRoot(runCwd ?? process.cwd(), '.cli-bridge-pi-interaction-')
      const interactionExtension = join(interactionRoot.path, 'interaction-gate.mjs')
      writeFileSync(interactionExtension, piInteractionExtension(true), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const runtimeInteractionRoot = await prepareSpawnerPrivatePath(options.spawner, interactionRoot.path)
      args.push('--extension', join(runtimeInteractionRoot, basename(interactionExtension)))
    }
    // The task prompt remains the sole positional message. Profile system and
    // additive instructions retain their native, separate authority channels.
    args.push(prompt)
    spawned = await options.spawner(options.bin, args, {
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
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
  } catch (err) {
    mcpMounted?.cleanup()
    provisioned?.cleanup()
    interactionRoot?.cleanup()
    throw err
  }
  const child = spawned.child

  let spawnErrorMessage = ''
  child.on('error', (err) => {
    spawnErrorMessage = err.message
  })
  const earlySpawnError = spawned.spawnError?.()
  if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

  // Group-kill on timeout/abort — see backends/opencode.ts.
  const timeoutHandle = setTimeout(() => {
    void terminateSpawned(spawned)
  }, options.timeoutMs)
  const onAbort = (): void => {
    void terminateSpawned(spawned)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    let internalSessionId: string | undefined
    const stderr = new BoundedDiagnosticBuffer()
    let emittedContent = false
    let emittedToolCall = false
    let sawError: string | null = null
    let sawTurnUsage = false
    // Pi reports provider failures on the assistant message, not as an `error` event:
    // it exits 0 with `turn_end.message.stopReason === 'error'` and an `errorMessage`.
    // Only the LAST turn decides, because pi auto-retries a transient failure and the
    // retry's turn_end supersedes it (`auto_retry_start`/`auto_retry_end`).
    let turnFailure: string | null = null
    const usageCost: PiUsageCost = {
      receipts: 0,
      total: 0,
      complete: true,
    }
    const piToolCalls = new PiToolCallTracker()

    child.stderr?.on('data', (b) => {
      stderr.append(b)
    })

    if (!child.stdout) {
      throw new BackendError('pi subprocess has no stdout pipe', 'upstream')
    }

    const progressIntervalMs = Math.max(10, Number(process.env.PI_PROGRESS_MS ?? 30_000))

    for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
      if (next.kind === 'progress') {
        yield { keepalive: { source: 'pi', elapsedMs: next.elapsedMs } }
        continue
      }

      const line = next.line
      if (!line.trim()) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      const type = String(ev.type ?? '')

      // Session id is on the first `session` event.
      if (type === 'session' && typeof ev.id === 'string' && !internalSessionId) {
        internalSessionId = ev.id
        yield { internal_session_id: internalSessionId }
        continue
      }

      // Errors land as { type: 'error', message: '...' } OR carry an
      // `error` field on any event. Surface and continue draining so
      // we get full stderr context before terminating.
      if (type === 'error' || ev.error) {
        sawError = String(ev.message ?? (ev.error as Record<string, unknown> | undefined)?.message ?? 'pi error')
        continue
      }

      // Pi emits one turn_end.message.usage receipt for every model call.
      // Emit each receipt immediately: retaining only the last call
      // undercounts tool loops, and waiting for agent_end loses completed
      // calls when the outer run is cancelled.
      if (type === 'turn_end') {
        turnFailure = piAssistantFailure(ev.message)
        const receipts = piUsageReceiptsFromEvent(ev)
        if (receipts.length > 0) sawTurnUsage = true
        for (const receipt of receipts) {
          recordPiUsageCost(usageCost, receipt)
          yield { usage: piTokenUsage(receipt) }
        }
        continue
      }

      // Older Pi versions may report usage only at agent_end, either as one
      // aggregate or as messages[].usage. This is fallback-only because
      // current Pi repeats calls already observed at turn_end.
      if (type === 'agent_end') {
        if (!sawTurnUsage) {
          for (const receipt of piUsageReceiptsFromEvent(ev)) {
            recordPiUsageCost(usageCost, receipt)
            yield { usage: piTokenUsage(receipt) }
          }
        }
        continue
      }

      // Text comes through message_update events with
      // assistantMessageEvent.type === 'text_delta' (or 'text_start',
      // 'text_end' boundary markers we can ignore).
      if (type === 'message_update') {
        const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined
        if (!ame) continue
        const ameType = String(ame.type ?? '')
        if (ameType === 'text_delta') {
          // Use the incremental delta only — text_start carries the
          // initial fragment in `partial.content[].text` and is followed
          // immediately by text_delta events that already include it.
          // Emitting both yields doubled output.
          const delta = typeof ame.delta === 'string' ? ame.delta : ''
          if (delta) {
            emittedContent = true
            yield { content: delta }
          }
        }
        const toolCall = piToolCalls.observe(ame, ameType)
        if (toolCall) {
          emittedToolCall = true
          yield { tool_calls: [toolCall] }
        }
        // thinking_*, message_start, message_end — drop for now.
        // Future enhancement: surface thinking as a separate ChatDelta
        // variant once the OpenAI o1-style schema lands.
        continue
      }

      const toolCall = piToolCalls.observe(ev, type)
      if (toolCall) {
        emittedToolCall = true
        yield { tool_calls: [toolCall] }
        continue
      }

      // message_start / message_end (top-level) — drop. We rely on
      // text_delta inside message_update for streaming content.
      if (type === 'message_start' || type === 'message_end') continue

      // Unknown event types — drop silently. Pi's NDJSON schema may
      // gain new event types; we don't want to break on additions.
    }

    const exitCode = await waitForProcessClose(child)
    clearTimeout(timeoutHandle)
    signal.removeEventListener('abort', onAbort)

    // Per-turn token receipts stay observable. Cost is emitted once, only
    // after every contributing call proved its amount; a partial sum must
    // never be presented as the run's complete cost.
    if (usageCost.receipts > 0 && usageCost.complete) {
      yield {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost: usageCost.total,
          cost_scope: 'total',
        },
      }
    }

    if (signal.aborted) {
      yield { finish_reason: 'error' }
      return
    }

    if (spawnErrorMessage) {
      throw new BackendError(`pi spawn failed: ${spawnErrorMessage}`, 'upstream')
    }

    if (exitCode !== 0) {
      const detail = sawError ?? (stderr.render(300) || `exit ${exitCode ?? 'unknown'}`)
      throw new BackendError(`pi exit ${exitCode ?? 'unknown'}: ${detail}`, piFailureKind(detail))
    }

    // A failed provider call must never complete as success. Pi exits 0 and the text it
    // did stream is a truncated answer, so this throws even when content was emitted —
    // an empty or partial body reported as `stop` is silent data loss for any caller
    // scoring outcomes, which is exactly what agent-runtime's piExecutor refuses.
    if (turnFailure) {
      throw new BackendError(`pi assistant turn failed: ${turnFailure}`, piFailureKind(turnFailure))
    }

    if (sawError && !emittedContent && !emittedToolCall) {
      throw new BackendError(`pi error: ${sawError}`, 'upstream')
    }

    yield {
      finish_reason: emittedToolCall ? 'tool_calls' : 'stop',
    }
  } finally {
    clearTimeout(timeoutHandle)
    signal.removeEventListener('abort', onAbort)
    // Reap the whole subtree before releasing the slot.
    await finalizeSpawned(spawned, [
      mcpMounted ? () => mcpMounted.cleanup() : null,
      provisioned ? () => provisioned.cleanup() : null,
      interactionRoot ? () => interactionRoot.cleanup() : null,
    ])
  }
}

function buildPiPrompt(req: ChatRequest): string {
  const messages = req.messages.flatMap((message) => {
    const text = contentToText(message.content)
    return text ? [{ message, text }] : []
  })
  if (messages.length === 1 && messages[0]?.message.role === 'user') {
    return messages[0].text
  }

  const parts: string[] = []
  for (const { message: msg, text } of messages) {
    const prefix =
      msg.role === 'system'
        ? 'System: '
        : msg.role === 'user'
          ? 'User: '
          : msg.role === 'assistant'
            ? 'Assistant: '
            : `${msg.role}: `
    parts.push(`${prefix}${text}`)
  }
  return parts.join('\\n\\n')
}

function assertOneShotInteractionPolicy(req: ChatRequest, session: SessionRecord | null): void {
  if (req.interaction_policy === 'interactive') {
    throw new BackendError(
      'pi one-shot mode cannot carry interactive responses; use a retained native session or an explicit unattended policy',
      'capability_denied',
    )
  }
  if (req.interaction_policy !== 'unattended-allow') return
  const profile = resolveAgentProfile(req, session)
  const receipt = req.interaction_policy_receipt
  if (
    !profile ||
    receipt?.schema !== 'cli-bridge.interaction-policy.v1' ||
    receipt.name !== 'unattended-allow' ||
    receipt.profileDigest !== canonicalCandidateDigest(profile)
  ) {
    throw new BackendError(
      'unattended-allow requires a matching profile-scoped interaction-policy receipt',
      'capability_denied',
    )
  }
}

export function piInteractionExtension(unattendedAllow: boolean, interactionNonce?: string): string {
  if (unattendedAllow) {
    return `export default function (pi) {
  pi.on('tool_call', async () => undefined)
  // cli-bridge unattended-allow-v1 is only emitted with a matching profile receipt.
}
`
  }
  if (!interactionNonce) throw new Error('interactive Pi extension requires a unique marker nonce')
  const nonce = JSON.stringify(interactionNonce)
  const markerPrefix = JSON.stringify(PI_PERMISSION_MARKER_PREFIX)
  return `export default function (pi) {
  const bridgeNonce = ${nonce}
  let permissionNumber = 0
  const sanitizePublicTitle = (value) => String(value ?? '')
    .replace(/[^\\p{L}\\p{N} .,_:\\/-]/gu, ' ')
    .replace(/\\s+/gu, ' ')
    .trim()
    .slice(0, 120) || 'tool'
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return { block: true, reason: 'interactive approval is unavailable' }
    const token = bridgeNonce + '-' + (++permissionNumber)
    const publicTitle = 'Permission: ' + sanitizePublicTitle(event.toolName)
    const choice = await ctx.ui.select(publicTitle + ' [cli-bridge-marker:' + token + ']', ['allow_once', 'deny'])
    await ctx.ui.notify(${markerPrefix} + ':' + token + ':' + String(choice), 'info')
    if (choice !== 'allow_once') return { block: true, reason: 'permission denied' }
    return undefined
  })
}
`
}
