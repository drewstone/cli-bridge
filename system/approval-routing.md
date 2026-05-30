# Approval Routing Rules — Persisted

Session-proof reference. Read before any variant production sprint.

## Per-client routing

| Client | Approver(s) | Route by | Constraints | Revisions likely? |
|---|---|---|---|---|
| SunwellCo | Mara (single) | Thu PM | None | Low — Mara is fast |
| Atlas Survey | CMO, then legal | Wed PM | Sequential: CMO must clear before legal starts. CMO revision resets legal clock. | High — two round-trips |
| Pelican Bay | Owner | Thu AM | Owner is slow. Route by lunch or clearance slips to Monday. | Moderate — but slow turnaround |
| ForgeFit | Founder | Thu before noon | Founder only reviews after 7pm PT. Submit before noon to hit evening window. | Low — single approver |
| NorthStar Auto | 4 dealership GMs | Wed noon | Each GM approves their geo variant. One slow GM blocks that location. | Moderate — 4 parallel reviews |
| Bramble & Oak | Solo founder/writer | Fri AM | Founder is the writer — treats feedback as collaboration, not sign-off. Build in one revision round. | High — opinionated reviser |
| Helix Bio | Legal (every line) | Wed PM | Every claim must cite CLAIM-ID from claims-substantiation.md. Legal initials every line. Revision requires re-initial. | Highest — per-line legal review |
| Tidepool | Clinical director | Fri midday | COPPA compliance check on every variant. | Moderate |

## Helix Bio claim-substantiation rule (load-bearing)

Source: clients/helix-bio/approval-policy.md

1. Every assertion in Helix Bio copy must map to a `[CLAIM-XX]` entry in `clients/helix-bio/claims-substantiation.md`.
2. No hedging substitutes for substantiation. "May help support" still needs a source.
3. Leave 15–20% copy slack for legal qualifications. Do not fill this space with marketing language.
4. Legal must initial every line before publish. After revision, re-initial all changed lines.

### Why this rule does NOT apply to SunwellCo

SunwellCo is a DTC supplement brand under FTC general advertising guidance. SunwellCo's own policy (clients/sunwellco/approval-policy.md) requires sourcing only for *specific, quantified efficacy claims* (e.g., "94% of customers noticed X in Y weeks"). Colloquial credibility signals like "it just works" or "actually works" are consumer idiom, not testable clinical claims. They assert no mechanism, no timeline, no population, no measurable endpoint.

**The test:** If the phrase can be rewritten as "in a 12-week study, 78% of participants showed improved [biomarker]" and still makes grammatical sense, it needs sourcing for both clients. If it can't, it's idiomatic and only needs sourcing for Helix Bio.

## Cross-client claim-sourcing matrix

| Client | Claim-sourcing policy | Qualifier requirement | Legal review |
|---|---|---|---|
| SunwellCo | Quantified/testable claims only | None | None |
| Atlas Survey | Metric citations where available | None beyond standard advertising law | CMO + legal (sequential) |
| Helix Bio | Every assertion, no exceptions | 15–20% copy slack for qualifiers | Legal initials every line |
| Tidepool | COPPA-governed; no outcome promises | Avoid "fix/cure/improve" language | Clinical director |
| NorthStar Auto | Verified stats only (service records, review counts, tenure) | None | GM sign-off |
| Pelican Bay | Experiential, not quantified | None | Owner |
| ForgeFit | Performance claims OK (gym culture expects them) | None | Founder |
| Bramble & Oak | No performance claims (lifestyle brand) | None | Founder |

## Contamination mitigations for approval routing

When routing variants for approval, check:

1. **Wrong approver for the client.** Each client has a named approver. Never route ForgeFit copy to Mara or SunwellCo copy to legal.
2. **Wrong timing window.** ForgeFit founder only reviews after 7pm PT. Do not mark ForgeFit as "pending review" before 7pm.
3. **Wrong sourcing standard applied.** Do not apply Helix Bio's claim-substantiation rule to SunwellCo copy. Do not apply SunwellCo's lenient standard to Helix Bio copy.
4. **Regulatory frame mismatch.** Tidepool variants must pass COPPA review. Helix Bio variants must pass legal substantiation. These are different reviews run by different people. Never conflate them.
