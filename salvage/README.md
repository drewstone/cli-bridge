# Salvaged work: pluggable MCP mount strategies

`pluggable-mcp-mount.patch` is `git format-patch` output of commit `739fa6f` on
`feat/pluggable-mcp-mount` (uncommitted on 2026-07-06, committed during the
2026-09-22 salvage after the host outage).

It adds `src/backends/mcp-mount.ts`: one registered mount strategy per CLI (opencode
config layer, kimi flag, pi adapter file) owning env, argv, cleanup, and the fail-loud
decision when a CLI cannot serve the requested servers, plus `tests/mcp-mount.test.ts`,
and rewires kimi, opencode, pi, and profile-support through it.

It does not apply to current `main`: every touched backend was rewritten after July
(profile materialization receipts, attachments, router launches). Reuse the design, not
the diff.

Apply with `git am salvage/pluggable-mcp-mount.patch` on the commit it was written
against (`8ee2517`).
