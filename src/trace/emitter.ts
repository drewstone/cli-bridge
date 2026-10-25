/**
 * One conforming span per chat request, for every harness.
 *
 * cli-bridge is the single choke point in front of claude, kimi, codex, opencode,
 * pi and every other CLI it routes, so instrumenting HERE traces all of them
 * identically and removes the need for a per-harness adapter that would drift.
 *
 * Shape emitted per request:
 *
 *     chat <backend>  (LLM)      gen_ai.request.model, gen_ai.system, usage, status
 *       ├─ model call (LLM)      one per provider call the backend reported, with that call's usage
 *       └─ <tool>     (TOOL)     gen_ai.tool.name, gen_ai.tool.call.id
 *
 * Both spans carry the effective AgentProfile digest when the request named one
 * (`cli_bridge.profile.*`), so a trace with several agents in it can be read per
 * agent. On the tool span too, not only on its parent: a reader that filters
 * this file to one agent's work must not have to reassemble the tree first.
 *
 * The request span is the whole turn and always carries the turn's total usage.
 * A model-call child span exists only when the backend reported that call on
 * its own (`usage.model_call`, e.g. opencode's per-step receipt): it is written
 * the moment the call's receipt arrives, so a reader can sum a long run's spend
 * while it runs. A backend that reports one record for the whole turn gets no
 * child, because splitting it would invent boundaries and divide tokens that
 * were never reported separately. When children exist, the request span says
 * its usage is their sum (`cli_bridge.usage.scope`), so a reader that sums
 * every LLM span can skip it instead of counting the tokens twice.
 *
 * Tool spans are instants (`end_time === start_time`) and carry no status,
 * because the backends report the model's DECISION to call a tool and never
 * report the call finishing. An invented duration or an assumed `OK` would be a
 * measurement the bridge does not have.
 *
 * Nothing here may throw into a request. Every entry point is wrapped, and the
 * failure mode is a lost span, never a lost completion.
 */

import {
  llmSpan,
  toolSpan,
  type ContractSpan,
  type SpanStatus,
} from '@tangle-network/agent-trace-contract'
import type { ChatDelta } from '../backends/types.js'
import { addUsage, type CollectedUsage } from '../usage.js'
import { traceContractBuildIdOrNull } from './contract-build.js'
import { newSpanId, newTraceId, type ResolvedCallerTrace } from './ids.js'
import type { SpanSink } from './sink.js'

/**
 * Attributes cli-bridge adds beyond the contract's vocabulary.
 *
 * Namespaced under `cli_bridge.` because they describe THIS producer's execution
 * context, for which no semantic convention exists. Anything a standard already
 * names — model, system, tokens, cost, tool name — uses the standard key via the
 * contract, never a key invented here.
 */
