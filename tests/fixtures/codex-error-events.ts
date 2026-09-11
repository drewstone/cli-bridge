/**
 * Codex failure payloads, recorded from real runs on this machine.
 *
 * PROVENANCE. Every `message` / `codex_error_info` pair below is copied verbatim
 * from `~/.codex/sessions`. Counting rule, so the denominator is reproducible:
 * one refusal is one JSON object inside a rollout line that carries both a
 * `message` string and a `codex_error_info` field — the shape codex stores as a
 * turn record's `error`, and the same pair `codex exec --json` prints on stdout
 * under a `type: "error"` event tag, which is what the backend reads. On
 * 2026-09-10 that rule gives 517 rollout files and 983 refusals in five
 * discriminants: `server_overloaded` 410, `response_too_many_failed_attempts`
 * 309, `other` 164, `usage_limit_exceeded` 92, `unauthorized` 8.
 *
 * Two measured facts shape the parser, and each is pinned by a fixture here:
 * serde writes a unit variant as a bare string and a variant carrying data as a
 * single-key object whose fields sit under that key; and `other` is codex
 * declining to classify, not an absence of information — all 20 recorded
 * `invalid_request_error` refusals arrive under it.
 *
 * Every refusal in the 983 sets `codex_error_info`; none is missing it. The
 * constructed fixture at the bottom is the only payload here that is not a
 * recording, and it says so.
 */

/** Capacity refusal, 410 of the 983 — the most common one recorded. */
export const CODEX_CAPACITY_EVENT = {
  type: 'error',
  message: 'Selected model is at capacity. Please try a different model.',
  codex_error_info: 'server_overloaded',
}

/**
 * Rate-limit refusal, 309 of the 983, and the reason the discriminant cannot be
 * read as `codex_error_info.type`: this variant carries data, so serde names it
 * with the key itself and puts its fields one level under that key. Every one of
 * the 309 carries `http_status_code: 429` there. Source:
 * 2026/09/04/rollout-2026-09-04T20-13-41-01a06f8e-bfd5-7501-9332-5d22daf4e394.jsonl.
 */
export const CODEX_RATE_LIMIT_EVENT = {
  type: 'error',
  message: 'exceeded retry limit, last status: 429 Too Many Requests, request id: 417f664c-7c66-4c58-b36c-992667687a41',
  codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
}

/**
 * The account's allowance is spent, 92 of the 983. Codex states the reset in
 * prose here, not as a field: no refusal among the 983 carries a
 * machine-readable reset instant anywhere in its payload. Source:
 * 2026/07/29/rollout-2026-07-29T13-46-54-019fafa1-5918-77a0-871a-c70c8856f643.jsonl.
 */
export const CODEX_USAGE_LIMIT_EVENT = {
  type: 'error',
  message:
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"
    + ' or try again at Aug 8th, 2026 2:35 PM.',
  codex_error_info: 'usage_limit_exceeded',
}

/**
 * Malformed request, 18 of the 983: the whole message IS the provider's body,
 * and codex classified it `other`. Source: 2026/09/04/rollout-2026-09-04T18-21-24
 * -01a06f27-f489-7be2-92ec-ee5fbd381355.jsonl.
 */
export const CODEX_BAD_REQUEST_EVENT = {
  type: 'error',
  message: `{
  "error": {
    "message": "Invalid value: 'zzprobe'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
    "type": "invalid_request_error",
    "param": "reasoning.effort",
    "code": "invalid_value"
  }
}`,
  codex_error_info: 'other',
}

/**
 * The same class through a body that wraps itself, 2 of the 983, and the only
 * recorded refusals that state a status as a field. The status sits on the
 * WRAPPER beside `error`, not inside it. Source: 2026/09/10/rollout-2026-09-10
 * T01-23-31-01a08a6a-3465-7cf1-b333-19062ee7d12b.jsonl.
 */
export const CODEX_BAD_REQUEST_NESTED_EVENT = {
  type: 'error',
  message: `{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_value",
    "message": "Unsupported value: 'max' is not supported with the 'gpt-5.5' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.",
    "param": "reasoning.effort"
  },
  "status": 400
}`,
  codex_error_info: 'other',
}

/** Expired credentials, 8 of the 983. */
export const CODEX_UNAUTHORIZED_EVENT = {
  type: 'error',
  message:
    'Your access token could not be refreshed because you have since logged out or signed in to another'
    + ' account. Please sign in again.',
  codex_error_info: 'unauthorized',
}

/**
 * A gateway fault, 139 of the 983: codex says `other`, and the object quoted in
 * the message is a `detail` envelope that names no error class, so there is
 * nothing to relay but codex's own word for it. Source:
 * 2026/07/29/rollout-2026-07-29T13-46-54-019fafa1-5918-77a0-871a-c70c8856f643.jsonl.
 */
export const CODEX_GATEWAY_EVENT = {
  type: 'error',
  message:
    'unexpected status 502 Bad Gateway: {"detail":{"error":"Upstream model provider request failed"}}'
    + ', url: http://127.0.0.1:17322/v1/responses',
  codex_error_info: 'other',
}

/**
 * A transport fault codex reports as prose only, 5 of the 983. It still sets the
 * discriminant — `other`, like every unclassified refusal in the recordings.
 * Source: 2026/07/29/rollout-2026-07-29T13-46-54-019fafa1-5918-77a0-871a
 * -c70c8856f643.jsonl.
 */
export const CODEX_STREAM_DISCONNECT_EVENT = {
  type: 'error',
  message: 'stream disconnected before completion: error sending request for url (http://127.0.0.1:17322/v1/responses)',
  codex_error_info: 'other',
}

/**
 * CONSTRUCTED, not recorded — the one payload here that is.
 *
 * No refusal among the 983 omits `codex_error_info`, so the fallback for a
 * failure that names no code at all has no recording to copy. It guards a codex
 * older or newer than the 0.153.4 these rollouts came from, and the bridge must
 * not invent a code for one.
 */
export const CODEX_UNCLASSIFIED_EVENT = {
  type: 'error',
  message: 'codex exec failed before it reported a class',
}
