import { BackendReportedFailureError } from '../runs/error-shape.js'
import type { BackendFailureReason } from './types.js'
import type { ProcessExit } from './process-lines.js'

/** A native result is provisional until its one-shot harness process exits successfully. */
export function classifyHarnessFailure(exit: ProcessExit, diagnostic: string): BackendFailureReason | undefined {
  if (exit.code === 0 && exit.signal === null) return undefined
  const message = diagnostic.trim() || `harness ${exit.signal ? `terminated by ${exit.signal}` : `exited ${exit.code ?? 'without status'}`}`
  const type = /model_not_found|unknown model|invalid model|model[^\n]*(?:not found|does not exist|not available)/i.test(message)
    ? 'MODEL_NOT_FOUND'
    : /not logged in|not authenticated|authentication (?:failed|required)|invalid (?:api key|token)|login required/i.test(message)
      ? 'SEAT_NOT_LOGGED_IN'
      : 'NODE_DOWN'
  return { type, message }
}

export function throwHarnessFailure(reason: BackendFailureReason): never {
  throw new BackendReportedFailureError(reason.message, reason.type)
}
