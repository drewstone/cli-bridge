# Default AgentProfile catalog

This directory ships with cli-bridge and is the default source for
`SANDBOX_PROFILES_DIR` (see `src/config.ts`). Each `*.json` file here is
loaded at server start by `createProfileCatalog` and exposed via:

- `GET /v1/profiles` — list
- `GET /v1/profiles/:id` — single profile body
- `POST /v1/chat/completions` with `model: "sandbox/<id>"` — route a
  chat through the `sandbox` backend using this profile

The profile `id` is the filename without the `.json` extension — e.g.
`vb-reviewer.json` becomes id `vb-reviewer`, addressable as
`sandbox/vb-reviewer`.

## Schema

Profiles conform to `AgentProfile` from `@tangle-network/sandbox`. The
`version` field is a free-form string (semver is the convention) used
to track prompt/behavior revisions independent of the cli-bridge
release; bump it whenever the `systemPrompt` or `instructions` change.

## Shipped profiles

| id | purpose |
|---|---|
| `vb-reviewer` | VerticalBench shot reviewer — a resumable sonnet-4-6 agent with read-only permissions that watches a coding agent across N shots and emits the next-shot instruction. DSPy-RLM optimizes this profile's `prompt.systemPrompt` / `prompt.instructions`; model + tools + resources stay fixed so the gradient signal is isolated to reasoning policy. |

## Adding a profile

1. Drop a `<id>.json` file in this directory. The content must parse as
   an `AgentProfile`.
2. Restart cli-bridge (or call the loader's `reload()` — no HTTP
   trigger yet).
3. `curl http://127.0.0.1:3344/v1/profiles` should list the new id.

Malformed JSON is skipped with a warning on stdout — the server will
not refuse to start because one profile is broken.
