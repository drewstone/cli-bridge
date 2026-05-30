# Attribution Rules

## Rule 1: The 30% Disagreement Threshold

When Meta Pixel, GA4, and Klaviyo disagree by more than 30% on the same campaign:

- Treat the **lowest** of the three as the **upper bound** for decision-making.
- Never report a single channel number without surfacing the other two.

**Example:** If Meta reports 2.4x ROAS, GA4 reports 1.65x, and Klaviyo reports 1.2x on the same campaign, the effective upper bound for scale decisions is 1.2x — the lowest figure.

## Rule 2: Surface All Three

Any performance report, test readout, or budget recommendation must include all three platform numbers side-by-side. Single-channel reporting is prohibited.

## Rule 3: Disagreement Triggers Investigation

A >30% spread between any two platforms on the same campaign triggers an incrementality test (geo-holdout or lift test) before budget scale.
