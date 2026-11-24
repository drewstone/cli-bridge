import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { nativeReasoningControl, type AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import { ClaudeBackend } from './claude.js'
import { ClaudeNativeSession } from './claude-native-session.js'
import type { ChatRequest, NativeSession, NativeSessionBackend } from './types.js'
import { BackendError } from './types.js'
import { admitNativeSubscription, profileExecutionIdentity, provisionProfileWorkspace,
  resolveRequestedReasoningEffort } from './profile-support.js'
import { resolveMcpServers, writeMcpConfigFile } from './profile-mcp.js'
import { registerJailReadable } from '../jail/index.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { genericCliBridgeCapabilities } from '../sessions/retained/capabilities.js'

const ACK_TIMEOUT_CAP_MS = 30_000

/**
 * Claude Code with one retained process per session. Like Pi's, a retained
 * session is interactive: every tool asks the caller (`--permission-prompt-tool
 * stdio`), and a turn that does not admit `permission` has each prompt denied.
 * One-shot `byob` keeps skipping prompts.
 */
export class ClaudeNativeBackend extends ClaudeBackend implements NativeSessionBackend {
  readonly nativeModes = ['byob'] as const

  nativeCapabilities(): AgentEnvironmentCapabilities {
    const generic = genericCliBridgeCapabilities(this.name)
    return {
      ...generic,
      sessions: { continue: true, list: true, messages: true },
      nativeContinuation: { atomicBoundary: true, requestIdempotency: true, admissionControl: true },
      interactions: { kinds: ['permission'], answerFieldTypes: ['select'], responseScopes: ['interaction'],
        secretAnswers: false, concurrentRequests: false, replay: true, responseIdempotency: true },
      workspace: { ...generic.workspace, read: true, write: true, exec: true, git: true },
    }
  }

  async startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    const mode = req.mode ?? 'byob'
    assertModeSupported(this.name, mode, this.nativeModes)
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    const effort = nativeReasoningControl('claude-code', resolveRequestedReasoningEffort(req, session))
    const provisioned = provisionProfileWorkspace(req, session, 'claude-code', cwd,
      profileExecutionIdentity(req, session, 'claude-code', effort))
    const mcp = writeMcpConfigFile(resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true }), req.session_id)
    let spawned: Awaited<ReturnType<Spawner>> | null = null
    try {
      if (mcp) registerJailReadable(req.jailSpec, dirname(mcp.configPath))
      const args = this.buildArgs(req, session, mode, mcp, {
        profilePrompt: { systemPrompt: provisioned.systemPrompt, appendSystemPrompt: provisioned.appendSystemPrompt },
        retained: true,
      })
      args.push(...provisioned.flags)
      const providerSessionId = session?.internalId || randomUUID()
      if (!session?.internalId) args.push('--session-id', providerSessionId)
      const env: NodeJS.ProcessEnv = { ...process.env, ...provisioned.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
      const invocation = { env, args, flags: args, cwd: cwd ?? process.cwd(), model: req.model,
        executor: this.spawner.executionEnvironment }
      await admitNativeSubscription(req, invocation)
      req.subscriptionAdmission?.require()
      spawned = await this.spawner(this.bin, args, {
        ...(this.name === 'claude-code' ? { nativeStore: 'claude-code' as const } : {}),
        signal, stdio: ['pipe', 'pipe', 'pipe'], cwd, env,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      })
      const spawnError = spawned.spawnError?.()
      if (spawnError || !spawned.child.stdin || !spawned.child.stdout)
        throw new BackendError('claude subprocess failed to start with stdin and stdout pipes', 'upstream', spawnError)
      const native = new ClaudeNativeSession(spawned, this.nativeCapabilities(), providerSessionId,
        this.defaultExecutionTimeoutMs > 0 ? Math.min(this.defaultExecutionTimeoutMs, ACK_TIMEOUT_CAP_MS) : 0,
        () => mcp?.cleanup())
      return Object.assign(native, {
        // A later turn reuses this process, so it re-presents the launch that was admitted.
        async admitSubscription(admission: NonNullable<ChatRequest['subscriptionAdmission']>): Promise<void> {
          await admitNativeSubscription({ ...req, subscriptionAdmission: admission }, invocation)
          admission.require()
        },
      })
    } catch (error) {
      if (spawned) await terminateSpawned(spawned).finally(() => spawned?.release())
      mcp?.cleanup()
      throw error
    }
  }
}
