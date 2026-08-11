/**
 * Trace/span identity and caller correlation.
 *
 * cli-bridge is the choke point for every coder harness routed through it, so a
 * span it emits is only useful if it lands INSIDE the caller's trace. A VB round
 * and the bridge request it caused have to be one tree; two unrelated traces
 * that happen to be adjacent in time answer nothing.
 *
 * Correlation comes off the wire in one of two forms:
 *   - W3C `traceparent` — the interop standard, what any OTel-instrumented
 *     caller already sends;
 *   - `X-Trace-Id` / `X-Parent-Span-Id` — the explicit fallback for callers that
 *     have ids but no tracing SDK to format a `traceparent` with.
 *
 * A malformed correlation header NEVER fails a request and never throws: the
 * request gets a fresh root trace and the span records `invalid`, so an operator
 * asking "why didn't my traces join up" reads the answer off the span instead of
 * guessing.
 */

import { randomBytes } from 'node:crypto'

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u
const HEX_PAIR_PATTERN = /^[0-9a-f]{2}$/u
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

/** 16 random bytes as lowercase hex — the OTLP trace-id encoding. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

/** 8 random bytes as lowercase hex — the OTLP span-id encoding. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Normalize a caller-supplied trace id. Accepts the dashed UUID spelling because
 * callers that mint ids with `crypto.randomUUID()` have exactly the right 128
 * bits in the wrong punctuation, and rejecting them would cost a real join for a
 * cosmetic reason. An all-zero id is the OTLP "invalid" sentinel and is refused.
 */
export function normalizeTraceId(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().replace(/-/gu, '').toLowerCase()
  if (!TRACE_ID_PATTERN.test(candidate)) return null
  return candidate === ZERO_TRACE_ID ? null : candidate
}

/** Normalize a caller-supplied span id. All-zero is the OTLP "invalid" sentinel. */
export function normalizeSpanId(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase()
  if (!SPAN_ID_PATTERN.test(candidate)) return null
  return candidate === ZERO_SPAN_ID ? null : candidate
}

/** The caller's position in its own trace, which this request nests under. */
export interface CallerTrace {
  traceId: string
  /** The caller's span id — the parent of the span this request emits. */
  parentSpanId: string | null
}

/**
 * Where the caller context came from, recorded on the span.
 *
 * `invalid` means a correlation header WAS supplied and could not be used, which
 * is the one case an operator has to be able to distinguish from `none`.
 */
export type TraceCorrelation = 'traceparent' | 'headers' | 'none' | 'invalid'

export interface CallerTraceHeaders {
  traceparent?: string | undefined
  traceId?: string | undefined
  parentSpanId?: string | undefined
}

export interface ResolvedCallerTrace {
  caller: CallerTrace | null
  correlation: TraceCorrelation
}

/**
 * Parse a W3C `traceparent`.
 *
 * Strict on case: the spec requires lowercase hex, so an uppercase value is a
 * malformed `traceparent`, not a lenient one. Being forgiving here would hide a
 * broken producer behind traces that silently stop joining. Version `00` is
 * exactly four fields; a higher version may carry more, and per the spec the
 * first four are still readable.
 */
export function parseTraceparent(value: string | undefined | null): CallerTrace | null {
  if (typeof value !== 'string') return null
  const fields = value.trim().split('-')
  if (fields.length < 4) return null
  const [version, traceId, spanId, flags] = fields as [string, string, string, string]
  if (!HEX_PAIR_PATTERN.test(version) || version === 'ff') return null
  if (version === '00' && fields.length !== 4) return null
  if (!HEX_PAIR_PATTERN.test(flags)) return null
  if (!TRACE_ID_PATTERN.test(traceId) || !SPAN_ID_PATTERN.test(spanId)) return null
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null
  return { traceId, parentSpanId: spanId }
}

/**
 * Resolve the caller's trace context from the request headers.
 *
 * `traceparent` wins when it parses. A parent span id without a trace id cannot
 * be joined to anything — the span it names is unreachable — so it is reported
 * as `invalid` rather than half-applied.
 */
export function resolveCallerTrace(headers: CallerTraceHeaders): ResolvedCallerTrace {
  const supplied =
    isPresent(headers.traceparent) ||
    isPresent(headers.traceId) ||
    isPresent(headers.parentSpanId)

  const fromTraceparent = parseTraceparent(headers.traceparent)
  if (fromTraceparent) return { caller: fromTraceparent, correlation: 'traceparent' }

  const traceId = normalizeTraceId(headers.traceId)
  if (traceId) {
    return {
      caller: { traceId, parentSpanId: normalizeSpanId(headers.parentSpanId) },
      correlation: 'headers',
    }
  }

  return { caller: null, correlation: supplied ? 'invalid' : 'none' }
}

function isPresent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Env vars a spawned harness child inherits so its spans join the caller's
 * trace across the process boundary.
 *
 * The wire is what agent-runtime's `readTraceContextFromEnv` reads at child
 * startup: W3C `TRACEPARENT` first, its bespoke `TRACE_ID` /
 * `PARENT_SPAN_ID` pair as the fallback. Both spellings are written so a
 * child on either package generation joins the SAME trace. `TRACEPARENT`
 * requires a span id by grammar; with a trace id alone only the legacy pair
 * carries the trace, which is the degradation the runtime's reader expects.
 *
 * A `null` context returns `{}`: a request that carried no correlation
 * stamps nothing, and the child env stays byte-identical to what it was
 * before this channel existed.
 */
export function traceContextToChildEnv(
  ctx: CallerTrace | null | undefined,
): Record<string, string> {
  if (!ctx) return {}
  const env: Record<string, string> = { TRACE_ID: ctx.traceId }
  if (ctx.parentSpanId) {
    env.PARENT_SPAN_ID = ctx.parentSpanId
    env.TRACEPARENT = `00-${ctx.traceId}-${ctx.parentSpanId}-01`
  }
  return env
}
