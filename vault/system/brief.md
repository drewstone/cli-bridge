# Creator program — May 2026

Brand: outdoor-gear (technical apparel + shells)
Active creators: 12
Total budget: $26,800 (fully committed)
Program period: May 18 – May 27, 2026

## Deliverables span

- Instagram: Reels, Stories, Story takeover, Carousel
- TikTok: short-form video (BLOCKED pending tiktok-business-api oauth)
- YouTube: Shorts, Long-form
- Podcast: sponsored reads

## Non-negotiable gate sequence

```
brief_pending → brief_sent → draft_received → disclosure_review
  → [revision_requested ↩ draft_received]
  → approved → live_verified → paid
```

Disclosure gate: must PASS before approval.
Live verification: platform API call required before payment.
TikTok live verification: hard-blocked until tiktok-business-api oauth completes.
Payment: Stripe Connect only — no manual override.

## FTC compliance context

March 2026 incident: @ridgeline_jess published without disclosure → FTC complaint.
Policy: disclosure_review gate is mandatory. See system/march-2026-incident.md.
