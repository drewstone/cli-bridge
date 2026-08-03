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
 *       └─ <tool>     (TOOL)     gen_ai.tool.name, gen_ai.tool.call.id
 *
 * The LLM span is the whole request because that is the granularity the bridge
 * can actually see: a CLI harness reports ONE usage record for the turn, not one
 * per model call, so splitting it into per-call spans would mean inventing
 * boundaries and dividing tokens that were never reported separately.
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
 * Accumulates one request's observations and writes its spans exactly once.
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
  private usage: CollectedUsage | undefined
  private sawInputTokens = false
  private sawOutputTokens = false
  private toolCallsObserved = 0
  private backendSessionId: string | undefined
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
      }
      if (delta.internal_session_id) this.backendSessionId = delta.internal_session_id
      if (delta.finish_reason) this.finishReason = delta.finish_reason
      if (delta.error?.message) this.deltaErrorMessage = delta.error.message
      for (const call of delta.tool_calls ?? []) this.recordToolCall(call)
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
      this.options.sink.write([this.buildRequestSpan(), ...this.toolSpans])
    } catch (error) {
      this.report(error)
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
    this.toolSpans.push(toolSpan({
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
    }))
  }

  private buildRequestSpan(): ContractSpan {
    const { init } = this.options
    const attributes: Record<string, unknown> = {
      [BRIDGE_ATTR.runId]: truncate(init.runId, MAX_ATTR_CHARS),
      [BRIDGE_ATTR.correlation]: init.caller.correlation,
      [BRIDGE_ATTR.execution]: init.execution ?? 'host',
      [BRIDGE_ATTR.toolCallsObserved]: this.toolCallsObserved,
    }
    if (init.mode) attributes[BRIDGE_ATTR.mode] = truncate(init.mode, MAX_ATTR_CHARS)
    if (init.sessionId) attributes[BRIDGE_ATTR.sessionId] = truncate(init.sessionId, MAX_ATTR_CHARS)
    if (this.backendSessionId) {
      attributes[BRIDGE_ATTR.backendSessionId] = truncate(this.backendSessionId, MAX_ATTR_CHARS)
    }
    if (this.finishReason) attributes[BRIDGE_ATTR.finishReason] = this.finishReason
    if (this.usage?.estimated) attributes[BRIDGE_ATTR.usageEstimated] = true
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

function isoTime(ms: number): string {
  return new Date(ms).toISOString()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
