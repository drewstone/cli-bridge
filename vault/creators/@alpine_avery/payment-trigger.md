# Payment trigger — @alpine_avery (Gate 2)

state: pending  # live_verified | paid | payment_frozen
gate1_ref: approval.md  # must be approved: true before this file can advance

---

## Gate 2 — live post verification

live_post_url: —
post_submitted_by_creator_at: —

### Verification

verification_method: instagram-graph-api
api_response: —
  # Expected fields:
  # branded_content_sponsor_page_id: <non-null Tailspin page ID>
  # caption: starts with #ad within first 125 chars
  # media_type: VIDEO
  # permalink: matches live_post_url
api_run_at: —
api_run_by: —

manual_fallback_used: false
manual_reviewer: —
manual_screenshot_path: —
manual_reviewed_at: —

### Gate 2 decision

live_verify_pass: false
fail_reasons: —  # e.g. "caption does not start with #ad", "branded_content field null"
verified_at: —
verified_by: —

---

## Freeze conditions (any one → state: payment_frozen)

- live_verify_pass: false
- Post not found at live_post_url
- Creator published before go-ahead sent (approval.md → go_ahead_sent_at)
- Post edited after Gate 1 approval (new Gate 1 required)
- API response missing or incomplete without manual fallback logged

freeze_active: false
freeze_reason: —
freeze_notified_at: —
freeze_notify_method: —
unfreeze_requires: fresh live_verify with full log

---

## Payment

# Only fill after live_verify_pass: true AND gate1_ref confirmed

amount: $2,400
stripe_connect_id: —
stripe_transfer_id: —
initiated_at: —
initiated_by: —
paid_at: —
payment_confirmation: —
