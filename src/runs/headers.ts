import type { Context } from 'hono'

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
  c.header('X-Run-Id', snapshot.id)
  c.header('X-Run-Request-Digest', snapshot.requestDigest)
  if (snapshot.provider !== undefined) c.header('X-Run-Provider', snapshot.provider)
  if (snapshot.environmentId !== undefined) c.header('X-Run-Environment-Id', snapshot.environmentId)
  if (snapshot.sessionId !== undefined) c.header('X-Run-Session-Id', snapshot.sessionId)
  if (snapshot.executionId !== undefined) c.header('X-Run-Execution-Id', snapshot.executionId)
}
