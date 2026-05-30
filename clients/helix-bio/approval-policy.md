# Helix Bio — Approval Policy

**Status:** Load-bearing. Nothing ships without following this exactly.
**Channels:** LinkedIn
**Budget:** $7k/wk
**Deadline pressure:** Legal is the long pole. Route today (Wednesday) for Friday launch.

---

## The hard rule

**Every claim in every line of copy must cite a source from `clients/helix-bio/claims-substantiation.md` before the draft leaves this directory. Legal will not accept undocumented claims. Legal will not source them for you.**

If you cannot find the claim in `claims-substantiation.md`, you have two options:
1. Rewrite the line to remove or hedge the claim until it no longer requires substantiation
2. Add the source to `claims-substantiation.md` first, with full citation, before writing the claim

There is no option 3.

---

## What counts as a "claim"

Err on the side of treating everything as a claim. Specifically:

- Any statement about efficacy, mechanism, or outcome ("reduces," "improves," "supports," "associated with X% reduction")
- Any reference to study results, even hedged ("in a study of N patients…")
- Any implied comparison to competitors or standard of care
- Any statement about regulatory status ("FDA-cleared," "CE-marked," "IND filed")
- Any statement about safety profile
- Any superlative ("first," "only," "most," "leading")
- Any statement about a specific patient population

Hedged language ("may," "suggests," "associated with") does not remove the substantiation requirement — it reduces the strength of the claim but the underlying claim still needs a source.

---

## Claim citation format in copy drafts

Every draft line that contains a claim must be annotated with its substantiation ID inline:

```
[Line] Our phase 2 data suggests a 34% reduction in biomarker X at 12 weeks. [CLAIM-04]
```

Where `CLAIM-04` maps to an entry in `clients/helix-bio/claims-substantiation.md`.

Legal reviews the claim against its substantiation entry. If the claim goes beyond what the source supports, legal will strike or modify the line.

---

## Submission format for legal

Submit each variant as a line-numbered block with initial fields:

```
Variant A — LinkedIn Ad — Helix Bio
Submitted: [date]
Claim sources: [list all CLAIM-IDs cited]

[L1]  [copy text]                          [legal initial: ___]
[L2]  [copy text]                          [legal initial: ___]
[L3]  [copy text]                          [legal initial: ___]
[CTA] [copy text]                          [legal initial: ___]

Flagged lines for legal attention:
- L2: cites CLAIM-07 (phase 1 data only, sample n=18 — hedge may need strengthening)
```

If legal modifies a line, record:
```
[L2] ORIGINAL: "…"
[L2] REVISED:  "…"
[L2] Legal initial on revised: ___
```

---

## Approval chain

1. **Creative draft** — every claim annotated with CLAIM-ID from `claims-substantiation.md`
2. **Internal review** — agency creative director checks voice, format, CLAIM-ID coverage
3. **Legal submission** — formatted per above; route **EOD Wednesday**
4. **Legal returns** — expect Thursday (1–2 business days); all lines initialed or modified
5. **Revision pass** — incorporate legal changes; re-submit any modified lines for re-initial
6. **Final approver** — legal-cleared version goes to CMO/equivalent for strategy review
7. **Launch authorization** — written approval from both legal and CMO before any spend activates

**Do not compress steps 4–7 into one round. Legal initials and CMO approval are separate sign-offs.**

---

## What blocks launch

Missing any of the following = hard block, no exceptions:

- [ ] Every claim in every variant cites a `claims-substantiation.md` entry
- [ ] Legal has initialed every line in the submitted format (including CTA)
- [ ] Legal-modified lines have been re-initialed on the revised version
- [ ] CMO (or designated final approver) has given written approval on the legal-cleared version
- [ ] No banned phrases present (see `voice.md` → Banned phrases)
- [ ] No wellness register contamination (see `voice.md` → Contamination guards)

---

## Escalation

If legal has not responded by noon Thursday: escalate directly to the legal team lead, not through the client contact chain. Friday launch is not recoverable if legal slips past 5pm Thursday.

If a claim cannot be substantiated and removing it breaks the variant's argument: flag to agency CD and client immediately. Do not publish a substantiation-stripped variant without client awareness.

---

## Prohibited without legal clearance

- Launching any variant, including "soft" A/B tests
- Increasing budget on a running ad that has new copy
- Repurposing Helix Bio copy for any other client (brand contamination + substantiation mismatch)
- Adding or changing any claim after legal has initialed — this resets the review