export const BRIDGE_ATTR = Object.freeze({
  /** Durable run id — joins the span to `GET /v1/runs/:id`. */
  runId: 'cli_bridge.run.id',
  /** Caller-owned session id, when the request resumed one. */
  sessionId: 'cli_bridge.session.id',
  /** The harness's OWN session id — joins the span to that CLI's transcript. */
  backendSessionId: 'cli_bridge.backend.session_id',
  /** Execution mode: byob / hosted-safe / hosted-sandboxed. Decides which tools existed. */
  mode: 'cli_bridge.mode',
  /** Where the harness ran: host or sandbox. */
  execution: 'cli_bridge.execution',
  /** How the caller's trace was joined: traceparent / headers / none / invalid. */
  correlation: 'cli_bridge.trace.correlation',
  /** Terminal reason as the bridge reported it — separates `length` from `stop`. */
  finishReason: 'cli_bridge.finish_reason',
  /** Present and true when token counts were derived from text, not measured. */
  usageEstimated: 'cli_bridge.usage.estimated',
  /** Tool calls observed, including any beyond the per-request span cap. */
  toolCallsObserved: 'cli_bridge.tool_calls.observed',
  /** Tool calls that got no span because the cap was hit. Present only when > 0. */
  toolCallsDropped: 'cli_bridge.tool_calls.dropped',
  /** Tool call id, so a span joins to the caller's matching tool result. */
  toolCallId: 'gen_ai.tool.call.id',
  /**
   * `sum_of_children` on the request span when its usage is exactly the sum of
   * its model-call child spans (its whole-prompt input = the children's fresh
   * input + cache reads + cache writes). A reader that sums usage over every LLM span
   * skips a span carrying it; one that reads only the request span keeps its
   * total. Absent when the request span's usage is its own measurement.
   */
  usageScope: 'cli_bridge.usage.scope',
  /** Model the provider says served one call, when the backend reported it (GenAI semconv). */
  responseModel: 'gen_ai.response.model',
  /** Prompt tokens one call read from the provider's cache; not part of that call span's `gen_ai.usage.input_tokens`. */
  cacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  /** Prompt tokens one call wrote to the provider's cache; not part of that call span's `gen_ai.usage.input_tokens`. */
  cacheWriteInputTokens: 'gen_ai.usage.cache_creation.input_tokens',
  /** Of the call's output tokens, those spent reasoning (GenAI semconv; included in output). */
  reasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
  /**
   * Digest of the EFFECTIVE AgentProfile this request ran under — WHICH AGENT
   * did this work.
   *
   * Without it a multi-agent run is unreadable: several agents share one run
   * and one trace file, and the only other discriminator is `gen_ai.request.model`,
   * which is not an identity — two agents on the same model are indistinguishable,
   * and one agent whose model changed looks like two.
   *
   * The value is `canonicalAgentProfileDigest` of the profile the request
   * actually executed, which is the SAME `sha256:` string the bridge already
   * writes as `effectiveProfileDigest` on its profile-materialization receipt
   * and its session profile binding — the profile is resolved once per request
   * and memoized, so all three read one object. That makes the digest a join
   * key an operator can carry outward: agent-runtime records the same digest
   * per node (`profileDigest` / `authoredProfileDigest` on its spawn journal),
   * so span → node needs no coincidence of timing or model id.
   *
   * A digest, not the profile: a profile carries prompts, instructions and file
   * contents, and a trace file must not become a second copy of them.
   */
  profileDigest: 'cli_bridge.profile.effective_digest',
  /**
   * The caller's own name for that profile — `agent_profile.name`, verbatim.
   *
   * Read as a LABEL, never as identity: it is caller-supplied, unvalidated and
   * not unique. The digest is the identity; this is what makes a trace readable
   * without a lookup table. Absent when the caller named no profile, because an
   * invented label would be indistinguishable from one the caller chose.
   */
  profileName: 'cli_bridge.profile.name',
  /**
   * Digest of the installed `@tangle-network/agent-trace-contract` build.
   *
   * The package's version string is not an identity — two builds declare the
   * same one and disagree about how a span is validated — so the span records
   * the tree it was built against by content. Absent, never guessed, when the
   * installed tree cannot be read.
   */
  traceContractBuild: 'cli_bridge.trace_contract.build',
} as const)

/** Longest attribute string written. Bounds one pathological value's blast radius. */
const MAX_ATTR_CHARS = 256
/** Longest status message written. Stack traces are truncated, not stored whole. */
const MAX_STATUS_CHARS = 500

export interface TraceEmitterOptions {
  sink: SpanSink
  /** Cap on TOOL spans per request; the count is still reported in full. */
  maxToolSpans: number
  /** Injectable clock, ids and logger for deterministic tests. */
  now?: () => number
  mintTraceId?: () => string
  mintSpanId?: () => string
  log?: (message: string) => void
}

