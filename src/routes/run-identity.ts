/**
 * Durable-run identity: how one chat request becomes the digest a run id is
 * claimed against, plus the protected-model-credential helpers the same
 * identity consumes. Extracted from the chat-completions route so the wire
 * contract and its identity math stay independently readable.
 */
import { createHash } from 'node:crypto'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import type { ChatRequest } from '../backends/types.js'

/** Bind a run id to execution semantics, not response representation. `stream` and runtime-owned
 * materialization fields do not change the backend job and are deliberately excluded. */
export function durableRunRequestDigest(req: ChatRequest, backend: string): string {
  const {
    stream: _stream,
    jailSpec: _jailSpec,
    profile_materialization_receipt: _materialization,
    // Runtime attachments are process-ephemeral platform endpoints. A
    // dispatcher that restarts re-issues the same job from a new port, and
    // that reconnect must re-attach to the in-flight run, not conflict.
    runtime_attachments: _runtimeAttachments,
    protectedModelCredential, runtimeCoordinationBearer: _runtimeCoordinationBearer,
    ...executionRequest
  } = req
  // The request originated as JSON, but object spreads can reintroduce
  // optional `undefined` properties. A JSON round trip restores exact wire
  // semantics before RFC 8785 canonicalization (undefined object fields are
  // absent; array values retain their JSON form).
  const normalized = JSON.parse(JSON.stringify({
    schema: 'cli-bridge.durable-run-request.v1',
    backend,
    request: { ...executionRequest },
    ...(protectedModelCredential
      ? {
          protectedModelCredentialDigest: protectedModelCredential.digest,
          protectedModelBaseUrlDigest: protectedModelCredential.baseUrlDigest,
        }
      : {}),
  })) as Parameters<typeof canonicalCandidateDigest>[0]
  return canonicalCandidateDigest(normalized)
}

export function protectedCredentialDigest(token: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

export function canonicalProtectedModelBaseUrl(value: string): string | undefined {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return undefined
  }
  if (
    target.protocol !== 'https:'
    || target.username
    || target.password
    || target.search
    || target.hash
  ) {
    return undefined
  }
  return target.toString().replace(/\/$/u, '')
}
