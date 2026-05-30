# Platform-specific FTC disclosure requirements

FTC Endorsement Guides (16 CFR Part 255, updated 2023): disclosures must be **clear, conspicuous,
and unavoidable** — visible before any purchase decision, not buried in hashtags or below the fold.
"Difficult to miss" is the standard. Placement rules below are derived from FTC guidance +
platform-specific policy as of May 2026.

---

## Instagram Reels

**Required — both must be present, neither substitutes for the other:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | Native Paid Partnership label | Set before publish via Creator Tools → Paid Partnership → tag brand | Platform-rendered overlay; no manual text equivalent |
| 2 | Caption `#ad` or `#sponsored` | **First visible line of caption** — within the first ~125 characters displayed before "more" truncation. Must be the very first token, not embedded mid-sentence. | `#ad` or `#sponsored` — not `ad` or `(ad)`. Hash required. |

**Fails if:** `#ad` appears after a line break, after emojis, or only in a hashtag stack at the end.

**API verification fields (instagram-graph-api):**
- `branded_content_sponsor_page_id` → must be non-null
- `caption` → regex `^#(ad|sponsored)\b` within first 125 chars

---

## Instagram Stories

**Required per-slide:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | Native Paid Partnership label | Must be toggled on **each slide individually** — the label does not carry across slides | Platform-rendered sticker |
| 2 | On-screen `#ad` text sticker | **On-screen during the first 3 seconds of each slide** and must remain for the slide's full duration if the slide is ≤15s | Use IG text tool — not hidden behind other stickers, not in a corner where it blends with background |

**Story takeover (8+ slides):** Every slide with brand-relevant content must carry both. Non-brand slides (e.g., pure CTA "swipe up") still need the Paid Partnership label.

**API verification fields (instagram-graph-api):**
- Per-story `branded_content_sponsor_page_id` → non-null for each slide
- Visual on-screen text verified manually at review stage (API cannot read overlay text)

---

## Instagram Carousel

**Required:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | Native Paid Partnership label | Set on the post (applies to all slides) | Platform-rendered |
| 2 | Caption `#ad` | **First visible line of caption** before "more" truncation — same 125-char rule as Reels | `#ad` or `#sponsored` as first token |
| 3 | Slide 1 on-screen text | `#ad` or `Paid Partnership` visible on the first image/video slide | Legible font, contrasting color, not in a corner |

**Fails if:** Disclosure only appears on interior slides — the cover slide is the FTC exposure point.

**API verification:** Same as Reels.

---

## TikTok

**Required — both must be present:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | Native Branded Content toggle | Must be enabled **before publishing** in TikTok Creator Tools → Branded Content. Adds automatic "Paid Partnership" overlay at top of video. | Platform-rendered; cannot be added post-publish |
| 2 | On-screen verbal or text disclosure | **Within first 3 seconds** of video — either spoken aloud ("This is a paid partnership with [Brand]") or on-screen text overlay | Spoken: clearly audible, not over loud music. Text: contrasting color, stays on screen ≥3s |
| 3 | Caption `#ad` | Caption text — no truncation rule on TikTok, but must appear before hashtag stacks | `#ad` or `#sponsored` |

**⚠️ HARD BLOCK — tiktok-business-api is `oauth_required`.** Live-post verification for TikTok
is blocked. Do **not** advance any TikTok post to `live_verified` or `paid` until OAuth connects.
Affected creators: @summit_kala (TikTok portion), @backcountry_will (entire deliverable).

**API verification fields (tiktok-business-api — pending oauth):**
- `branded_content.disclosure_type` → must be `PAID_PARTNERSHIP`
- `video_description` → must contain `#ad` or `#sponsored`

---

## YouTube Shorts (≤60s)

