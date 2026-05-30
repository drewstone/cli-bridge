# Proposal: Consistent At-Risk Methodology for QBR Cycles

**To:** Sales Leadership  
**From:** Marcus Reyes  
**Date:** 2026-05-13  
**Ask:** Adopt a shared at-risk scoring script across all 12 AEs starting next QBR cycle

---

## Problem

Every AE currently scores their 30 accounts differently. Leadership can't compare across reps, roll up a reliable pipeline risk number, or audit why an account churned without digging through 12 separate spreadsheets.

This cycle (QBR 2026-05-19) I'm already using the methodology below on my book. It took under 10 minutes.

---

## The methodology

Two scored layers. Neither replaces the other.

**Layer 1 — data signals (automated):**

| Signal | Weight | Source | Known caveat |
|---|---|---|---|
| Usage trend | 35% | Product usage CSV | Always 14 days stale |
| Renewal proximity | 30% | Salesforce | None |
| Support tickets | 20% | Zendesk | March bug false positives excluded by flag |
| NPS | 15% | Gainsight | n<3 treated as neutral |

**Layer 2 — qualitative signals (AE inputs, 3–4 min per week):**

| Signal | Effect |
|---|---|
| Champion departed | +25 pts |
| Procurement RFP | +35 pts + guaranteed top-5 |
| Expansion in progress | −15 pts |
| AE note | Free text, shown in output |

The critical design choice: qualitative signals are **inputs to the score**, not post-hoc overrides. Champion departure compounds with usage decline. An RFP automatically surfaces the account regardless of what the data shows. This is the right model — an account with zero data red flags can still be top-5 if you know procurement is shopping.

---

## Why this works for AEs

The data layer handles the obvious stuff so AEs don't have to. The qualitative layer captures what only AEs know. Neither can substitute for the other: pure data misses champion turnover and competitive displacement; pure AE judgment produces 12 different rubrics leadership can't compare.

The qualitative inputs are visible to the manager in the shared output. This keeps it honest in both directions — an AE who marks an account as RFP-active when it isn't is visible; an AE who correctly surfaces a champion departure before the data catches up is also visible.

---

## This cycle (2026-05-19 QBR) — my top 5

| # | Account | ARR | Score | Primary signal |
|---|---|---|---|---|
| 1 | Olympia Advisors | $65k | 44 | **RFP active** — procurement evaluating 3 competitors (force-included) |
| 2 | Crossway Insurance | $110k | 100 | **Champion left** Apr 22 + usage -44% |
| 3 | Summit Risk Group | $91k | 100 | **Champion left** May 1 + usage -43% |
| 4 | Meridian Financial | $85k | 84 | usage -45% + renewal in 30d |
| 5 | Silverton Capital | $95k | 84 | usage -89% + renewal in 19d |

Olympia Advisors would not appear in the top 5 under any pure-data model — it has strong NPS, far-off renewal, and decent usage. It belongs on this list because procurement is actively shopping. That's the methodology working correctly.

One near-miss worth noting: **Greystone Partners** ($88k, score 77) is #6. Champion Jennifer Park left Apr 8 with no named successor. Renewal in 43d, usage flat. Borderline — I may call them this cycle regardless.

---

## What it requires from each AE

- **One-time setup (~30 min):** tag the March Zendesk bug tickets in your export
- **Weekly (~10 min total):** export usage + tickets, update qualitative.csv for any accounts where champion/RFP/expansion status changed, run the script
- **No new tools:** runs locally, output pastes into Google Sheets

---

## Rollout ask

1. Share the script + CSV templates with all 12 AEs before the next cycle
2. Each AE runs it for one cycle alongside their current method
3. After one cycle: review where the model and AE judgment diverged, adjust weights if needed
4. Lock the methodology for the following cycle

This isn't a RevOps mandate. It's a baseline that every AE can still override with their own signal — the difference is that the override is explicit, logged, and auditable.