export interface RequestSpanInit {
  runId: string
  /** Model id exactly as the caller asked for it. */
  model: string
  /** Backend that served the request — the `gen_ai.system` value. */
  backend: string
  sessionId?: string | null
  mode?: string | undefined
  execution?: 'host' | 'sandbox'
  caller: ResolvedCallerTrace
}

/**
 * Which agent this request ran as.
 *
 * Not part of {@link RequestSpanInit} because it is not known when the span
 * opens: the span is opened by the run's creator before the profile is
 * resolved, and the profile may arrive on the request OR be carried by the
 * session being resumed. Recorded by {@link RequestSpanRecorder.recordNode}
 * once the route has resolved it, on the same footing as the backend session
 * id the stream discovers mid-flight.
 */
export interface NodeIdentity {
  /** `canonicalAgentProfileDigest` of the effective profile — the join key. */
  profileDigest: string
  /** `agent_profile.name` as the caller wrote it. A label, not an identity. */
  profileName?: string | undefined
}

export class TraceEmitter {
  private readonly sink: SpanSink
  private readonly maxToolSpans: number
  private readonly now: () => number
  private readonly mintTraceId: () => string
  private readonly mintSpanId: () => string
  private readonly log: (message: string) => void

  constructor(options: TraceEmitterOptions) {
    this.sink = options.sink
    this.maxToolSpans = Math.max(0, Math.floor(options.maxToolSpans))
    this.now = options.now ?? (() => Date.now())
    this.mintTraceId = options.mintTraceId ?? newTraceId
    this.mintSpanId = options.mintSpanId ?? newSpanId
    this.log = options.log ?? ((message) => console.error(message))
  }

  /**
   * Open the span for one request. Always returns a recorder — a caller must
   * never have to branch on whether tracing produced one.
   */
  beginRequest(init: RequestSpanInit): RequestSpanRecorder {
    return new RequestSpanRecorder({
      init,
      sink: this.sink,
      maxToolSpans: this.maxToolSpans,
      now: this.now,
      mintSpanId: this.mintSpanId,
      traceId: init.caller.caller?.traceId ?? this.mintTraceId(),
      spanId: this.mintSpanId(),
      log: this.log,
    })
  }
}

interface RecorderOptions {
  init: RequestSpanInit
  sink: SpanSink
  maxToolSpans: number
  now: () => number
  mintSpanId: () => string
  traceId: string
  spanId: string
  log: (message: string) => void
}

/**
 * Accumulates one request's observations and writes each span exactly once.
 *
 * A tool span is written the moment the model asks for the call, once the
 * agent's identity is known, so a live reader sees an agent working long before
 * its turn ends; the request span, whose tokens and status only exist at the
 * end, is written when the request closes.
 *
 * Lives for the duration of the durable run, not the HTTP connection: a client
 * that disconnects mid-stream still gets a complete span, because the run keeps
 * going and the recorder ends with it.
 */
export class RequestSpanRecorder {
  readonly traceId: string
  readonly spanId: string

  private readonly options: RecorderOptions
  private readonly startedAtMs: number
  private readonly toolSpans: ContractSpan[] = []
  /** Tool and model-call spans not yet written: held only until the agent's identity is known. */
  private pendingSpans: ContractSpan[] = []
  private usage: CollectedUsage | undefined
  /** Model-call child spans built; each is written exactly once. */
  private modelCallSpans = 0
  /** End of the last model call, which is where the next one starts. */
  private lastModelCallEndMs: number | undefined
  /** A token-bearing usage record that was not one model call, so the children are not the whole total. */
  private sawTurnLevelTokens = false
  private sawInputTokens = false
  private sawOutputTokens = false
  private toolCallsObserved = 0
  private backendSessionId: string | undefined
  private node: NodeIdentity | undefined
  private finishReason: string | undefined
  private deltaErrorMessage: string | undefined
  /**
   * Wrapped rather than bare so a thrown `undefined` is still recorded as a
   * failure instead of reading as a clean close.
   */
  private failure: { readonly error: unknown } | null = null
  private ended = false

