/**
 * Backend-owned typed history import through Codex's public app-server API.
 * Exact binary qualification is owned by tests/codex-context-transfer-real.test.ts.
 * No native session files are read.
 * https://developers.openai.com/codex/app-server
 */
import {
  ContextTransferRequestSchema,
  canonicalAgentProfileDigest,
  workspaceCwdPathForBase,
  type AgentProfile,
  type ContextTransferRequest,
} from '@tangle-network/agent-interface'
import { BackendError, type PreparedContextTransfer, type ProfileMaterializationReceipt } from './types.js'
import type { SpawnResult } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { StringDecoder } from 'node:string_decoder'
import type { NativeModelFacts } from '../native-catalog.js'
import { nativeObject, nativeIdentifier as safeNativeId } from '../lib/native-state.js'

export const CODEX_NATIVE_IMPORT_VERSION = 'codex-cli 0.164.0'

const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const RPC_TIMEOUT_MS = 30_000

/** Returns the exact public profile the native thread will be created with. */
export function validateCodexContextTransfer(request: ContextTransferRequest): AgentProfile {
  ContextTransferRequestSchema.parse(request)
  if (!request.profile || canonicalAgentProfileDigest(request.profile) !== request.plan.destination.profileDigest
    || request.plan.destination.runner !== 'codex' || (request.profile.harness !== undefined && request.profile.harness !== 'codex')) {
    throw new BackendError('Codex native context import requires the exact frozen public Codex profile', 'capability_denied')
  }
  if (!request.workspace?.cwd || request.workspace.cwd.base !== 'host') {
    throw new BackendError('Codex native context import requires an explicit existing host workspace cwd', 'capability_denied')
  }
  workspaceCwdPathForBase(request.workspace.cwd, 'host', 'Codex context transfer')
  codexContextItems(request)
  return request.profile
}

/** Preserve roles and part order; unsupported parts are refused before native allocation. */
export function codexContextItems(request: ContextTransferRequest): Record<string, unknown>[] {
  return request.plan.context.messages.map((message) => {
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      throw new BackendError('Codex native context import cannot represent this selected message role', 'capability_denied')
    }
    return {
      type: 'message',
      role: message.role,
      content: message.parts.map((part) => (
        { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: selectedText(part) }
      )),
    }
  })
}

/** The wire plan has already checked each selected part's bytes; Codex imports text parts only. */
function selectedText(part: unknown): string {
  if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text'
    && 'text' in part && typeof part.text === 'string') {
    return part.text
  }
  throw new BackendError('Codex native context import does not yet support selected non-text parts', 'capability_denied')
}

export class CodexContextTransfer implements PreparedContextTransfer {
  private readonly pending = new Map<number, {
    resolve(value: Record<string, unknown>): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  private sequence = 0
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private closed = false
  private closePromise: Promise<void> | undefined
  private createdSessionId: string | undefined
  readonly profileMaterialization?: ProfileMaterializationReceipt

  constructor(
    private readonly spawned: SpawnResult,
    private readonly request: ContextTransferRequest | undefined,
    private readonly signal: AbortSignal,
    private readonly cleanup: () => void,
    profileMaterialization?: ProfileMaterializationReceipt,
  ) {
    this.profileMaterialization = profileMaterialization
    spawned.child.stdout?.on('data', (chunk: Buffer) => this.consume(this.decoder.write(chunk)))
    // Drain diagnostics without exposing credentials, transcript, or raw native errors.
    spawned.child.stderr?.resume()
    spawned.child.stdin?.on('error', () => this.fail(new Error('Codex app-server input failed')))
    spawned.child.on('error', () => this.fail(new Error('Codex app-server failed to start')))
    spawned.child.on('close', () => this.fail(new Error('Codex app-server closed before acknowledgement')))
    signal.addEventListener('abort', this.onAbort, { once: true })
    if (signal.aborted) this.onAbort()
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { clientInfo: { name: 'cli-bridge', title: 'CLI Bridge', version: '0.3.0' } })
    this.write({ method: 'initialized', params: {} })
  }

