# Payment policy — live-post verification gate

**Effective:** 2026-05-13
**Origin:** March 2026 FTC incident (@ridgeline_jess, missed #ad, competitor complaint)

---

## Rule (immutable)

Payment is triggered **only after both conditions are true and logged:**

1. `approval.md` → `approved: true` (Gate 1: disclosure_review passed, placement confirmed, go-ahead sent)
2. Live post is published AND disclosure verified correct on the live post (Gate 2)

Draft approval does not trigger payment. The live published post is the legal exposure, not the draft.

**If the live post is missing the required disclosure, or the disclosure is incorrectly placed:** payment is frozen immediately and manager is notified before any disbursement action is taken.

**Unfreeze:** creator corrects the live post → agent runs a full re-verification pass → manager countersigns → Stripe fires. Creator assertion that it's fixed is not sufficient.

---

## Freeze conditions — any one triggers freeze

| Platform | Freeze trigger |
|---|---|
| IG Reel / Carousel | `branded_content_sponsor_page_id` null OR `caption` regex `^#(ad\|sponsored)\b` fails within first 125 chars |
| IG Story (each story) | Per-story: on-screen overlay not confirmed by manual review (API does not give per-frame data) |
| TikTok | Branded Content toggle not set (`branded_content: false`) OR no `#ad` in `video_description` OR creator uploads without timestamp evidence that on-screen text appeared in first 3s |
| YouTube Short | `paidProductPlacement: false` OR no on-screen/verbal disclosure in first 5s (transcript or manual) |
| YouTube Long-form | `paidProductPlacement: false` OR no on-screen/verbal disclosure in first 30s (transcript or manual) |
| Podcast | Verbal disclosure absent or not at segment start (manual timecode review) |
| Any platform | Post edited after Gate 1 approval → Gate 1 must restart before Gate 2 runs |

---

## Live-post verification method by platform

### 1. Instagram Reel and Carousel
**Method: Instagram Graph API (OAuth connected)**

```
GET /v21.0/{media_id}
  ?fields=id,caption,media_type,branded_content_sponsor_page_id,permalink
```

Agent checks:
- `branded_content_sponsor_page_id` — must be non-null (Paid Partnership label set)
- `caption` — regex: `^#(ad|sponsored)\b` must match within first 125 characters (chars 0–124). If `#ad` appears at position 126+, it is behind the "more" truncation → freeze.
- `media_type` — confirm `VIDEO` (Reel) or `CAROUSEL_ALBUM`

**OEmbed is not sufficient here.** `GET /oembed?url=...` confirms the post is public and returns the title/thumbnail, but it does not expose `branded_content_sponsor_page_id`. Use OEmbed only to confirm the post is live before running the authenticated Graph API call.

**Limitation on Carousel first-slide disclosure:** Graph API returns `caption` at the album level and does not return slide-level image data in a way that confirms on-screen text. Carousel first-slide on-image `#ad` text must be verified by manual screenshot of slide 1.

---

### 2. Instagram Story (each story, individually)
**Method: Instagram Graph API (OAuth) + mandatory manual frame review**

```
GET /v21.0/{user_id}/stories
  ?fields=id,media_type,timestamp,permalink
```
Then for each Story media item:
```
GET /v21.0/{story_id}
  ?fields=id,caption,timestamp,media_url
```

**API gives you:** confirmation the story is live, its timestamp, and whether the Paid Partnership label was applied at the account level.

**API does NOT give you:** per-story frame-level overlay data. The API cannot tell you whether on-screen `#ad` text appears in the first frame of a specific story.

**Required supplemental step:** Creator must submit a screen recording or screenshot of each story at the 0-second mark showing the disclosure overlay. Agent logs `manual_review: true`, reviewer name, and timestamp. For @basecamp_lou (8 stories) and @parkrun_nora (3 stories), this means 8 and 3 screenshots respectively — all must be logged before payment fires.

**Stories expire at 24h.** If @basecamp_lou publishes at 9pm and you don't verify until the next morning, the stories may be gone. Gate 2 review must start within 12h of creator's publish confirmation.

---

### 3. TikTok
**Method: TikTok Business API (OAuth — currently blocked) / manual fallback**

**When OAuth is live:**
```
POST /v2/video/query/
  { "filters": { "video_ids": ["..."] }, "fields": ["id","title","video_description","branded_content","statistics"] }
```

Agent checks:
- `branded_content: true` — Branded Content toggle was enabled at upload
- `video_description` — regex for `#ad` presence
- `create_time` — confirm publish timestamp

**What TikTok API cannot confirm:** On-screen text placement in first 3 seconds. The API does not return a frame-by-frame breakdown or subtitle track. Two options:
- **Option A (recommended):** Creator submits a 5-second screen recording at time of upload, showing the on-screen text from 0:00. Agent logs as `manual_verification_clip: true` with filename.
- **Option B:** Manual reviewer watches the live TikTok post, logs `on_screen_disclosure_confirmed: true`, `confirmed_by`, `confirmed_at`.

**Until OAuth connects (fallback):** Creator submits live-post URL + screenshot showing (a) the Branded Content badge visible below their handle, (b) the `#ad` caption, and (c) a still frame from the first 3 seconds showing the on-screen text. All three screenshots required. Manager reviews and signs before payment proceeds.

---

### 4. YouTube Short and Long-form
**Method: YouTube Data API v3 (OAuth connected)**

```
GET /youtube/v3/videos
  ?id={video_id}&part=snippet,status,contentDetails
```

Agent checks:
- `status.madeForKids` — informational
- `contentDetails.hasCustomThumbnail` — informational
- **`status.selfDeclaredMadeForKids`** — confirm audience setting
- **Look for `hasPaidProductPlacement` in `contentDetails`** — must be `true`. This maps to the "Contains paid promotion" checkbox. If `false` or absent → freeze.

**What the API cannot confirm:** Verbal or on-screen disclosure timing. The API returns `snippet.description` (useful for checking description-level disclosures, though description-only is non-compliant), but it does not return a transcript or timecode for on-screen text.

**For YouTube Short (first 5 seconds):**
- Agent pulls video using `youtube-dl` or `yt-dlp` (or requests creator-submitted video file from draft), extracts first 5 seconds, runs OCR (e.g., Tesseract) on frames 0–5s OR checks auto-generated captions via:
```
GET /youtube/v3/captions
  ?videoId={video_id}&part=snippet
```
Then download the caption track and check that a disclosure phrase appears before the 5-second mark.

**For YouTube Long-form (first 30 seconds):**
- Same caption track pull. Check that "sponsored," "paid partnership," or "Tailspin Outfitters" with disclosure language appears within the first 30 seconds of the auto-generated transcript timecodes.
- If auto-captions are not yet generated (common in first few hours): creator submits timecoded manual note. Agent flags `transcript_pending: true` and re-checks within 6h.

---

### 5. Podcast
**Method: manual only — no podcast platform API integration**

Creator must submit ONE of:
- A direct audio clip (mp3/aac) starting at the disclosure and running through the first brand mention, OR
- A platform link (Spotify, Apple, Anchor) with an explicit timecode where the read starts

Reviewer runs:
- Play the clip from 0:00. Confirm: (1) verbal disclosure is the first thing spoken in the read, (2) "Tailspin Outfitters" or equivalent disclosure language precedes any brand claim.
- Log: `verbal_disclosure_at`, `first_brand_mention_at`, `reviewer`, `reviewed_at`

For @camptownboys (2 episodes): separate log entry for each episode. Both must pass before payment fires.

**Do not accept:** "I said it at about 14:30." Creator must submit a timecoded link or clip. Timestamps round-tripped through memory are not Gate 2 evidence.

---

## Verification failure escalation

| Failure type | Immediate action |
|---|---|
| API call returns post not found / deleted | Mark `post_missing: true`, freeze payment, notify manager — do not auto-pass |
| API returns disclosure fields as null/false | Freeze payment, log specific failing field, notify manager with post URL |
| Manual review: on-screen text absent | Freeze payment, log reviewer name + what was observed, notify manager |
| Creator edits post caption after Gate 1 approval | Gate 1 restarts; freeze any in-progress Gate 2 |
| Stories expire before Gate 2 review | Freeze payment, notify manager — creator must re-publish with disclosure, re-verify |

---

## Payment-trigger state transitions

```
pending
  → live_verified    (gate1_ref + gate2_ref both logged, all checks passed)
  → frozen           (live post fails disclosure check — manager notified)
  → unblocked        (frozen post corrected, re-verified, manager countersigns)
  → paid             (Stripe Connect transfer_id logged + confirmed)
```

## Required log fields in payment-trigger.md before Stripe fires

| Field | Required |
|---|---|
| `gate1_ref` | Reference to approval.md signed entry |
| `gate2_ref` | Reference to this verification pass |
| `verification_method` | `api` / `manual` / `api+manual` |
| `api_response_snapshot` | Key fields from API call (not raw blob — just the checked fields + values) |
| `verified_at` | ISO timestamp |
| `verified_by` | operator name or `api` |
| `stripe_transfer_id` | Filled at disbursement |
| `paid_at` | ISO timestamp |

---

## Notification triggers

| Event | Who notified | What is included |
|---|---|---|
| Live post disclosure check fails | Manager | Handle, platform, specific failing field/reason, live post URL |
| Payment frozen | Manager | All of above + freeze_reason logged to payment-trigger.md |
| Re-verification requested | Manager must countersign | New verification logged with fresh timestamp |
| Payment released | Manager | Stripe transfer ID + paid_at |

---

## Applies to all 12 creators — May 2026. No exceptions.

This policy supersedes any prior practice of paying on draft approval.
