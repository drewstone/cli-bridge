/**
 * Codex failure payloads, recorded from real runs on this machine.
 *
 * PROVENANCE. Every `message` / `codex_error_info` pair below is copied
 * verbatim from `~/.codex/sessions`: 514 rollout files scanned on 2026-09-10,
 * 1092 recorded refusals, 8 distinct shapes. The `type: 'error'` key is the
 * stdout event tag `codex exec --json` puts around the same pair, which is what
 * the backend reads; the rollout stores it as a turn record's `error` object.
 * Counts and source files are on each fixture.
 *
 * The two serialized forms of `CodexErrorInfo` both occur, and the difference
 * matters: serde writes a unit variant as a bare string and a variant carrying
 * data as a single-key object. Only the constructed reset fixture at the bottom
 * is not a recording, and it says so.
 */

/** Capacity refusal, 436 of the 1092 — the most common one recorded. */
export const CODEX_CAPACITY_EVENT = {
  type: 'error',
  message: 'Selected model is at capacity. Please try a different model.',
  codex_error_info: 'server_overloaded',
}

/**
 * Rate-limit refusal, 320 of the 1092, and the reason the discriminant cannot
 * be read as `codex_error_info.type`: this variant carries data, so serde names
 * it with the key itself. Source: 2026/09/03/rollout-2026-09-03T16-14-31
 * -01a0698d-6d22-74a1-b8e7-649ee39f249d.jsonl.
 */
export const CODEX_RATE_LIMIT_EVENT = {
  type: 'error',
  message: 'exceeded retry limit, last status: 429 Too Many Requests, request id: b76609ea-7d20-406e-a7ea-51abe3d97652',
  codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
}

/**
 * The account's allowance is spent, 127 of the 1092. Codex states the reset in
 * prose here, not as a field — no recorded refusal carries a machine-readable
 * reset instant. Source: 2026/07/01/rollout-2026-07-01T19-52-50
 * -019f2019-8145-7890-ac60-3edbc2525fa0.jsonl.
 */
export const CODEX_USAGE_LIMIT_EVENT = {
  type: 'error',
  message:
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"
    + ' or try again at Aug 4th, 2026 11:46 PM.',
  codex_error_info: 'usage_limit_exceeded',
}

/**
 * Malformed request, 18 of the 1092: the whole message IS the provider's body,
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
 * The same class through a body that wraps itself in its own `type`, 2 of the
 * 1092. Source: 2026/09/10/rollout-2026-09-10T01-23-31
 * -01a08a6a-3465-7cf1-b333-19062ee7d12b.jsonl.
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

/** Expired credentials, 9 of the 1092. */
export const CODEX_UNAUTHORIZED_EVENT = {
  type: 'error',
  message:
    'Your access token could not be refreshed because you have since logged out or signed in to another'
    + ' account. Please sign in again.',
  codex_error_info: 'unauthorized',
}

/**
 * A gateway fault, 175 of the 1092: codex says `other` and the quoted body
 * names no code either, so there is nothing to relay but the words.
 */
export const CODEX_GATEWAY_EVENT = {
  type: 'error',
  message:
    'unexpected status 502 Bad Gateway: {"detail":{"error":"Upstream model provider request failed"}}'
    + ', url: http://127.0.0.1:17322/v1/responses',
  codex_error_info: 'other',
}

/** A transport fault codex reports as prose only, 5 of the 1092. */
export const CODEX_UNCLASSIFIED_EVENT = {
  type: 'error',
  message: 'stream disconnected before completion: error sending request for url (http://127.0.0.1:17322/v1/responses)',
}

/** Epoch seconds, the unit codex uses for a reset wherever it reports one. */
export const RESETS_AT_EPOCH_SECONDS = 1789230014

/**
 * CONSTRUCTED, not recorded — the one fixture here that is.
 *
 * No refusal among the 1092 carries a machine-readable reset instant, so the
 * `resets_at` path has no recording to copy. The shape is codex's own
 * `UsageErrorBody{type, plan_type, resets_at}` inside `UsageErrorResponse`,
 * which codex-cli 0.153.4 parses out of a provider 429, and the epoch value is
 * real: read from a `rate_limits.primary.resets_at` field in
 * 2026/09/03/rollout-2026-09-03T16-14-31-01a0698d-6d22-74a1-b8e7-649ee39f249d.jsonl.
 */
export const CODEX_PROVIDER_RESET_EVENT = {
  type: 'error',
  message:
    'stream error: unexpected status 429, url: https://chatgpt.com/backend-api/codex/responses: '
    + `{"error":{"type":"usage_limit_reached","plan_type":"pro","resets_at":${RESETS_AT_EPOCH_SECONDS}}}`,
}
