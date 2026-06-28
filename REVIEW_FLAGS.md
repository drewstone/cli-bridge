# Whitfield / 2024 Tax Return — Review Flags

## Critical entity-type conflict (must resolve before filing)
- Taxpayer states Whitfield Media LLC is an S corporation.
- Provided K-1 is labeled `form=1065` (partnership).
- Filing consequence:
  - If S-Corp: file Form 1120-S + K-1; K-1 box 1 ordinary income is **not** self-employment income; no Schedule SE.
  - If partnership: file Form 1065 + K-1; K-1 box 1 ordinary income **is** self-employment income; Schedule SE required.
- **Action:** Confirm actual 2024 entity classification / Form 8832 / Form 2553 status before proposing any passthrough form.

## HSA excess contribution risk
- Whitfield W-2 Box 12 code W = $14,400.
- 2024 HSA contribution limit (family coverage) = $8,300; $1,000 catch-up if age 55+.
- $14,400 exceeds the statutory limit unless multiple HSAs / special circumstances apply.
- **Action:** Verify total HSA contributions, coverage type, and ages; model excise tax on excess (Form 5329) if confirmed.

## Solo 401(k) employee deferral vs W-2 Box 1
- Stated `solo_401k_employee=23000`.
- W-2 Box 1 from Whitfield = $95,000.
- Need to confirm whether the $23,000 employee deferral is already excluded from Box 1 payroll or is a separate adjustment.
- **Action:** Compare W-2 Box 1 to gross wages before deferral; if not reflected, Box 1 may need correction.

## S-corporation health insurance reporting
- Taxpayer lists `s_corp_health_insurance=14400`.
- Same amount ($14,400) appears as Box 12 code W (HSA), not code DD or additional wages.
- **Action:** Clarify whether the $14,400 is HSA only, health-insurance premiums only, or both; health insurance must be included in wages and reported on Schedule 1 line 17 only if S-corp paid/reimbursed and included in W-2.

## Charitable non-cash stock > $5,000
- Charitable stock = $15,000.
- If claimed, requires Form 8283 Section B and a qualified appraisal (§170(f)(11)).
- **Action:** Obtain appraisal and donor acknowledgment before finalizing Schedule A / CA itemized deduction.

## California nonconformity — QBI add-back
- California does not conform to §199A QBI deduction.
- Federal Form 1040 line 13 QBI deduction must be added back on CA Schedule CA (540).
- **Action:** Include CA Schedule CA add-back once federal QBI is computed.

## State/local tax deduction fact
- User states `state_income_tax=0`.
- Real CA withholding / estimated payments likely exist but were not provided.
- **Action:** Request CA Form W-2 box 19/20 or 2024 CA estimated payments; needed for federal Schedule A comparison and CA refund/payment reconciliation.

## Itemized vs standard deduction
- Charitable cash $8,000 + stock $15,000 = $23,000 before state/local taxes.
- 2024 MFJ standard deduction = $29,200.
- Unless state/local taxes (capped at $10,000) push total itemized above $29,200, standard deduction will win federally.
- **Action:** Compute final comparison after receiving actual CA tax paid.