**Required — all three:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | "Paid promotion" checkbox | Video settings → Paid Promotion → check "My video contains paid promotion" before publish | Platform-rendered disclosure card shown to viewer |
| 2 | On-screen text or verbal | **Within first 3 seconds** — either spoken ("This Short is sponsored by [Brand]") or text overlay | Text must be legible at mobile size; verbal must be clearly audible |
| 3 | Description disclosure | First 100 characters of description (visible without expanding) | "Sponsored by [Brand]" or `#ad` or `#sponsored` |

**API verification fields (youtube-data-api):**
- `status.selfDeclaredMadeForKids` (informational)
- `paidProductPlacementDetails.hasPaidProductPlacement` → must be `true`
- `snippet.description` → disclosure text within first 100 chars

---

## YouTube Long-form (>60s)

**Required — all four:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | "Paid promotion" checkbox | Same as Shorts | Platform-rendered card |
| 2 | Verbal disclosure — opening | **Spoken within first 30 seconds** before viewer can skip | "This video is sponsored by [Brand]" — full sentence, not just brand mention |
| 3 | Verbal disclosure — post-mid-roll | If video has mid-roll ads: spoken again within 30s after any mid-roll break | Same phrasing |
| 4 | Description disclosure | First 100 characters of description | "Sponsored by [Brand]" + `#ad` or `#sponsored` |

**Fails if:** Sponsor mention only appears deep in the video, only in end-card, or is ambiguous ("thanks to [Brand]" without "sponsored").

**API verification:** Same fields as Shorts. Timestamp of verbal disclosure logged manually during review.

---

## Podcast (recorded read)

No native disclosure platform. FTC guidance requires disclosure before the sponsored content begins.

**Required — both must be present in every episode:**

| # | What | Where / When | Exact format |
|---|---|---|---|
| 1 | Verbal disclosure — episode open | **Spoken at the top of the sponsored segment, before any brand copy begins.** Not at the end of the read. | "This segment/episode is sponsored by [Brand]. The following is a paid promotion." Full sentence. |
| 2 | Show notes / episode description | Anywhere in episode description visible without clicking "show more" | "This episode contains paid promotion for [Brand]" or `#ad` |

**Verification is manual** — no podcast API integration. Verification process:
1. Manager listens to published episode
2. Notes exact timestamp of verbal disclosure (e.g., "00:03:12")
3. Confirms show notes contain disclosure text
4. Records in gate log: `episode_url | disclosure_timestamp | show_notes_confirmed | reviewer_initials`

This manual record satisfies the `live_verified` gate for podcast deliverables.

---

## Summary — exact placement rules

| Deliverable | Native label | Caption/copy `#ad` placement | On-screen/verbal | API verification |
|---|---|---|---|---|
| IG Reel | Paid Partnership (Creator Tools) | First token, ≤125 chars, before "more" | — | instagram-graph-api |
| IG Story | Paid Partnership per slide | — | Every slide, visible full duration, first 3s | instagram-graph-api + manual |
| IG Carousel | Paid Partnership on post | First token, ≤125 chars | Slide 1 on-screen | instagram-graph-api |
| TikTok | Branded Content toggle | Caption, before hashtag stack | First 3s, spoken or text | tiktok-business-api ⚠️ BLOCKED |
| YouTube Short | Paid promotion checkbox | Description, first 100 chars | First 3s | youtube-data-api |
| YouTube Long-form | Paid promotion checkbox | Description, first 100 chars | First 30s + post-mid-roll | youtube-data-api |
| Podcast read | n/a | Show notes | Top of read, before brand copy | Manual only |

---

## Common failures (do not pass disclosure_review with any of these)

- `#ad` appears only at end of caption after hashtag stack
- `#ad` written as `(ad)`, `[ad]`, `ad` without hash
- Paid Partnership label present but no caption disclosure (or vice versa — both required)
- Story: label only on first slide, not all slides
- TikTok: Branded Content toggle not enabled (cannot be added retroactively — requires re-publish)
- YouTube: "Paid promotion" checkbox unchecked — requires re-upload, not an edit
- Podcast: verbal disclosure appears at end of read ("...and that's sponsored by [Brand]")
- Podcast: show notes disclosure missing even if verbal is correct
