# Disclosure check — @alpine_avery (Gate 1)

state: disclosure_review
reviewer: —
reviewed_at: —
decision: pending  # pass | fail

platform: instagram
deliverable: IG Reel (60s)
draft_url: —
caption_reviewed: —

---

## Checklist — must be ALL checked for pass: true

### Caption
- [ ] Caption text is available for review (draft_url or paste)
- [ ] First token of caption is exactly `#ad` or `#sponsored` (not `(ad)`, `[ad]`, `ad`, `paid ad`)
- [ ] `#ad` appears within first 125 characters of caption (count from char 1)
- [ ] `#ad` is not separated from the start of caption by any emoji, word, or punctuation
- [ ] `#ad` not repeated only in a hashtag block at the end with no leading disclosure

### Platform label
- [ ] Creator confirms Paid Partnership label is enabled (Creator Tools → Paid Partnership)
  OR preview/screenshot shows the "Paid partnership with tailspinoutfitters" under handle
- [ ] Label is linked to Tailspin Outfitters (not a blank or unlinked tag)

### Content
- [ ] No prohibited claims ("warmth", "waterproof in all conditions", unsupported superlatives)
- [ ] CTA code ALPINE15 present or confirmed dropped (flag if dropped — brand needs to know)
- [ ] Video ≤60s (check duration in draft metadata or file name)

### API verification (run after live post, not on draft)
- instagram-graph-api `branded_content_sponsor_page_id`: —
- instagram-graph-api `caption` field first 125 chars regex `^#(ad|sponsored)\b`: —
- api_run_at: —

---

## Decision

pass: false
fail_reasons: —
notes: —
signed_by: —
signed_at: —

# If fail: update state → revision_requested in pipeline.md, fill revision in draft-v1.md
# If pass: update state → approved in pipeline.md, fill approval.md
