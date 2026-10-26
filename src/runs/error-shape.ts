/** Shared allowlisted failure description for HTTP, SSE and durable replay. */
import { BackendError, type SubscriptionFailureMetadata } from '../backends/types.js'

/** Error classes whose name alone determines the reported type. */
const TYPE_BY_ERROR_NAME: Record<string, string> = {
  ModeNotSupportedError: 'mode_not_supported',
  RunReplayCursorError: 'invalid_replay_cursor',
}

export interface RunFailureDescription extends Partial<SubscriptionFailureMetadata> {
  message: string
  type: string
  provider_dispatch?: 'not_started'
  /** Status the same failure would carry as an HTTP response. */
  status?: number
  /** Capacity refusal: the bridge never started the model. */
  capacity?: true
  /** Executor semaphore counts behind a capacity refusal. */
  executor?: {
    name: string
    in_flight: number
    max: number
    queued: number
    deadline_ms: number
  }
}

export function describeRunFailure(error: unknown): RunFailureDescription {
  if (error instanceof BackendError && error.code === 'subscription_required' && error.providerDispatch === 'not_started') {
    const candidate = error
    const metadata = candidate.subscription
    if (metadata && ['api_key_selected', 'provider_unresolved', 'subscription_unverified', 'not_authenticated'].includes(metadata.cause)
      && typeof metadata.fix === 'string' && metadata.fix.trim().length > 0 && metadata.fix.length <= 256
      && typeof metadata.harness === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(metadata.harness)
      && (metadata.provider === null || typeof metadata.provider === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(metadata.provider))) {
      return { type: 'subscription_required', message: String(candidate.message ?? 'Subscription authentication is required').slice(0, 512),
        cause: metadata.cause, fix: metadata.fix, harness: metadata.harness, provider: metadata.provider,
        provider_dispatch: 'not_started', status: 403 }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const providerDispatch = providerDispatchFromError(error)
  return {
    message,
    type: failureType(error),
    ...(providerDispatch === undefined ? {} : { provider_dispatch: providerDispatch }),
    ...capacityFromError(error),
  }
}

/** A yielded provider failure becomes a recorded run failure for HTTP/replay status selection. */
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

/** Yielded worker failures cannot claim Bridge admission authority; unclassified terminals stay explicit. */
export function reasonForTerminalDelta(
  finishReason: 'error' | 'timeout',
  existing: RunFailureDescription | undefined,
  label: string,
): RunFailureDescription {
  if (existing?.type === 'subscription_required') return { message: existing.message, type: 'upstream', status: 502 }
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

/** Preserve the executor's typed capacity/status counts without interpreting prose. */
function capacityFromError(error: unknown): Pick<RunFailureDescription, 'status' | 'capacity' | 'executor'> {
  if (typeof error !== 'object' || error === null) return {}
  const candidate = error as {
    httpStatus?: unknown
    capacity?: unknown
    executor?: unknown
    snapshot?: unknown
  }
  if (candidate.capacity !== true) return {}
  const snapshot = candidate.snapshot
  const counts = typeof snapshot === 'object' && snapshot !== null
    ? snapshot as { in_flight?: unknown; max?: unknown; queued?: unknown; deadline_ms?: unknown }
    : null
  return {
    ...(typeof candidate.httpStatus === 'number' ? { status: candidate.httpStatus } : {}),
    capacity: true,
    ...(counts
      && typeof candidate.executor === 'string'
      && typeof counts.in_flight === 'number'
      && typeof counts.max === 'number'
      && typeof counts.queued === 'number'
      && typeof counts.deadline_ms === 'number'
      ? {
          executor: {
            name: candidate.executor,
            in_flight: counts.in_flight,
            max: counts.max,
            queued: counts.queued,
            deadline_ms: counts.deadline_ms,
          },
        }
      : {}),
  }
}

function providerDispatchFromError(error: unknown): 'not_started' | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { providerDispatch?: unknown }).providerDispatch === 'not_started'
    ? 'not_started'
    : undefined
}