  constructor(options: RecorderOptions) {
    this.options = options
    this.traceId = options.traceId
    this.spanId = options.spanId
    this.startedAtMs = options.now()
  }

  /** Fold one delta into the span. Never throws. */
  observe(delta: ChatDelta): void {
    try {
      // Liveness pings are transport-layer noise; they describe the socket, not
      // the model call, and counting them would inflate every per-span number.
      if (delta.keepalive) return
      if (delta.usage) {
        this.usage = addUsage(this.usage, delta.usage)
        this.sawInputTokens = this.usage.inputTokensKnown
        this.sawOutputTokens = this.usage.outputTokensKnown
        if (delta.usage.model_call === true) this.recordModelCall(delta.usage, delta.model)
        else if (addUsage(undefined, delta.usage).hasTokenUsage) this.sawTurnLevelTokens = true
      }
      if (delta.internal_session_id) this.backendSessionId = delta.internal_session_id
      if (delta.finish_reason) this.finishReason = delta.finish_reason
      if (delta.error?.message) this.deltaErrorMessage = delta.error.message
      for (const call of delta.tool_calls ?? []) this.recordToolCall(call)
    } catch (error) {
      this.report(error)
    }
  }

  /**
   * Name the agent this request runs as. Never throws; last call wins.
   *
   * Called by the route the moment the effective profile is known — before the
   * backend streams — so the identity is on the request span AND on every tool
   * span the turn produces. A request that carries no profile records nothing:
   * the attributes stay absent rather than carrying a placeholder a reader
   * could mistake for an agent.
   */
  recordNode(node: NodeIdentity): void {
    try {
      if (node.profileDigest.length === 0) return
      this.node = node
      if (!this.ended) this.flushPendingSpans()
    } catch (error) {
      this.report(error)
    }
  }

  /** Close the span as a failure, with `error` as the recorded reason. Idempotent. */
  fail(error: unknown): void {
    if (this.ended) return
    this.failure = { error }
    this.writeSpans()
  }

  /**
   * Close the span. Idempotent, so the route can `fail` in a catch and `end` in
   * the `finally` that follows it without emitting the request twice.
   */
  end(): void {
    if (this.ended) return
    this.writeSpans()
  }

  private writeSpans(): void {
    this.ended = true
    try {
      // Tool and model-call spans wait in `pendingSpans` until the identity is
      // known (the route records it once, before the backend streams), so every
      // span of one turn names the same agent or none of them does. A request
      // that never names an agent writes them here, with the request span.
      const pending = this.withNode(this.pendingSpans)
      this.pendingSpans = []
      this.options.sink.write([this.buildRequestSpan(), ...pending])
    } catch (error) {
      this.report(error)
    }
  }

  /** Write held spans now that every span of the turn can name the same agent. */
  private flushPendingSpans(): void {
    if (this.pendingSpans.length === 0) return
    const spans = this.withNode(this.pendingSpans)
    this.pendingSpans = []
    this.options.sink.write(spans)
  }

