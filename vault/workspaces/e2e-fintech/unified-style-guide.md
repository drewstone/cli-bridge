# Unified Creative Style Guide — v1.1 LOCKED
**Status**: LOCKED — single source of truth for all E2E Fintech paid creative
**Effective**: 2026-05-17
**Scope**: All paid creative (Meta primary; Google, lifecycle, OOH require channel-native specs built from this grammar after Meta validates)
**Vault path**: `vault/workspaces/e2e-fintech/unified-style-guide.md`
**Authority**: FTC Act §5 (UDAP), 16 CFR Part 255 (Endorsement Guides, 2023), FTC 2024 dark-pattern enforcement memo, Reg Z §1026.24, CFPA §1031 (CFPB)

> This document is not a brand-vs-performance compromise. It is the document that makes both approaches defensible in front of an FTC examiner and a CFPB supervisory review. Neither faction's preferences override its floors. No creative argument overrides §1.

---

## §1 Hard floor — auto-reject, no creative argument accepted

Six patterns. Trip one, the asset dies. No "but it's performing" override. Applies to FTC Act §5 and CFPA §1031 simultaneously — both regulators have independent enforcement authority over consumer fintech.

1. **False urgency** — "act now", "offer ends tonight", countdown timers with no real expiration, dated urgency where the date is not material and adverse to the consumer's decision
2. **Hidden disclosure** — any material disclosure that fails the FTC clear-and-conspicuous four-factor test: (a) proximate to the claim, not separated by other content; (b) in the same medium as the claim — a landing-page disclosure does not cure an ad-unit claim; (c) not contradicted by other ad content; (d) unavoidable before the consumer takes action. Footnote size and scroll depth are symptoms, not the definition.
3. **Manipulative scarcity** — "only 50 spots left" with no verifiable, real cap
4. **Secret/hack framing** — "hack", "banks don't want you to know", "secret method", "they don't want you to see this", "loophole"
5. **Fake testimonials** — composite, AI-generated, incentivized, or unverified reviews presented as organic. Separately prohibited: review gating — soliciting reviews only from satisfied customers and suppressing negative ones is a standalone FTC violation under the 2024 Endorsement Guide updates regardless of whether every published review is authentic.
6. **Undisclosed material connection** — paid placement presented as editorial or organic

Source: FTC 2024 dark-pattern enforcement memo; 16 CFR Part 255 (2023 update). Fintech is enforcement priority #1 for both FTC and CFPB.

**Net-impression gate (applies to every variant before activation)**: Does the ad, read as a whole by a reasonable member of the served audience, create a false belief — even if every individual claim is technically accurate? If yes, the variant is §1 regardless of claim-level accuracy. A technically accurate rate floor served broadly to an audience that cannot qualify for it fails this test.

**Reviewer rule**: If you are debating whether something is a §1 violation, it is. The floor is not a case-by-case judgment.

---

## §2 Sentence-level grammar — applies to every channel, every format

From `system/brand-voice.md` — elevated to structural rules, not brand preferences.

- **Length**: Headlines ≤14 words. Every body sentence ≤14 words.
- **Tone**: Declarative. No hyperbole. No adjectives that don't carry information ("better", "smarter", "easier").
- **Punctuation**: No exclamation points. No ellipsis as a cliffhanger.
- **Urgency**: Forbidden unless (a) named and real, (b) the date is material and potentially adverse to the consumer's decision, and (c) the consumer's decision window is accurately represented. "Rates adjust on [specific date]. What to do before then." requires that "before then" is a meaningful consumer decision window, not a routine operational event. See §3 urgency frequency cap.
- **Second person**: "You" allowed in headline. Not in second sentence of any body copy block.
- **Credit-impact claims**: Any claim about credit score improvement, credit building, or credit impact requires a substantiation ticket filed before the variant goes live. Not after. Not "we'll file if it performs."

**Why these are structural, not aesthetic**: Every rule in §2 maps to a fintech FTC or CFPB enforcement case. "Calm and clear" is the copy register that survives a net-impression test and a supervisory examination.

