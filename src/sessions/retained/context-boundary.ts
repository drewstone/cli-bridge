/**
 * Proof that a continuation resumes the same provider context it left.
 *
 * Between two turns the provider may compact, fork, or lose its history. A
 * retained turn is therefore only continued after the child re-states a
 * boundary identical to the one recorded at the end of the previous turn, and
 * an unobservable boundary is recorded as `unverified` rather than assumed
 * good.
 */

import {
  NativeContextBoundaryProofSchema,
  canonicalCandidateJson,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from '../../backends/types.js'
import type { RetainedSessionRecord } from '../store.js'
import { RetainedSessionError } from './types.js'

const NATIVE_BOUNDARY_TIMEOUT_MS = 5_000

export async function observeNativeBoundary(
  native: NativeSession,
  input: {
    runId: string
    provider: string
    environmentId: string
    sessionId: string
    executionId: string
    requestDigest: string
  },
): Promise<NativeContextBoundaryProof | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NATIVE_BOUNDARY_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    let request: Promise<NativeContextBoundaryProof | null>
    try {
      request = Promise.resolve(native.contextBoundary(input)).catch(() => null)
    } catch {
      return null
    }
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Refuse a continuation whose provider boundary is absent, changed, or unprovable. */
export async function verifyRetainedBoundary(
  native: NativeSession,
  record: RetainedSessionRecord,
  runId: string,
  current: { provider: string; environmentId: string; executionId: string; requestDigest: string },
): Promise<void> {
  const expected = record.contextBoundary
  const parsedExpected = expected ? NativeContextBoundaryProofSchema.safeParse(expected) : null
  if (
    !parsedExpected?.success ||
    !record.runId ||
    parsedExpected.data.runId !== record.runId ||
    parsedExpected.data.provider !== current.provider ||
    parsedExpected.data.environmentId !== current.environmentId ||
    parsedExpected.data.sessionId !== record.id
  ) {
    throw new RetainedSessionError(
      'retained turn is unverified; the provider boundary must be proven before another turn',
      501,
      'capability_denied',
    )
  }
  const observed = await observeNativeBoundary(native, {
    runId,
    sessionId: record.id,
    ...current,
  })
  const parsedObserved = observed ? NativeContextBoundaryProofSchema.safeParse(observed) : null
  if (
    !parsedObserved?.success ||
    parsedObserved.data.runId !== runId ||
    parsedObserved.data.provider !== current.provider ||
    parsedObserved.data.environmentId !== current.environmentId ||
    parsedObserved.data.sessionId !== record.id ||
    parsedObserved.data.executionId !== current.executionId ||
    parsedObserved.data.requestDigest !== current.requestDigest ||
    canonicalCandidateJson(parsedObserved.data.boundary) !== canonicalCandidateJson(parsedExpected.data.boundary)
  ) {
    throw new RetainedSessionError(
      'retained turn boundary changed or could not be verified',
      409,
      'context_boundary_mismatch',
    )
  }
}

/** The boundary to persist for a completed turn; never throws. */
export async function completedTurnBoundary(
  native: NativeSession,
  input: {
    runId: string
    sessionId: string
    backend: string
    provider: string
    environmentId: string
    executionId: string
    requestDigest: string
  },
): Promise<Record<string, unknown>> {
  const proof = await observeNativeBoundary(native, {
    runId: input.runId,
    provider: input.provider,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    requestDigest: input.requestDigest,
  })
  const parsed = proof ? NativeContextBoundaryProofSchema.safeParse(proof) : null
  return parsed?.success &&
    parsed.data.runId === input.runId &&
    parsed.data.provider === input.provider &&
    parsed.data.environmentId === input.environmentId &&
    parsed.data.sessionId === input.sessionId &&
    parsed.data.executionId === input.executionId &&
    parsed.data.requestDigest === input.requestDigest
    ? (parsed.data as unknown as Record<string, unknown>)
    : { status: 'unverified', reason: `${input.backend} native state did not expose a verifiable revision` }
}
