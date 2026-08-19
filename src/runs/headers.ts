import type { Context } from 'hono'
import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import { isSafeWireIdentifier } from './identifiers.js'

/** The six fields that identify one durable run across control and replay calls. */
export interface RunIdentityHeaderSource {
  readonly id: string
  readonly requestDigest: string
  readonly provider?: string
  readonly environmentId?: string
  readonly sessionId?: string
  readonly executionId?: string
}

/** Expose the exact durable-run identity on every status, replay, and control response. */
export function setRunIdentityHeaders(c: Context, snapshot: RunIdentityHeaderSource): void {
  setHeader(c, 'X-Run-Id', snapshot.id)
  setHeader(c, 'X-Run-Request-Digest', snapshot.requestDigest)
  if (snapshot.provider !== undefined) setHeader(c, 'X-Run-Provider', snapshot.provider)
  if (snapshot.environmentId !== undefined) setHeader(c, 'X-Run-Environment-Id', snapshot.environmentId)
  if (snapshot.sessionId !== undefined) setHeader(c, 'X-Run-Session-Id', snapshot.sessionId)
  if (snapshot.executionId !== undefined) setHeader(c, 'X-Run-Execution-Id', snapshot.executionId)
}

/** Exact cancellation responses always expose all six identity coordinates. */
export function setExactRunIdentityHeaders(c: Context, run: AgentExactRunControlRef): void {
  setRunIdentityHeaders(c, {
    id: run.runId,
    requestDigest: run.requestDigest,
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
  })
}

function setHeader(c: Context, name: string, value: string): void {
  if (!isSafeWireIdentifier(value)) {
    throw new Error(`refusing unsafe durable-run header ${name}`)
  }
  c.header(name, value)
}