---

## §3 Performance mechanics — preserved and scoped

| Mechanic | Status | Constraint |
|---|---|---|
| Curiosity gap in headline | **Allowed** | Gap must resolve to a real, substantiated claim in body copy or landing page. Gap that resolves to nothing = deceptive framing. |
| Pattern interrupt (first 3 words) | **Allowed** | Structural disruption, not sensationalism. The interrupt must be factual. |
| Urgency in body | **Allowed** | Must be named, dated, material, and adverse. Real expiration only. **Frequency cap: urgency language may appear in ≤50% of live variants in any 7-day period.** A portfolio where every variant uses urgency is a pattern an examiner characterizes as systematically manipulative regardless of individual claim accuracy. |
| 12 variants/week | **Preserved** | Unchanged |
| Kill at 30% under CTR median / 7 days / 1,000 impressions | **Preserved** | Unchanged |
| "Hack/secret/banks don't want" framing | **§1 kill** | 4.1% CTR does not survive an FTC examiner reading the ad and the landing page side-by-side |

---

## §4 Claim tiers — required before any variant activates

**Before running any tier**: Apply the §1 net-impression gate. A Tier 1 claim that creates a false net impression is §1, not Tier 1.

Every activated variant links to a substantiation log entry filed before activation. Template: `system/substantiation-log-template.md`. Entries expire after 12 months; variants using expired substantiation are suspended until renewed.

---

**Tier 1 — Activate immediately (after §1 net-impression check)**

Verified factual claim. No superlatives. No urgency language. No comparison.

- Fee stated as a dollar amount
- Approval timeline stated as observed median (not "guaranteed")
- Product mechanic stated as a standalone feature fact
- **APR is not Tier 1.** Any advertisement that states an APR triggers Reg Z §1026.24, which requires companion disclosure of: whether the rate is fixed or variable, applicable fees, the term "annual percentage rate," and for closed-end credit, additional payment terms. A standalone "APR from X%" in a paid social unit without a Reg Z-compliant companion disclosure is a violation regardless of accuracy. APR claims are Tier 2 minimum.

---

**Tier 2 — Activate after legal ticket (SLA: ≤24h receipt; if no response, variant auto-EXPIRES at 48h — it does not auto-activate)**

File the ticket **before** the variant goes live. Not after.

- APR claims (all, per Reg Z requirement above)
- Rate comparisons to named competitors or category averages
- Credit-impact claims ("can improve your credit score by X points")
- Any urgency with a named, real date (must also pass §2 urgency materiality test)
- Typical-results claims ("X% of applicants who [did Y] received [outcome]") — must include: (a) typical-results disclosure proximate to the headline **in the ad unit body copy, not landing page**; (b) the rate (not absolute count) of the cohort who achieved the stated outcome
- Testimonials — must be verified, unedited, real name or @handle with verification date; disclosure of atypical results must be in the ad body copy proximate to the testimonial, not on the landing page; no review-gating (see §1.5)
- Personalization-implication claims (e.g., "in your range", "for people like you") — legal ticket must include the Meta audience segment definition that matches the implied "range"; variant must be paused if Meta's optimization expands the audience beyond that definition
- Comparative approval-rate claims — legal ticket must include: (a) source and date for the comparison figure, (b) the segment definition applied identically to both the comparison population and your population, (c) confirmation that the populations are equivalent on credit band, loan amount, and income level

**Reg Z companion disclosure requirement**: Any Tier 2 variant containing an APR must complete the Reg Z trigger-term checklist (appendix A) before activation. The companion disclosure must appear in the same ad unit or be immediately adjacent — a landing-page disclosure does not suffice.

---

**Tier 3 — Never activate**

Anything in §1. No argument overrides this tier.

---

## §5 The curiosity-gap formula

Structural replacement for "hack" copy. Same three mechanisms Jake's top performers use — tension, implied insider access, curiosity gap — grounded in a real brand truth instead of a fabricated adversary.