  /**
   * One provider call finished and the backend reported its usage: write its
   * span now, so live usage is readable before the turn ends. It runs from the
   * previous call's end (or the request start) to now, which is when the bridge
   * learned the call was over.
   */
  private recordModelCall(receipt: NonNullable<ChatDelta['usage']>, responseModel: string | undefined): void {
    // The request span is already written without this call in its total;
    // a child written now would claim usage its parent never counted.
    if (this.ended) return
    const startMs = this.lastModelCallEndMs ?? this.startedAtMs
    const endMs = Math.max(startMs, this.options.now())
    this.lastModelCallEndMs = endMs
    // The same arithmetic the request total uses, applied to one record, so a
    // field is present here exactly when it counts toward that total.
    const call = addUsage(undefined, receipt)
    const { init } = this.options
    const attributes: Record<string, unknown> = {}
    if (responseModel) attributes[BRIDGE_ATTR.responseModel] = truncate(responseModel, MAX_ATTR_CHARS)
    // Absent, never zero, as on the request span.
    if (call.cacheReadInputTokensKnown) attributes[BRIDGE_ATTR.cacheReadInputTokens] = call.cacheReadInputTokens
    if (call.cacheWriteInputTokensKnown) attributes[BRIDGE_ATTR.cacheWriteInputTokens] = call.cacheWriteInputTokens
    if (isCount(receipt.reasoning_output_tokens)) {
      attributes[BRIDGE_ATTR.reasoningOutputTokens] = receipt.reasoning_output_tokens
    }
    if (call.estimated) attributes[BRIDGE_ATTR.usageEstimated] = true
    const span = llmSpan({
      traceId: this.traceId,
      spanId: this.options.mintSpanId(),
      parentSpanId: this.spanId,
      name: 'model call',
      startTime: isoTime(startMs),
      endTime: isoTime(endMs),
      model: truncate(init.model, MAX_ATTR_CHARS),
      system: truncate(init.backend, MAX_ATTR_CHARS),
      // FRESH input only, per the span contract's owner (tangle-network/traces): a
      // per-call reader prices the prompt as fresh + cache read + cache write, so
      // input that already held the cache would count it twice. Absent when the
      // backend did not report the fresh/cache split, rather than guessed.
      ...(call.freshInputTokensKnown ? { inputTokens: call.freshInputTokens } : {}),
      ...(call.outputTokensKnown ? { outputTokens: call.outputTokens } : {}),
      ...(call.costComplete ? { costUsd: call.cost } : {}),
      attributes,
      resource: { attributes: { 'service.name': 'cli-bridge' } },
    })
    this.modelCallSpans += 1
    this.pendingSpans.push(span)
    if (this.node !== undefined) this.flushPendingSpans()
  }

  private withNode(spans: readonly ContractSpan[]): ContractSpan[] {
    const node = this.nodeAttributes()
    return Object.keys(node).length === 0
      ? [...spans]
      : spans.map((span) => ({ ...span, attributes: { ...span.attributes, ...node } }))
  }

  /** The node identity as span attributes — empty when the request named no agent. */
  private nodeAttributes(): Record<string, string> {
    if (this.node === undefined) return {}
    const name = this.node.profileName
    return {
      [BRIDGE_ATTR.profileDigest]: truncate(this.node.profileDigest, MAX_ATTR_CHARS),
      // Absent, never `''`: an empty label reads as "the caller named it
      // nothing", which is a different claim from "the caller named nothing".
      ...(name !== undefined && name.length > 0
        ? { [BRIDGE_ATTR.profileName]: truncate(name, MAX_ATTR_CHARS) }
        : {}),
    }
  }

  private recordToolCall(call: { id: string; name: string; arguments: string }): void {
    this.toolCallsObserved += 1
    if (this.toolSpans.length >= this.options.maxToolSpans) return
    const at = isoTime(this.options.now())
    const name = truncate(call.name, MAX_ATTR_CHARS)
    // `call.arguments` is deliberately dropped: it carries prompts, file contents
    // and paths, and a trace file must not become a second copy of everything the
    // agent read.
    const span = toolSpan({
      traceId: this.traceId,
      spanId: this.options.mintSpanId(),
      parentSpanId: this.spanId,
      // The span NAME is a human label. `gen_ai.tool.name` is the DATA, and the
      // builder omits it when the backend reported no name — so a nameless call
      // still shows up as work done, and the validator still reports that a
      // per-tool breakdown is unavailable rather than inventing a name.
      name: name.length > 0 ? name : 'unnamed tool call',
      startTime: at,
      endTime: at,
      toolName: name,
      ...(call.id ? { attributes: { [BRIDGE_ATTR.toolCallId]: truncate(call.id, MAX_ATTR_CHARS) } } : {}),
    })
    this.toolSpans.push(span)
    this.pendingSpans.push(span)
    if (this.node !== undefined) this.flushPendingSpans()
  }

