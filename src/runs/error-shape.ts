/**
 * One place that turns a thrown failure into the `{ message, type }` pair a
 * caller sees, so a reason cannot be lost between the run buffer and the HTTP
 * response.
 *
 * Kept free of route and backend imports on purpose: the run registry owns the
 * buffered stream and must be able to attach the reason to the terminal delta
 * itself. The mapping is therefore structural — a `code` string on the error, or
 * the class name — rather than a list of `instanceof` checks, which also means a
 * new typed error surfaces its own code without touching this file.
 *
 * `type` is advisory metadata for the caller. HTTP status selection stays with
 * the route's `errorResponse`, which maps the real error object, so a failure
 * before the first delta and the same failure after it produce the same status.
 */

/** Error classes whose name alone determines the reported type. */
const TYPE_BY_ERROR_NAME: Record<string, string> = {
  ModeNotSupportedError: 'mode_not_supported',
  RunReplayCursorError: 'invalid_replay_cursor',
}

export interface RunFailureDescription {
  message: string
  type: string
  provider_dispatch?: 'not_started'
}

export function describeRunFailure(error: unknown): RunFailureDescription {
  const message = error instanceof Error ? error.message : String(error)
  const providerDispatch = providerDispatchFromError(error)
  return {
    message,
    type: failureType(error),
    ...(providerDispatch === undefined ? {} : { provider_dispatch: providerDispatch }),
  }
}

/**
 * The failure a backend ENDED a run with by yielding a terminal error delta
 * rather than throwing.
 *
 * It exists so `Run.failure()` is populated for both routes into a terminal
 * error, because the reader turns exactly that value into an HTTP status.
 * Measured on af03d59: opencode yields `{ finish_reason: 'error' }` with no
 * reason on abort and after an error event, the registry's catch block never
 * ran, and the caller received HTTP 200 with `content: ""` and no `error` key —
 * which a benchmark harness scores 0.000, indistinguishable from a model that
 * answered nothing.
 */
export class BackendReportedFailureError extends Error {
  readonly providerDispatch?: 'not_started'

  constructor(
    message: string,
    readonly code: string,
    options?: { providerDispatch?: 'not_started' },
  ) {
    super(message)
    this.name = 'BackendReportedFailureError'
    this.providerDispatch = options?.providerDispatch
  }
}

/**
 * The reason for a terminal error/timeout delta, guaranteed non-empty.
 *
 * A backend that knows its reason attaches it and this preserves it verbatim.
 * One that does not gets a reason that says so plainly and names where to look,
 * because "the bridge cannot attribute this" is honest and an empty message is
 * not. `label` is the backend/CLI name when known.
 */
export function reasonForTerminalDelta(
  finishReason: 'error' | 'timeout',
  existing: RunFailureDescription | undefined,
  label: string,
): RunFailureDescription {
  if (existing && existing.message.length > 0) return existing
  if (finishReason === 'timeout') {
    return {
      message: `${label} timed out before it produced a terminal answer`,
      type: 'timeout',
    }
  }
  return {
    message:
      `${label} ended the run with finish_reason "error" and reported no reason, so the bridge cannot attribute ` +
      `it; check the bridge log for this run id`,
    type: 'unattributed_backend_error',
  }
}

function failureType(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'server_error'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.length > 0) return code
  const name = (error as { name?: unknown }).name
  if (typeof name === 'string' && TYPE_BY_ERROR_NAME[name]) return TYPE_BY_ERROR_NAME[name]
  return 'server_error'
}

function providerDispatchFromError(error: unknown): 'not_started' | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { providerDispatch?: unknown }).providerDispatch === 'not_started'
    ? 'not_started'
    : undefined
}