```
[Pattern interrupt — factual, first 3 words]
+ [Named tension or gap]
+ [Specific claim or implied mechanic that resolves on click]
```

| Slot | What works | What doesn't |
|---|---|---|
| Pattern interrupt | A specific number. A named outcome. A direct contrast ("Not a bank."). | Vague superlatives. "Hack." Fabricated exclusivity. |
| Tension | The gap between where the reader is and a real outcome they want. The gap must be real and named. | Fabricated adversaries. False scarcity. Category-level FUD. |
| Specific claim | Real rate, real timeline, real user stat, real operational mechanic — Tier 1 or Tier 2 qualified. | Adjectives. Implied claims. Vague social proof ("thousands"). |

**What makes Jake's 4.1% work structurally — not via dark patterns:**
- Pattern interrupt (unexpected word + implied exclusive access)
- Tension (adversary + insider framing)
- Curiosity gap that resolves on click

Every one of these replicates with a real brand truth. The structural move is identical. The dark pattern is the fake adversary and fabricated exclusivity. Swap in a real operational fact — rate, approval mechanic, user behavior data — and the structure survives FTC and CFPB review.

**⚠ BLOCKING INPUT**: Brand truth slot is empty. Headlines 6–9 in §6 are structural shells. One specific, verifiable, competitor-exclusive fact is required before any of those variants activate.

---

## §6 Headline bank — Meta paid social

**Channel mechanics**: Frame 1 stops the scroll (sound-off). One claim per asset. Body ≤2 sentences, each ≤14 words. CTA is the next obvious step, not a pressure move.

**CTR projection methodology**: Structured curiosity-gap headlines with specific numbers outperform declarative benefit statements in fintech paid social by 1.5–2.2× on CTR (ConversionXL 2023, Hanapin 2022, fintech industry medians). Priya's current best: 1.2% CTR. Projections are ranges, not guarantees; they assume real data fills every bracket. **Primary KPI is CTR-to-application-completion, not CTR alone.** Pull the amplitude CTR→application-complete funnel for Jake's "hack" variants before disputing these projections.

---

### Tier 1 headlines — activate immediately after §1 net-impression check

**Headline 1: Timeline interrupt**
> `[N] minutes. That is how long an approval decision takes.`

- Pattern interrupt: specific number, period-ended
- Tension: implies the reader expects it to be slower
- Curiosity gap: "how long" implies a mechanism; body names it
- §1/§2: no urgency, no comparison, ≤14 words ✓
- **CTR projection vs Priya: 1.8–2.2×**
- Fill: real observed median approval time — not the best case, not "up to"

---

**Headline 2: Cohort specificity**
> `[N] people with a [X] score built [Y] points in [Z] months.`

- Pattern interrupt: three numbers
- Tension: implies a mechanism that works at a specific starting point
- Curiosity gap: "how" resolves in body copy
- §1/§2: typical-results framing → **Tier 2, legal ticket required**
- **Tier 2 requirement**: body copy must include the rate (not count) of people in the cohort who achieved this outcome, proximate to the headline in the ad unit
- **CTR projection vs Priya: 1.9–2.4×**
- Fill: amplitude cohort data; if no clean cohort exists, do not run

---

**Headline 3: Category contrast**
> `Not a credit card. Not a personal loan. [Product name] is different.`

- Pattern interrupt: "Not" — negation is factual and structural
- Tension: contrast vs. two categories the reader has mental models for
- Curiosity gap: "different" — **body copy must name the specific difference in sentence 1**
- §1/§2: no urgency, no comparison, ≤14 words ✓
- **CTR projection vs Priya: 1.7–2.1×**
- Fill: product name + the one real operational difference in body sentence 1

---

**Headline 4: Approval-factor flip**
> `One thing affects approval more than credit score. It is [specific factor].`

