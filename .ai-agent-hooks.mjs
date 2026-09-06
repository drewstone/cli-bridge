// Keep Git hooks deterministic; invoke model review explicitly with `npm run review`.
export default {
  artifactsDir: ".git/ai-agent-hooks/runs",
  hooks: {
    "pre-commit": {
      checks: [
        { id: "merge-conflict-markers", builtin: "merge-conflict-markers", required: true },
        { id: "suspicious-secrets", builtin: "suspicious-secrets", required: true }
      ]
    },
    "pre-push": {
      checks: [
        { id: "merge-conflict-markers", builtin: "merge-conflict-markers", required: true },
        { id: "mergeable-with-base", builtin: "mergeable-with-base", required: true },
        { id: "suspicious-secrets", builtin: "suspicious-secrets", required: true },
        // The trace-contract conformance tests are the gate that the bridge's OTLP
        // output stays readable by @tangle-network/agent-trace-contract consumers.
        // They are cheap (~3 s), deterministic, and pass with no coding CLIs
        // installed, so they meet this file's bar for a push-path check — and they
        // gate pushes that bypass GitHub CI.
        {
          id: "trace-contract-tests",
          required: true,
          timeoutSec: 300,
          run: "pnpm vitest run tests/trace-emitter.test.ts"
        }
      ]
    },
    // No git event fires this name; it runs only via `npm run review`. It diffs the branch against
    // its upstream, the same range the pre-push gate used to review.
    review: {
      checks: [
        {
          id: "codex-review",
          group: "sequential",
          required: true,
          timeoutSec: 900,
          audit: {
            runner: "codex-review",
            // Inherit model and reasoning settings from the installed Codex configuration.
            failOnSeverities: ["high", "critical"],
            prompt:
              "Review this change. Focus on correctness, regressions, security issues, missing tests, and production-readiness gaps. Try to REFUTE the change's own claims rather than confirm them: check that each thing the commit message says it fixes is actually fixed on every path, not just the one path the author looked at. Return concise findings only. If there are no findings, say 'No findings'."
          }
        }
      ]
    }
  }
};
