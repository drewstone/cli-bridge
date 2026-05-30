# E2E Fintech Unified Creative Style Guide — LIAC Grammar v1.0

**Status:** Active — single source of truth for all paid-ad variants
**Effective:** 2025-05-14
**Review cadence:** Quarterly (next: 2025-08-14)
**Owners:** Performance creative lead (final call on grammar interpretation), Compliance (final call on factual substantiation)

---

## Section 1: Copy Architecture

Every ad has five components. All five must pass review before a variant goes live.

### 1. Interrupt (first 3–5 words)

Must be a specific, verifiable data point or behavioral claim. Not a command, not a question, not an adjective.

| Pass | Fail | Why fail |
|---|---|---|
| "87% of E2E applicants apply at…" | "You won't believe…" | No substantiation possible |
| "The 45-day window most people…" | "Banks hate this trick" | Implied adversarial intent |
| "Your utilization ratio resets…" | "Secret credit hack" | "Secret/hack" FTC flag |
| "Most applicants miss the…" | "Stop overpaying for…" | Unsubstantiated financial claim |
| "In our review of 50,000 applications…" | "Most borrowers…" | General population claim without scope |

Rule: If the interrupt cannot be linked to a substantiation document in under 60 seconds, it doesn't ship.

### 2. Curiosity Bridge (next 8–12 words)

Extends the interrupt into a specific mechanism or outcome. Must name the thing the consumer would learn or do.

| Pass | Fail | Why fail |
|---|---|---|
| "…the optimal window for rate-lock timing" | "…something that changes everything" | Manufactured gap, no substance |
| "…why utilization timing matters more than total balance" | "…the one thing standing between you and better credit" | Vague, unsubstantiated |
| "…how scoring models actually weight recent inquiries" | "…what they don't want you to know" | Conspiracy framing |

Rule: The bridge must be a complete factual clause that would survive a fact-check. If you wouldn't say it in a compliance review, don't write it.

### 3. Substantiated Urgency (0 or 1 per ad)

Urgency is not mandatory. It is permitted only when a real, time-bound condition exists.

**Allowed urgency sources:**
- Rate-lock expiration windows tied to the consumer's actual application state
- Application cycle deadlines (hard dates, e.g., "applications close [date]")
- Scoring model update cycles tied to the consumer's actual bureau refresh schedule
- Regulatory or policy changes with confirmed effective dates

**Not allowed:**
- "Limited time" without specifying what time
- "Act now" without a reason
- "Before it's too late" (too late for what?)
- Countdown timers that don't map to a real deadline
- Any scarcity language that cannot be independently verified
- General condition statements used as urgency ("rate locks average 45 days" — always true, therefore not conditional)

**Frequency cap:** Urgency language referencing rate-lock windows, scoring cycles, or other recurring conditions may not appear in more than 50% of live variants in any 7-day period. If every ad creates time pressure, the pressure is structural, not conditional.

**Recency gate:** Urgency claims must reference the consumer's actual situation where possible, not just a general condition. "Your rate lock expires in [X] days" (personalized) passes. "Rate locks average 45 days" is an educational fact, not urgency — do not frame it as urgency.

Format: `[time-bound condition specific to consumer] + [specific consequence of waiting]`

| Pass | Fail |
|---|---|
| "Rate locks average 45 days — applying before your refresh cycle maximizes your window" | "Apply now before rates change" |
| "Bureau reports refresh every 30–45 days — timing your application matters" | "Don't wait — limited availability" |

### 4. Proof Anchor (1 per ad)

One sentence that grounds the claim in a source. Must describe methodology honestly.

Formats:
- "Based on internal review of [N] E2E applications from [date range]"
- "Average [metric] among [specific population], [source] [year]"
- "[X] of [Y] E2E customers saw outcomes between [low] and [high] over [period]"
- "Per [third-party source], [claim], [date]"

Rule: Proof anchors must reference a real, dated source. Internal data must specify scope honestly — "internal review" not "analysis" (unless actual statistical analysis was performed). Third-party data must be from the last 24 months. Claims scoped to E2E data must say so explicitly; do not generalize to all borrowers.

### 5. Call to Action

Maximum 6 words. No imperative urgency ("hurry," "don't wait," "act fast"). Functional language only. No unsubstantiated time claims.

| Pass | Fail |
|---|---|
| "Check your rate" | "Check your rate in 2 minutes" (unless median time verified) |
| "See your pre-qualified offer" | "Lock your rate before it's gone" |
| "Start your application" | "Claim your spot now" |

---

## Section 2: Approved Headlines (10, FTC-stress-tested)

All headlines below pass all six LIAC rules and incorporate FTC audit fixes.

**HL-01** — "In our review of 50,000 applications, 87% were filed outside the optimal timing window"
- FTC fix applied: Scoped to E2E data, not generalized to "all borrowers"
- Body copy must include: outcome range with confidence interval per Rule 6
- Substantiation: E2E application-timing data, [date range]

**HL-02** — "Your credit score doesn't weight total debt the way most people think — here's what it measures"
- No change from v1 — already FTC-safe (CFPB/FICO public documentation)
- Substantiation: FICO scoring factor documentation, CFPB consumer guides

