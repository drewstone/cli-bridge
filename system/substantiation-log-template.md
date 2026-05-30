# Substantiation Log Template

**Purpose:** FTC audit trail for every ad variant. Every claim must trace to a dated, reviewed source.
**Owner:** Performance creative lead
**Review:** Priya's team (brand review), Compliance (factual disputes)

---

## Log format

| Variant ID | Ad Set | Claim Text | Substantiation Source | Scope | Methodology Description | Date Verified | Reviewer | Status | Expiry Date |
|---|---|---|---|---|---|---|---|---|---|
| HL-01-v1 | Meta LA-1% | "87% filed outside optimal timing window" | E2E application-timing dataset, 2024-Q3–Q5 | E2E applicants, US, all products | Internal review of application timestamp vs. rate-lock-awareness timestamp | 2025-05-14 | [Priya's reviewer] | Approved | 2026-05-14 |
| HL-02-v1 | Meta LA-1% | "Score doesn't weight total debt" | FICO Score 8 factor documentation, 2024 | General (third-party public doc) | N/A — third-party source | 2025-05-14 | [Priya's reviewer] | Approved | 2026-05-14 |
| (continue for all variants) | | | | | | | | | |

---

## Column definitions

- **Variant ID:** Matches the variant in the ad platform. Format: `HL-XX-vN`
- **Ad Set:** Platform + targeting (e.g., "Meta LA-1%", "Google SEM - credit score")
- **Claim Text:** The exact text in the ad that requires substantiation
- **Substantiation Source:** Document, dataset, or third-party publication. Must be specific enough to retrieve.
- **Scope:** Who the data covers. Must match the claim's language. "E2E applicants, US, all products" does not substantiate "most borrowers."
- **Methodology Description:** Honest description of how the number was derived. "SQL query of application timestamps" not "analysis." "Regression of timing vs. rate outcome" only if actual regression was run.
- **Date Verified:** When substantiation was last checked against source
- **Reviewer:** Who from Priya's team or compliance approved it
- **Status:** Approved / Flagged / Expired
- **Expiry Date:** Default 12 months from Date Verified. Stale substantiation must be re-verified before use.

---

## Process rules

1. **Log before launch.** No variant goes live without a substantiation log entry. Auto-enforced by review queue.
2. **Expiry is hard.** If expiry date has passed, the variant must be paused and re-verified before reactivation.
3. **Methodology honesty.** If the methodology description overstates the rigor of the work, the substantiation fails the FTC "competent and reliable" standard regardless of whether the number is correct.
4. **Quarterly audit.** Every quarter, compliance samples 20% of active substantiation entries and re-verifies against source data. Failed re-verification = immediate variant pause + root-cause review.
5. **Scope must match claim.** If the claim says "E2E applicants" and the source only covers one product line, either narrow the claim or expand the source.

---

## Stale-data review trigger

Any substantiation entry older than 9 months is flagged for priority review in the next quarterly audit. At 12 months, it auto-expires.
