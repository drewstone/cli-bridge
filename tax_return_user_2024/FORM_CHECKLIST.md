# 2024 Tax Return — User Session — Form Checklist

## Taxpayer profile
- Filing status: Married filing jointly (MFJ)
- Resident state: California (full-year)
- Occupation: Real estate investor + tech company founder

## Source documents on hand (verbatim user-supplied facts)
- 1099-DIV (brokerage): ordinary $89,000, qualified $72,000, foreign tax paid $4,200
- W-2 Spider Webb Tech Ltd (management fee): Box 1 wages $0
- K-1 Ashworth Holdings LLC (Form 1065): Box 1 ordinary loss ($42,000), Box 2 rental real estate loss ($42,000), depreciation $185,000, §179 $0, real-estate-professional statement
- K-1 Reid Capital Partners LP (Form 1065): Box 1 $0, Box 4a $0, Box 9a net LTCG $340,000, Box 11 other income $28,000
- CFC data for Spider Webb Tech Ltd: tested income $520,000, QBAI $180,000, STP $180,000, DTIR $18,000, GILTI inclusion $502,000, §250 deduction $251,000
- Foreign accounts: HSBC London ($2.4M), Credit Suisse Zurich ($850k)
- Real estate: Miami Beach rental ($156k gross / $198k expenses / ($42k) net), Brickell primary residence ($32k mortgage interest / $18k property tax)
- Deductions: mortgage interest $32k, property tax $10k (federal SALT cap), charitable cash $50k, charitable stock $200k, QOZ investment $150k

## Phase 1 — Intake / first work plan (current)
- [x] Confirm filing status, resident state, source states
- [x] Tentatively identify federal and California forms
- [ ] Identify missing facts and source checks
- [ ] Flag high-risk / ambiguity items for review

## Phase 2 — Source checks and computations (next)
- [ ] Confirm Spider Webb Tech Ltd entity classification (CFC vs. W-2 payer conflict)
- [ ] Confirm ownership percentage for Form 5471/8992
- [ ] Run federal_1040_ledger once missing facts are collected
- [ ] Compute GILTI / §250 / foreign tax credit interplay
- [ ] Compute Schedule D / K-1 LTCG netting
- [ ] Compute Schedule E rental/partnership flows
- [ ] Compute charitable deduction and Form 8283 requirements
- [ ] Compute QOZ basis deferral (Form 8997)
- [ ] Compute federal itemized vs. standard deduction
- [ ] Compute California itemized vs. standard and conformity adjustments

## Phase 3 — Form proposals
- [ ] Propose Form 1040 + federal schedules
- [ ] Propose Form 8992, 1116, 5471 (if applicable), 8938, 8997, 8283
- [ ] Propose California 540 + CA schedules

## Phase 4 — Audit / review
- [ ] Field-level consistency audit
- [ ] Finalize REVIEW_FLAGS.md
