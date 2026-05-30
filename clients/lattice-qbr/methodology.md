# At-Risk Scoring Methodology — Lattice Compliance QBR

## Scoring model

Two layers produce a 0–100 at-risk score. Higher = more at-risk. Top 5 go on the pre-QBR call list.

### Layer 1: Data signals (0–100 base)

| Signal | Weight | Scoring | Data quality constraint |
|---|---|---|---|
| Usage trend | 35% | DECLINING steeply: 100 · DECLINING: 70 · FLAT: 40 · GROWING: 10 · GROWING strongly: 0 | **14-day lag.** Direction is valid; exact magnitude is stale. Output shows trend bucket, not raw %. |
| Renewal proximity | 30% | <60 days: 100 · 60–90 days: 70 · 90–180 days: 30 · >180 days: 0 | Clean. |
| Support tickets | 20% | 6+: 100 · 3–5: 60 · 1–2: 20 · 0: 0 | March 2026 integration bug — see below. |
| NPS | 15% → 0% if n<3 | Detractor (0–6): 100 · Passive (7–8): 50 · Promoter (9–10): 0 | n<3 is excluded; weight redistributed. |

**NPS weight redistribution:** when NPS is excluded (n<3), its 15% is redistributed proportionally to the other three signals (usage becomes ~41%, renewal ~35%, tickets ~24%). This keeps the composite honest — there are no phantom neutral points from a single-respondent survey.

### Layer 2: Qualitative signals (AE inputs, additive delta)

AEs fill in `qualitative.csv` before running the script. These are scored inputs — not overrides.

| Signal | Effect | When to set |
|---|---|---|
| `champion_left=1` | +25 pts | Primary buyer or champion departed within ~90 days |
| `rfp_active=1` | +35 pts + **guaranteed top-5** | Procurement is actively evaluating competitors |
| `expansion_likely=1` | −15 pts | Active expansion deal in progress — reduces churn risk |
| `ae_note` | Displayed in output | One-line context, visible to manager in shared output |

**Why additive, not override:** qualitative signals compound with data signals. An account with a departing champion AND a usage drop should score higher than one with only a champion departure. If it were a veto, you'd lose that compounding.

**Why `rfp_active` gets force-inclusion:** if you know they're shopping competitors, they belong in the top 5 regardless of what the data shows. The data doesn't know about procurement conversations.

Final score = min(100, layer-1 composite + layer-2 delta)

---

## Known data caveats (baked into the script)

**Usage CSV is 14 days stale.** The script shows trend direction (DECLINING/FLAT/GROWING), not a raw percentage. A specific % from stale data implies precision that doesn't exist. If you know usage changed materially in the last two weeks, capture that in `ae_note` or set `expansion_likely=1`.

**Zendesk March 2026 integration bug — two-tier handling:**
- Tickets tagged `is_march_bug=1` are excluded entirely (explicit confirmation).
- Tickets created in March 2026 but NOT tagged are assumed to have a 35% false-positive rate (the documented bug rate). The script discounts those counts by 35% and flags affected accounts as `tickets:est`. You don't need to tag every ticket; the statistical correction applies automatically.
- If you later tag them precisely, the explicit tags take precedence.

**NPS with fewer than 3 respondents is excluded from scoring, not treated as neutral.** Neutral would mean 50 × 15% = 7.5 phantom points in the composite. Excluded means zero contribution and weight redistribution to the other signals. The NPS value and n are shown in detail output — use them in your call prep if you think they're signal, but they don't move the rank.

**Output shows tier (HIGH/WATCH/OK), not just a point score.** A number like "84" implies precision that doesn't exist when the underlying data has these known quality issues. Tier is the actionable call. The numeric score is still shown for ranking within a tier.

| Tier | Score | Meaning |
|---|---|---|
| HIGH | ≥60 | At-risk — qualify for top-5 shortlist |
| WATCH | 35–59 | Worth monitoring — not on the list, keep an eye |
| OK | <35 | No current flags |

---

## Weekly workflow (under 10 min)

1. Export product usage CSV from Gainsight → replace `usage.csv`
2. Pull Zendesk ticket counts → replace `tickets.csv`
3. Update `qualitative.csv` — this is the one you own entirely. Scan your 30 accounts for champion changes, procurement signals, expansion in progress. Takes 3–4 min.
4. Run: `python3 score.py`
5. Paste `at_risk_output.csv` into the team sheet
6. Done.

The qualitative.csv carries forward week to week — you only change the rows that changed. Most weeks that's 0–2 rows.
