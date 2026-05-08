# cli-bridge

OpenAI-compatible HTTP proxy for local CLI harnesses (claude-code, opencode,
kimi-code, codex, amp, factory, forge, claudish, …) backed by your
subscription. Translates `POST /v1/chat/completions` → spawn the right CLI
in `--print` mode, parse its stream, return OpenAI-shaped deltas.

- `BRIDGE_BACKENDS` env picks which backends are active per-host.
- Auth via static bearer (`BRIDGE_BEARER`) — required.
- Sessions resumable via `X-Session-Id` header / `session_id` body field.

## Commit hygiene

- **Never add `Co-Authored-By: Claude …` trailers to commits.** Drew authors
  every commit himself; AI assistance is implicit and not credited.
- Subjects: imperative, lowercase, conventional-commit style.
- Push feature branches; never push directly to `main`.