- Pattern interrupt: "One thing" + implied rank reversal
- Tension: challenges the assumption that credit score is the controlling variable
- Curiosity gap: resolves immediately — no deceptive withholding
- §1/§2: ≤14 words, no urgency ✓
- **Actionability gate**: the factor must be actionable by the consumer. If the factor is fixed (employment sector, credit history length), this headline implies that knowing it improves approval odds — which is deceptive under FTC §5 if it doesn't. Body copy must not imply the factor's presence guarantees approval.
- **CTR projection vs Priya: 2.0–2.5×**
- Fill: the real approval-weighting factor that differentiates from FICO-only underwriting; confirm it is actionable

---

**Headline 5: Rate specificity**
> `APR from [X]%. No intro rate. No rate change after 12 months.`

- Pattern interrupt: rate number first, then two negations of category-norm bait-and-switch
- Tension: the two negations name specific pain points the audience has experienced
- Curiosity gap: "what's the catch" — body answers it honestly
- §1/§2: **APR claim → Tier 2 minimum** (Reg Z §1026.24); complete Reg Z trigger-term checklist (appendix A) before activation; companion disclosure must be in the ad unit
- **CTR projection vs Priya: 1.7–2.0×**
- Fill: real APR floor; confirm rate is truly fixed for 12 months under all conditions — if the rate CAN change, this headline is misleading

---

### Tier 2 headlines — legal ticket filed and confirmed before activation (no auto-approve)

**Headline 6: Direct rate comparison**
> `[Bank name] charges [X]% for this. We charge [Y]%.`

- Pattern interrupt: competitor name (or "Most banks" if named competitor not approved)
- Tension: named rate differential
- Curiosity gap: "this" — body copy names the product/feature
- **Tier 2**: rate comparison; also requires Reg Z checklist for the stated APR
- **CTR projection vs Priya: 2.2–2.8×**
- Fill: competitor rate from a dated, publicly available source (not estimated); your rate as stated APR; differential must be material and current at activation

---

**Headline 7: Approval-rate data**
> `[X]% of applicants in your range were approved. Here is what they did.`

- Pattern interrupt: approval rate number + peer reference
- Tension: "in your range" implies personalization + access to outcome data
- Curiosity gap: "what they did" — resolves to one specific action in body
- **Tier 2**: typical-results claim (FTC §255.2); legal ticket must include the Meta audience segment definition that maps to "your range." If Meta's optimization expands the audience beyond that definition, pause the variant.
- **Personalization theater gate**: "in your range" is not a generic claim — the segment definition must be in the legal ticket. "Your range" must be scoped in body copy (e.g., "scores in the [X–Y] range").
- **CTR projection vs Priya: 2.0–2.5×**
- Fill: amplitude cohort data with segment definition; confirm Meta targeting matches segment

---

**Headline 8: Real urgency**
> `Rate adjusts on [real date]. What to do before then.`

- Pattern interrupt: named date
- Tension: implies a consequence the reader should care about
- Curiosity gap: "what to do" resolves to one action in body
- **Tier 2**: dated urgency; also §2 urgency materiality test: (a) the rate change must be material, (b) potentially adverse to the consumer, (c) the consumer has a real decision window before the date. If the rate change is routine, non-adverse, or the window is not actionable, this headline is §1 false urgency regardless of the date being real.
- **§1 kill if**: the date is rolling, fabricated, or the same consumer sees this ad past the stated date
- **CTR projection vs Priya: 2.3–2.9×**
- Fill: real rate-change date tied to a policy event; confirm adversity and consumer decision window

---

**Headline 9: Approval-rate contrast**
> `Traditional banks decline [X]% of applications like this. We approved [Y]%.`

- Pattern interrupt: decline rate — names the failure mode the reader has experienced
- Tension: contrast between category outcome and this product's outcome
- Curiosity gap: implies an underwriting difference; body names the one factor
- **Tier 2**: competitive comparative + typical-results; highest legal exposure in the bank
- **Population equivalence requirement**: legal ticket must include (a) source and date for the bank decline rate, (b) the segment definition applied identically to both populations — credit score range, loan amount, income level — (c) confirmation that the comparison populations are equivalent. If [X]% is from aggregate CFPB HMDA data and [Y]% is your self-selected applicant population, the comparison is apples-to-oranges and misleading.
- **CTR projection vs Priya: 2.4–3.0×**
- Fill: bank decline rate from CFPB HMDA or dated public source; your approval rate for the same equivalent segment

