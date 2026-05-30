# Disclosure check — @summit_kala

state: revision_requested
reviewer: drew
reviewed_at: 2026-05-13
re_reviewed_at: 2026-05-17
revision_overdue: true  # revision_due was 2026-05-16; no resubmit received as of 2026-05-17

---

## Deliverable A: TikTok (45s)

platform: tiktok
verification_method: tiktok-business-api
⚠️ HARD BLOCKED — tiktok-business-api oauth_required

### Review — draft v1 (received 2026-05-13)

caption_submitted: "obsessed with this rain shell, lifesaver on the alpine traverse last weekend 🏔️ link in bio"
onscreen_text_submitted: "the only shell I trust" (appears at ~5s)

### TikTok checklist

- [FAIL] Branded Content toggle enabled — NOT SET. Post must be deleted and re-published; toggle cannot be added retroactively.
- [FAIL] On-screen disclosure within first 3 seconds — NOT PRESENT. "the only shell I trust" is an endorsement claim, not a disclosure. Appears at 5s (2s past window). Required: #ad / "Paid Partnership" text, visible by second 1, on screen ≥3s, contrasting color.
- [FAIL] `#ad` in caption before hashtag stack — NOT PRESENT. Zero disclosure language in caption. Required: #ad or #sponsored as first or near-first caption element, before any brand copy.
- [ ] tiktok-business-api verification run: — (BLOCKED until OAuth connects)

### Required creator actions before re-review

1. Delete published post (Branded Content toggle cannot be fixed retroactively).
2. Re-enable Branded Content toggle in Creator Tools and tag brand before re-publishing.
3. Add #ad / "Paid Partnership" on-screen text sticker, visible from second 1 through at least second 3.
4. Rewrite caption to lead with #ad before all brand copy.
5. Re-submit draft URL. Re-review deadline: 2026-05-19.

---

## Deliverable B: IG Story

platform: instagram
verification_method: instagram-graph-api

### IG Story checklist

- [ ] Paid Partnership label enabled on each slide individually (does not carry across slides)
- [ ] `#ad` text sticker on-screen during first 3 seconds of each slide
- [ ] Sticker remains visible for full slide duration (if ≤15s)
- [ ] Sticker not obscured, not corner-blended
- [ ] instagram-graph-api verification run: —

---

## Decision

tiktok_pass: false
ig_story_pass: false  # draft not yet received
notes: TikTok draft reviewed 2026-05-13 and re-confirmed 2026-05-17. All three required disclosure elements missing. Revision was due 2026-05-16 — creator has not resubmitted. IG Story draft not received. Both tracks blocked.
signed_by: —
signed_at: —
payment_blocked_until: TikTok OAuth resolved (tiktok portion) + both deliverables pass gate re-review