  private buildRequestSpan(): ContractSpan {
    const { init } = this.options
    const attributes: Record<string, unknown> = {
      [BRIDGE_ATTR.runId]: truncate(init.runId, MAX_ATTR_CHARS),
      [BRIDGE_ATTR.correlation]: init.caller.correlation,
      [BRIDGE_ATTR.execution]: init.execution ?? 'host',
      [BRIDGE_ATTR.toolCallsObserved]: this.toolCallsObserved,
      ...this.nodeAttributes(),
    }
    if (init.mode) attributes[BRIDGE_ATTR.mode] = truncate(init.mode, MAX_ATTR_CHARS)
    if (init.sessionId) attributes[BRIDGE_ATTR.sessionId] = truncate(init.sessionId, MAX_ATTR_CHARS)
    if (this.backendSessionId) {
      attributes[BRIDGE_ATTR.backendSessionId] = truncate(this.backendSessionId, MAX_ATTR_CHARS)
    }
    if (this.finishReason) attributes[BRIDGE_ATTR.finishReason] = this.finishReason
    if (this.usage?.estimated) attributes[BRIDGE_ATTR.usageEstimated] = true
    if (this.modelCallSpans > 0 && !this.sawTurnLevelTokens) {
      attributes[BRIDGE_ATTR.usageScope] = 'sum_of_children'
    }
    const contractBuild = traceContractBuildIdOrNull()
    if (contractBuild !== null) attributes[BRIDGE_ATTR.traceContractBuild] = contractBuild
    const dropped = this.toolCallsObserved - this.toolSpans.length
    if (dropped > 0) attributes[BRIDGE_ATTR.toolCallsDropped] = dropped

    return llmSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: init.caller.caller?.parentSpanId ?? null,
      name: `chat ${init.backend}`,
      startTime: isoTime(this.startedAtMs),
      endTime: isoTime(this.options.now()),
      status: this.status(),
      model: truncate(init.model, MAX_ATTR_CHARS),
      system: truncate(init.backend, MAX_ATTR_CHARS),
      // Absent, never zero. A synthesized `0` is indistinguishable from a
      // measured one downstream, and turns "not reported" into "free".
      ...(this.sawInputTokens ? { inputTokens: this.usage?.inputTokens } : {}),
      ...(this.sawOutputTokens ? { outputTokens: this.usage?.outputTokens } : {}),
      // Cost only when every contributing record reported one. An incomplete sum
      // written to `gen_ai.usage.cost_usd` would be read as the total it is not.
      ...(this.usage?.costComplete ? { costUsd: this.usage.cost } : {}),
      attributes,
      resource: { attributes: { 'service.name': 'cli-bridge' } },
    })
  }

  private status(): SpanStatus {
    if (this.failure !== null) {
      return {
        code: 'STATUS_CODE_ERROR',
        message: truncate(describe(this.failure.error), MAX_STATUS_CHARS),
      }
    }
    if (this.finishReason === 'error' || this.finishReason === 'timeout') {
      return {
        code: 'STATUS_CODE_ERROR',
        message: truncate(
          this.deltaErrorMessage ?? `backend ended the stream with finish_reason ${this.finishReason}`,
          MAX_STATUS_CHARS,
        ),
      }
    }
    // No terminal delta and no failure means the stream ended without saying how
    // it ended. UNSET says exactly that; OK would be a claim nobody made.
    return this.finishReason === undefined
      ? { code: 'STATUS_CODE_UNSET' }
      : { code: 'STATUS_CODE_OK' }
  }

  private report(error: unknown): void {
    this.options.log(
      `[cli-bridge] trace emission failed for run ${this.options.init.runId} ` +
      `(tracing degraded, request unaffected): ${describe(error)}`,
    )
  }
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