---

**Headline 10: Structural product claim**
> `This rate does not change based on your behavior. Most products do.`

- Pattern interrupt: "This rate does not change" — states a feature by naming the convention it breaks
- Tension: "most products do" names the pain without fabricating an adversary
- Curiosity gap: implies a product mechanic the reader needs to understand
- **Tier 2 if comparison is general ("most products"); Tier 1 only if stated as a standalone product fact without comparison**; body copy must name the mechanic
- **Accuracy gate**: if the rate CAN change under any conditions for any user, do not run this headline
- **CTR projection vs Priya: 1.8–2.2×**
- Fill: the real product mechanic; confirm with product team that the rate is unconditionally fixed

---

## §7 CTR projection summary vs Priya's 1.2% baseline

| Headline | Tier | Projected CTR | Lift vs Priya | Primary mechanism |
|---|---|---|---|---|
| 1 — Timeline interrupt | 1 | 2.2–2.6% | 1.8–2.2× | Number-led pattern interrupt |
| 2 — Cohort specificity | 2 | 2.3–2.9% | 1.9–2.4× | Three-number specificity + peer group |
| 3 — Category contrast | 1 | 2.0–2.5% | 1.7–2.1× | Negation structure + contrast |
| 4 — Approval-factor flip | 1 | 2.4–3.0% | 2.0–2.5× | Assumption reversal + immediate resolution |
| 5 — Rate specificity | 2 | 2.0–2.4% | 1.7–2.0× | Number-first + category norm negation |
| 6 — Direct rate comparison | 2 | 2.6–3.4% | 2.2–2.8× | Named competitor + material differential |
| 7 — Approval-rate data | 2 | 2.4–3.0% | 2.0–2.5× | Cohort data + peer reference |
| 8 — Real urgency | 2 | 2.8–3.5% | 2.3–2.9× | Named date + consequential action |
| 9 — Approval contrast | 2 | 2.9–3.6% | 2.4–3.0× | Decline rate contrast + underwriting claim |
| 10 — Structural product | 1/2 | 2.2–2.6% | 1.8–2.2× | Feature stated by naming convention broken |

**vs Jake's 4.1% CTR**: Headlines 8 and 9 approach it when activated with real data. The right comparison is CTR-to-application-completion, not CTR alone. Pull the amplitude funnel before this becomes a dispute.

---

## §8 Test protocol — 4-week validation

**Three-cell structure:**
- Control A: Jake's current top variant (4.1% CTR, unknown completion rate)
- Control B: Priya's current top brand-approved variant (1.2% CTR, known completion rate)
- Test: 3 unified-guide variants (§6 Tier 1 to start; Tier 2 only after legal tickets confirmed)

**Hypothesis**: Unified-guide variants match or exceed Control A on CTR-to-application-completion while holding CPA at or below Control B — because the curiosity-gap structure drives qualified click intent rather than loophole-seekers.

**Kill criterion**: Unified-guide variants 30% below Control A CTR-to-completion median at Day 14 / 2,000 impressions → kill, revert, reconvene.

**Consumer harm kill criterion**: If unified-guide variants generate dispute rate or CFPB complaint rate ≥2× Control B at Day 14, kill and escalate to legal before any variant is reactivated. A variant that converts well but generates disproportionate post-application disputes is a liability, not a win.

**Graduation criterion**: Unified-guide variants ≥15% above Control A CTR-to-completion at Day 28 / 5,000 impressions → scale to $5k/wk, lock guide as binding for all Meta creative.

**Primary KPI**: CTR-to-application-completion (amplitude funnel, CTR→application-complete step). Pull weekly. Not CTR alone.

**Compliance gate**: All Tier 2 variants require legal ticket filed and confirmed before activation. No exceptions for variants mid-test. No auto-approve on no-response — variants auto-expire at 48h if legal does not confirm.

