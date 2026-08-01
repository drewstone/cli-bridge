// Git hooks run on EVERY commit and push, so only cheap, deterministic checks belong in them.
// A model-backed review is neither: it costs real tokens per push and its availability depends on
// a vendor. As a required pre-push gate it billed a full review for every typo commit, and when
// Codex credits ran out it blocked every push in the repo for four days while never once reading
// the diff — an outage that presented as a rejection.
//
// So the review moved OUT of the push path and is now invoked deliberately: `npm run review`.
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
            // Tracks ~/.codex/config.toml rather than pinning: the old gate sat on gpt-5.4/high
            // for ten weeks while the configured default moved to gpt-5.6-sol/xhigh.
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
            failOnSeverities: ["high", "critical"],
            prompt:
              "Review this change. Focus on correctness, regressions, security issues, missing tests, and production-readiness gaps. Try to REFUTE the change's own claims rather than confirm them: check that each thing the commit message says it fixes is actually fixed on every path, not just the one path the author looked at. Return concise findings only. If there are no findings, say 'No findings'."
          }
        }
      ]
    }
  }
};