**HL-03** — "Among E2E applicants, those who applied within 12 days of rate-lock awareness saw better terms"
- FTC fix applied: Scoped to E2E population, no general-population claim
- Body copy must include: outcome range per Rule 6
- Substantiation: E2E internal funnel data, [date range]

**HL-04** — "The inquiry-clustering window most bureaus use — most people don't know it exists"
- FTC fix applied: Removed specific "14-day" duration (varies by model: 14–45 days). Model-specific detail in body copy.
- Substantiation: FICO Score 8 documentation, VantageScore methodology

**HL-05** — "Closing a paid-off card can lower your score — here's the mechanism"
- FTC fix applied: "Paying down debt" conflated with "closing accounts." Rewritten to specify the actual behavior.
- Substantiation: FICO utilization ratio documentation

**HL-06** — "Lenders see a different score than you do — among E2E applicants, the gap averaged 23 points"
- FTC fix applied: Scoped to E2E applicant data
- Substantiation: E2E internal data comparing consumer-pulled vs. lender-pulled scores, [date range]

**HL-07** — "Among E2E borrowers on 5-year terms, timing accounted for a $200–$1,840 rate differential"
- FTC fix applied: Scoped to E2E population, changed to range (not cherry-picked high end), added "on 5-year terms" qualification
- Body copy must include: methodology, distribution, and "individual results vary"
- Substantiation: E2E rate differential analysis, [date range]

**HL-08** — "Your utilization ratio resets every statement cycle — most people check after the reset, not before"
- No change from v1 — already FTC-safe (standard banking operations)
- Substantiation: Credit bureau reporting cycle documentation

**HL-09** — "Pre-qualification doesn't affect your score — 61% of eligible E2E applicants skipped it last quarter"
- FTC fix applied: Scoped to E2E applicants, time-bounded ("last quarter")
- Substantiation: E2E funnel data, [quarter]

**HL-10** — "The median approved E2E application was filed 12 days after rate-lock awareness — most waited longer"
- FTC fix applied: Scoped to E2E applications
- Substantiation: E2E internal data, [date range]

---

## Section 3: Performance Projections

| Dimension | Priya baseline | Jake baseline | LIAC projected | Rationale |
|---|---|---|---|---|
| Headline CTR | 1.2% | 4.1% | 2.8–3.4% | Data interrupts close 60–75% of Jake's gap without dark-pattern exposure |
| Click-to-application | High | Low (curiosity-mismatch) | High | LIAC clicks are qualified — ad states the mechanism upfront |
| Application completion | Baseline | Below baseline | ≥ Baseline | Substantiated trust signals reduce drop-off at compliance steps |
| FTC audit exposure | Near zero | High | Near zero | Every claim scoped, substantiated, no dark-pattern triggers |
| Effective CPA | Baseline | Outwardly low, higher after downstream leak | 20–35% below both | Higher completion × lower regulatory risk × competitive CTR |

---

## Section 4: Review and Approval Protocol

### Variant creation (Jake's team)
1. Write variant using LIAC grammar (all 6 rules)
2. Log substantiation source in shared tracker (claim → source → date verified → expiry date)
3. Submit to review queue

### Brand review (Priya's team)
1. Verify each claim against substantiation source
2. Check LIAC rule compliance (all 6 components)
3. Flag or approve within 24-hour SLA (business days)
4. Flagged variants auto-expire if not resolved within 48 hours

### Weekend / off-hours coverage
Pre-approved variant pool: Jake's team may use pre-cleared templates where only substantiated numbers are swapped (no new claims) without full review. New claims or structural changes require full review. Pre-approved templates are logged in `system/pre-approved-variant-templates.md`.

### Weekly sync
- Review CTR and completion data for all cells
- Kill variants at 30% under test-cell CTR median
- Promote top 2 variants to increased budget allocation
- Log all decisions for audit trail
- Verify urgency frequency cap (≤50% of live variants with urgency language in trailing 7 days)

### Dispute resolution
- Jake's team submits written justification citing specific LIAC rule and substantiation
- Priya's team cites specific rule violated
- Creative lead has final call on grammar interpretation
- Compliance has final call on factual substantiation
- CEO escalation only if 4-week test fails to produce clear winner

---

## Section 5: Geographic and Demographic Qualification

Claims must be valid for the targeting parameters of the ad set. If a claim is substantiated nationally but the ad targets a specific state where it doesn't hold, either re-substantiate for that geography or exclude the claim from that ad set.

---

## Section 6: Testimonial and Endorsement Policy

No testimonial-adjacent language ("most borrowers who switched…") without FTC-compliant disclosure of material connection (they are E2E customers). If testimonials are introduced in future variants, add: "E2E customer. compensated / not compensated. Results not typical." per 16 CFR Part 255.

---

## Change log

| Date | Version | Change |
|---|---|---|
| 2025-05-14 | 1.0 | Initial guide with all FTC stress-test fixes applied (C1–C3, H1–H3, M1–M3) |