**Post-mortem**: Written same day test concludes. Generalizable findings update this guide under a dated amendment. Situational wins logged as case-specific, not elevated to rules.

---

## §9 Banned words and devices

**Banned as load-bearing creative claims** (headlines, taglines, body copy, CTAs, asset descriptions):
elevate, elevated, premium, approachable, engaging, innovative, disruptive, revolutionize, passionate, seamless, effortless, simple, easy, better, smarter, next-level, world-class, best-in-class, hack, secret, banks don't want, they don't want you to know, this one trick, loophole.

**Banned devices:**
- "The [X] of [Y]" positioning
- Countdown timers with no real expiration
- Testimonial without name/handle and verification date
- Urgency language not tied to a specific, real, material, adverse-to-consumer date
- More than 50% of live variants in any 7-day window using urgency language

---

## §10 Sign-off required from

| Faction | What they are approving | Sign-off confirms |
|---|---|---|
| **Jake** | Kill criterion (30%), consumer harm kill criterion (2× dispute rate), graduation criterion (15% CTR-to-completion), 12-variant/week preserved | "My measurement rules are intact, the test is fair, and the consumer harm gate is reasonable" |
| **Priya** | §1 as compliance floor (not aesthetic preference), §2 as structural grammar, net-impression gate | "The voice doc is load-bearing and the dark patterns are gone via legal obligation, not taste" |
| **Legal** | Tier 2 ticket SLA (24h, auto-expire not auto-approve), Tier 3 = §1 kill list, Reg Z companion disclosure requirement, claim substantiation process linked to `system/substantiation-log-template.md` | "We can defend this in front of an FTC examiner and a CFPB supervisory review" |
| **CEO** | Nothing. Do not loop in until Jake, Priya, and Legal have all three sign-offs. | — |

---

## Appendix A — Reg Z trigger-term checklist

Required for every Tier 2 variant stating an APR. Complete before filing the legal ticket.

- [ ] APR stated using the term "annual percentage rate" in the companion disclosure
- [ ] Rate identified as fixed or variable
- [ ] All applicable fees disclosed in the ad unit
- [ ] For closed-end credit: payment terms disclosed (number of payments, amount, total of payments)
- [ ] Companion disclosure is in the same ad unit or immediately adjacent — not on the landing page
- [ ] The rate floor is available to a materially representative portion of the audience being served (net-impression test)

---

## Appendix B — Audit findings incorporated (v1.0 → v1.1)

14 findings from FTC/Reg Z/CFPB stress test, 2026-05-17:

| # | Finding | Section changed |
|---|---|---|
| 1 | Tier 2 auto-approve inverted to auto-expire | §4 Tier 2 |
| 2 | Hidden disclosure definition replaced with FTC clear-and-conspicuous four-factor test | §1.2 |
| 3 | APR claims moved from Tier 1 to Tier 2 minimum; Reg Z checklist added | §4 Tier 1, Appendix A |
| 4 | Net-impression gate added to §1 and all activation paths | §1 net-impression gate |
| 5 | Atypical-results disclosure required in ad unit body copy, not landing page | §4 Tier 2, Headline 2 |
| 6 | Urgency materiality and adversity test added to §2 and §3 | §2 urgency, §3 urgency, Headline 8 |
| 7 | Personalization theater gate added to Headline 7 | §6 Headline 7 |
| 8 | Population equivalence requirement added to Headline 9 | §6 Headline 9 |
| 9 | Typical-results rate (not count) disclosure required in Headline 2 | §6 Headline 2 |
| 10 | Actionability gate added to Headline 4 | §6 Headline 4 |
| 11 | CFPB §1031 added alongside FTC references | §1, §4 |
| 12 | Urgency frequency cap (≤50% of live variants per 7-day window) added | §3 |
| 13 | Substantiation log cross-referenced on all activation paths | §4 |
| 14 | Consumer harm kill criterion added to test protocol | §8 |

---

*Last updated: 2026-05-17 — v1.1 LOCKED*
*Next review: after 4-week test post-mortem*
