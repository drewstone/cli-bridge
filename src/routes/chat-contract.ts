import type { Context } from 'hono'
import { z } from 'zod'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import type { ChatRequest } from '../backends/types.js'

const DEFAULT_SSE_HEARTBEAT_MS = 15_000

export class SandboxBackendUnavailableError extends Error {
  readonly code = 'not_found_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'SandboxBackendUnavailableError'
  }
}

const durableRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    'run id must be URL-safe: letters, digits, dot, underscore, colon, or hyphen',
  )

export const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        // Per OpenAI Chat Completions: `content` is nullable when
        // `tool_calls` is present on an assistant message. Accepting null
        // here is the difference between "agent loops work" and "every
        // assistant tool-call round trips back as invalid chat request".
        content: z.union([
          z.string(),
          z.null(),
          z.array(
            z.union([
              z.object({ type: z.literal('text'), text: z.string() }),
              z.object({
                type: z.union([z.literal('image_url'), z.literal('input_image')]),
                image_url: z.union([z.string(), z.object({ url: z.string() })]),
              }),
              z.object({
                type: z.literal('image'),
                image: z.string(),
                mediaType: z.string().optional(),
                mimeType: z.string().optional(),
              }),
            ]),
          ),
        ]),
        // Assistant messages from the model carry `tool_calls` so the
        // server-side history retains the decision the model made. Without
        // this field declared, Zod's default strip-mode silently drops it
        // and the model's loop loses its own prior decisions.
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal('function'),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional(),
        tool_call_id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  // Mirrors the canonical ReasoningEffort ladder in @tangle-network/agent-interface.
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultracode']).optional(),
  interaction_policy: z.enum(['interactive', 'unattended-deny', 'unattended-allow']).optional(),
  session_id: z.string().optional(),
  resume_id: z.string().optional(), // alias for session_id
  /**
   * Durable-run id. Decouples the JOB from this HTTP connection. A
   * client disconnect never kills the run; a reconnect/retry that reuses
   * the same `run_id` RE-ATTACHES to the same in-flight subprocess
   * (idempotent dispatch) instead of cold-starting a second one.
   *
   * Absent → a fresh run id is minted per request (today's behavior,
   * minus the kill-on-disconnect). Also accepted via `X-Run-Id`.
   *
   * Reconnect replay: send `Last-Event-ID: <seq>` (or `X-Last-Event-Id`)
   * with the same run_id to replay only the deltas missed since `seq`.
   */
  run_id: durableRunIdSchema.optional(),
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  // OpenAI-compatible shape — wire is snake_case, TS is camelCase. We
  // translate to responseFormat when we build the ChatRequest below.
  response_format: z
    .object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      json_schema: z.unknown().optional(),
    })
    .optional(),
  agent_profile: z.unknown().optional(),
  /**
   * Standardised MCP passthrough. Shape mirrors Claude Code's
   * `mcp-config.json` so the same JSON can be forwarded to every
   * backend that supports MCP natively (claude `--mcp-config`, codex
   * `CODEX_HOME/config.toml`, kimi `--mcp-config-file`, opencode
   * `OPENCODE_CONFIG`). Validation is permissive (`z.unknown()` for
   * each spec) so callers can pass backend-specific fields without
   * cli-bridge silently stripping them — the per-backend
   * materializers normalize. Use the canonical `command/args/env`
   * (stdio) or `url/headers` (http) layout for cross-backend
   * portability.
   *
   * Also accepted via the `X-Mcp-Config` request header (JSON-encoded
   * same shape). Body wins on conflict.
   */
  mcp: z
    .object({
      mcpServers: z.record(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
  cwd: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Where the harness runs.
   *
   *   `host` (default)  — spawn the chosen harness CLI (claude/kimi/...)
   *                       on the host. Uses cli-bridge's local executor
   *                       and the operator's CLI subscription auth.
   *
   *   `sandbox`         — provision a Tangle sandbox with the equivalent
   *                       in-container backend (kimi-code, claude-code,
   *                       codex, opencode, ...) and dispatch the prompt
   *                       there via SubagentRunner-style sidecar.
   *
   * Same agent_profile + prompt + cwd contract regardless. Switching
   * targets is a one-field change for the caller.
   */
  execution: z
    .object({
      kind: z.enum(['host', 'sandbox']),
      /** When kind=sandbox, the repoUrl to clone into /workspace before dispatch. */
      repoUrl: z.string().optional(),
      /** When kind=sandbox, the git ref to check out post-clone. */
      gitRef: z.string().optional(),
      /** When kind=sandbox, the sandbox capability tier (defaults to 'base'). */
      capability: z.string().optional(),
      /** When kind=sandbox, the sandbox TTL in seconds (default 30 min). */
      ttlSeconds: z.number().int().positive().optional(),
      /**
       * When kind=host, an optional per-request jail override.
       *   mode: 'write-jail' confines WRITES to the jail root; 'fs-jail' also
       *         confines READS to a minimal system+toolchain allowlist so the
       *         CLI cannot read the host repo or sibling run scratch dirs. NOTE:
       *         the operator env floor (`BRIDGE_JAIL_MODE`, or `WORKER_FS_JAIL=1`
       *         for fs-jail) can only be RAISED by a request, never lowered — a
       *         per-request 'off' or 'write-jail' cannot weaken a higher floor.
       *         'off' takes effect only when no env floor is set.
       *   root: writable jail root (default <cwd>/.agent-home), clamped
       *         inside the request cwd.
       * Layered over the BRIDGE_JAIL_MODE / WORKER_FS_JAIL / BRIDGE_JAIL_ROOT env defaults.
       */
      jail: z
        .object({
          mode: z.enum(['off', 'write-jail', 'fs-jail']).optional(),
          root: z.string().optional(),
        })
        .optional(),
      /**
       * Deny-by-default EGRESS for the worker process tree — the network sibling
       * of `jail` above.
       *   mode: 'net-jail' requires that the worker run with no route off its
       *         network except an allowlist that always contains the backend's
       *         own model endpoint. The operator floor (`BRIDGE_NET_JAIL_MODE`,
       *         or `WORKER_NET_JAIL=1`) can only be RAISED by a request. A
       *         request the bridge cannot enforce FAILS with 501 naming the
       *         execution mode; it is never accepted and quietly not applied.
       *   allow: asserts the exact `host:port` allowlist in force. It does not
       *         change the allowlist — a pooled worker joined its network when
       *         the bridge started — so a list that differs from the enforced one
       *         is a failure, not a silent widening.
       */
      netJail: z
        .object({
          mode: z.enum(['off', 'net-jail']).optional(),
          allow: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
})

export type ParsedHeader<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export function resolveSessionId(
  aliases: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): ParsedHeader<string | undefined> {
  const supplied = aliases.filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
  for (const [name, value] of supplied) {
    if (value.length === 0 || value.length > 512 || value.trim() !== value) {
      return {
        ok: false,
        message: `${name} must be a non-empty identifier of at most 512 characters without outer whitespace`,
      }
    }
  }
  const distinct = new Set(supplied.map(([, value]) => value))
  if (distinct.size > 1) {
    return {
      ok: false,
      message: `session aliases must match when supplied together: ${supplied.map(([name]) => name).join(', ')}`,
    }
  }
  return { ok: true, value: supplied[0]?.[1] }
}

export function resolveRunId(bodyValue: string | undefined, headerValue: string | undefined): ParsedHeader<string> {
  if (bodyValue !== undefined && headerValue !== undefined && bodyValue !== headerValue) {
    return { ok: false, message: 'run_id and X-Run-Id must match when both are provided' }
  }
  const candidate = bodyValue ?? headerValue ?? crypto.randomUUID()
  const parsed = durableRunIdSchema.safeParse(candidate)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid run id' }
  }
  return { ok: true, value: parsed.data }
}

export function resolveLastEventId(
  standardValue: string | undefined,
  aliasValue: string | undefined,
): ParsedHeader<number> {
  const parse = (value: string | undefined): ParsedHeader<number | undefined> => {
    if (value === undefined) return { ok: true, value: undefined }
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      return { ok: false, message: 'Last-Event-ID must be a non-negative base-10 integer' }
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, message: 'Last-Event-ID exceeds the safe integer range' }
    }
    return { ok: true, value: parsed }
  }
  const standard = parse(standardValue)
  if (!standard.ok) return standard
  const alias = parse(aliasValue)
  if (!alias.ok) return alias
  if (standard.value !== undefined && alias.value !== undefined && standard.value !== alias.value) {
    return {
      ok: false,
      message: 'Last-Event-ID and X-Last-Event-Id must match when both are provided',
    }
  }
  return { ok: true, value: standard.value ?? alias.value ?? 0 }
}

/** Bind a run id to execution semantics, not response representation. `stream` and runtime-owned
 * materialization fields do not change the backend job and are deliberately excluded. */
export function durableRunRequestDigest(req: ChatRequest, backend: string): string {
  const {
    stream: _stream,
    jailSpec: _jailSpec,
    profile_materialization_receipt: _materialization,
    ...executionRequest
  } = req
  // The request originated as JSON, but object spreads can reintroduce
  // optional `undefined` properties. A JSON round trip restores exact wire
  // semantics before RFC 8785 canonicalization (undefined object fields are
  // absent; array values retain their JSON form).
  const normalized = JSON.parse(
    JSON.stringify({
      schema: 'cli-bridge.durable-run-request.v1',
      backend,
      request: executionRequest,
    }),
  ) as Parameters<typeof canonicalCandidateDigest>[0]
  return canonicalCandidateDigest(normalized)
}

export function invalidRequest(c: Context, message: string): Response {
  return c.json({ error: { message, type: 'invalid_request_error' } }, 400)
}

export function resolveSseHeartbeatMs(): number {
  const raw = Number(process.env.BRIDGE_SSE_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw >= 10 ? raw : DEFAULT_SSE_HEARTBEAT_MS
}

/**
 * Parse the `X-Mcp-Config` request header. Accepts the canonical
 * `{ mcpServers: { … } }` shape; invalid JSON is silently dropped
 * rather than 400-ing the whole request so callers can opportunistically
 * set the header without it becoming a brittle hard dep.
 */
export function parseMcpHeader(value: string | undefined): ChatRequest['mcp'] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ChatRequest['mcp']
  } catch {
    // ignore — malformed header is best-effort
  }
  return undefined
}

/**
 * Merge MCP inputs from the header and the body, with body winning on
 * per-server name collisions. Either side can be undefined.
 */
export function mergeMcpInputs(
  fromHeader: ChatRequest['mcp'] | undefined,
  fromBody: ChatRequest['mcp'] | undefined,
): ChatRequest['mcp'] | undefined {
  if (!fromHeader && !fromBody) return undefined
  const headerServers = (fromHeader?.mcpServers ?? {}) as Record<string, unknown>
  const bodyServers = (fromBody?.mcpServers ?? {}) as Record<string, unknown>
  const merged = { ...headerServers, ...bodyServers }
  if (Object.keys(merged).length === 0) return undefined
  return { mcpServers: merged } as ChatRequest['mcp']
}

export function normalizeResponseFormat(format: {
  type: 'text' | 'json_object' | 'json_schema'
}): ChatRequest['responseFormat'] {
  return format.type === 'json_schema' ? { type: 'json_object' } : { type: format.type }
}

export function shouldApplyHostAdmission(backendName: string, req: ChatRequest): boolean {
  if (req.execution?.kind === 'sandbox') return false
  return backendName !== 'sandbox' && backendName !== 'passthrough'
}

/**
 * Map a host harness name (the `Backend.name` field — `claude`,
 * `kimi-code`, `gemini`, `codex`, `opencode`, `amp`, `factory`, `forge`) to the
 * matching in-container backend type the sandbox SDK accepts. The two
 * sets are mostly 1:1; the only divergence today is `factory` (host)
 * vs `factory-droids` (sandbox), which mirrors the upstream package
 * naming conventions.
 *
 * Unknown harnesses fall through as-is — sandbox-api will 400 if it
 * doesn't recognise the type, which is the right loud failure.
 */
export function harnessToSandboxBackendType(harnessName: string): string {
  switch (harnessName) {
    case 'claude':
      return 'claude-code'
    case 'claudish':
      return 'claude-code'
    case 'factory':
      return 'factory-droids'
    default:
      return harnessName
  }
}