  /** Read configuration and account metadata without creating a thread, refreshing auth, or starting a turn. */
  async readNativeFacts(cwd: string): Promise<NativeModelFacts> {
    const response = await this.rpc('config/read', { cwd, includeLayers: false })
    const configuration = nativeObject(response.config)
    const origins = nativeObject(response.origins)
    const account = await this.rpc('account/read', { refreshToken: false })
    // Codex's native config reference defines the omitted provider as openai.
    const provider = configuration.model_provider == null ? 'openai' : safeNativeId(configuration.model_provider) ?? null
    let model = configuration.profile ? undefined : safeNativeId(configuration.model)
    if (!model && !configuration.profile) {
      let cursor: string | undefined
      for (let page = 0; page < 4; page++) {
        const catalog = await this.rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(catalog.data) || catalog.data.length > 100) throw new Error('Codex returned an invalid bounded model catalog')
        const defaults = catalog.data.map(nativeObject).filter((entry) => entry.isDefault === true)
        if (defaults.length > 1 || defaults.length === 1 && model) throw new Error('Codex returned ambiguous native model defaults')
        if (defaults[0]) model = safeNativeId(defaults[0].model)
        const next = catalog.nextCursor
        if (next === null || next === undefined) break
        if (typeof next !== 'string' || !next || next.length > 4096 || next === cursor || page === 3) throw new Error('Codex model catalog exceeds the bounded discovery window')
        cursor = next
      }
    }
    const type = nativeObject(account.account).type
    const overrides = nativeObject(nativeObject(configuration.model_providers)[provider ?? ''])
    const builtin = provider === 'openai' && Object.keys(overrides).length === 0
      && !origins.openai_base_url && !origins.chatgpt_base_url && !configuration.profile
    const subscription = type === 'chatgpt' && builtin && account.requiresOpenaiAuth === true
    const signedOut = account.account === null && builtin && account.requiresOpenaiAuth === true
    return { provider, ...(model && model !== 'default' ? { defaultModel: model } : {}),
      status: subscription ? 'authenticated' : type === 'apiKey' ? 'configured' : signedOut ? 'signed_out' : 'unknown',
      authMode: subscription ? 'subscription' : type === 'apiKey' ? 'api_key' : 'unknown',
      source: 'native_status', ...(subscription ? {} : { fix: signedOut ? 'codex login' : 'codex login status' }),
    }
  }

  async createSession(): Promise<{ nativeSessionId: string; createdAt: string }> {
    const cwd = this.request?.workspace?.cwd
    if (!cwd) throw new Error('Codex native import requires its validated host cwd')
    const response = await this.rpc('thread/start', {
      cwd: workspaceCwdPathForBase(cwd, 'host', 'Codex context transfer'),
      approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false,
    })
    const thread = response.thread
    if (typeof thread !== 'object' || thread === null || !('id' in thread) || typeof thread.id !== 'string'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(thread.id)
      || !('createdAt' in thread) || typeof thread.createdAt !== 'number' || !Number.isFinite(thread.createdAt)) {
      throw new Error('Codex app-server creation acknowledgement has no exact identity')
    }
    this.createdSessionId = thread.id
    // Codex reports whole seconds, which can precede a same-second acceptance.
    // The receipt needs created-after-acceptance ordering, so record when this
    // receiver observed the creation acknowledgement.
    return { nativeSessionId: thread.id, createdAt: new Date().toISOString() }
  }

  async importHistory(nativeSessionId: string): Promise<void> {
    if (this.createdSessionId !== nativeSessionId) {
      const response = await this.rpc('thread/resume', { threadId: nativeSessionId })
      const thread = response.thread
      if (typeof thread !== 'object' || thread === null || !('id' in thread) || thread.id !== nativeSessionId) {
        throw new Error('Codex resumed a different native thread')
      }
    }
    if (!this.request) throw new Error('Codex history import requires its validated request')
    const items = codexContextItems(this.request)
    if (items.length > 0) await this.rpc('thread/inject_items', { threadId: nativeSessionId, items })
    // The public inject ACK awaits Codex's preparation checkpoint. There is no
    // public projection of the selected raw history for reconciling a lost ACK.
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.signal.removeEventListener('abort', this.onAbort)
      this.fail(new Error('Codex native import transport closed'))
      try {
        const outcome = await terminateSpawned(this.spawned)
        if (outcome !== 'stopped') throw new Error('Codex native import process termination is unknown')
      } finally {
        this.spawned.release()
        this.cleanup()
      }
    })()
    return this.closePromise
  }

  private readonly onAbort = (): void => {
    this.fail(new Error('Codex native import cancelled; acknowledgement may be unknown'))
    void this.close().catch(() => {})
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted()
    if (this.closed) return Promise.reject(new Error('Codex native import transport is closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex app-server acknowledgement timed out'))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  private write(value: Record<string, unknown>): void {
    if (this.closed || !this.spawned.child.stdin?.writable) throw new Error('Codex app-server input is not writable')
    this.spawned.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private consume(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RPC_LINE_BYTES) {
      this.fail(new Error('Codex app-server response exceeds the native import bound'))
      return
    }
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> } catch {
        this.fail(new Error('Codex app-server returned invalid JSON'))
        return
      }
      if (typeof message.id === 'number' && !message.method) {
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error || !message.result || typeof message.result !== 'object') {
          waiter.reject(new Error('Codex app-server rejected the native import request'))
        } else waiter.resolve(message.result as Record<string, unknown>)
      } else if (message.method && message.id !== undefined) {
        // No model turn is admitted by this transport. A reverse request cannot
        // obtain permissions or answers implicitly during history initialization.
        this.write({ id: message.id, error: { code: -32601, message: 'native history initialization does not admit reverse requests' } })
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}
