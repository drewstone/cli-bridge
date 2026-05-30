# Creator pipeline — May 2026

## State machine

```
brief_sent
  └─► draft_received
        └─► disclosure_review          ← Gate 1 opens (operator reviews draft)
              ├─► revision_requested   ← Gate 1 FAIL: disclosure missing or mis-placed
              │     └─► disclosure_review  ← creator resubmits; loop until pass
              └─► approved             ← Gate 1 PASS: placement confirmed, go-ahead sent
                    └─► live_verified  ← Gate 2: platform API or manual post-pull passes
                          ├─► payment_frozen  ← Gate 2 FAIL: live post non-compliant
                          │     └─► live_verified  ← creator fixes post; re-verify
                          └─► paid     ← Stripe Connect fires; both gate refs logged
```

States (enum): `brief_sent` | `draft_received` | `disclosure_review` | `revision_requested`
               | `approved` | `live_verified` | `payment_frozen` | `paid`

Gates that cannot be bypassed:
- `disclosure_review` must be **pass** before `approved`
- `live_verified` requires platform API confirmation (or manual log for podcast) before `paid`
- TikTok posts hard-blocked at `live_verified` until tiktok-business-api OAuth connects

---

## Pipeline status

| # | Handle | Platform | Deliverable | Fee | Due | State | Disclosure | Live verified | Paid | Flags |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | @alpine_avery | IG | Reel 60s | $2,400 | May 18 | brief_sent | pending review | — | — | First deadline — 4 days |
| 2 | @rivertom | YouTube | Short 90s | $1,800 | May 19 | brief_pending | — | — | — | Brief not sent |
| 3 | @summit_kala | TikTok + IG | TikTok 45s + IG Story | $3,100 | May 20 | revision_requested (TikTok) | FAIL — 3 violations | — | — | TikTok blocked; IG Story not received |
| 4 | @camptownboys | Podcast | Read 60s ×2 episodes | $1,400 | May 22 | brief_pending | — | — | — | Manual verify |
| 5 | @gear_meadow | IG | Reel 45s | $1,900 | May 23 | brief_pending | — | — | — | Brief not sent |
| 6 | @trail_jared | YouTube | Long-form 8-12 min | $4,800 | May 26 | brief_pending | — | — | — | Highest fee |
| 7 | @snowline_dani | IG | Carousel 8 slides | $1,200 | May 19 | brief_pending | — | — | — | Brief not sent |
| 8 | @backcountry_will | TikTok | TikTok 60s | $2,100 | May 21 | brief_pending | — | — | — | **Fully blocked — TikTok OAuth** |
| 9 | @gravelroad_sam | Podcast | Read 90s | $1,600 | May 24 | brief_pending | — | — | — | Manual verify |
| 10 | @parkrun_nora | IG | Reel 30s + 3 Stories | $2,800 | May 25 | brief_pending | — | — | — | Multi-deliverable |
| 11 | @overlanding.tess | YouTube | Short 60s | $1,500 | May 22 | brief_pending | — | — | — | Brief not sent |
| 12 | @basecamp_lou | IG | Story takeover 8 slides | $2,200 | May 27 | brief_pending | — | — | — | Per-slide verify |

---

## Blocked creators

### @backcountry_will — FULLY BLOCKED
- Deliverable is TikTok-only. No path to `live_verified` or `paid` until tiktok-business-api OAuth completes.
- Fee held: $2,100
- Action required: connect tiktok-business-api OAuth before May 21 due date or flag delay to creator.

### @summit_kala — PARTIAL BLOCK
- TikTok 45s portion: blocked same as above.
- IG Story portion: can proceed independently through full pipeline.
- Fee split: track IG Story and TikTok portions as separate line items.
- Action required: same OAuth dependency.

---

## Budget

Total program: $26,800
Committed: $26,800 (all 12 creators contracted)
Paid to date: $0
Remaining: $26,800

See `vault/system/budget.md` for per-creator ledger.

---

## Upcoming deadlines (as of May 17)

| Due | Creator | Days out | State | Action needed |
|---|---|---|---|---|
| May 18 | @alpine_avery | **1 — TOMORROW** | brief_sent → **draft OVERDUE** (gate1_deadline was May 15) | **Follow up immediately — no draft received in 4 days** |
| May 19 | @rivertom | 2 | brief_pending | **Send brief today** |
| May 19 | @snowline_dani | 2 | brief_pending | **Send brief today** |
| May 20 | @summit_kala | 3 | revision_requested (TikTok) / brief_pending (IG Story) | Send revision-request-tiktok.md; confirm CTA code; send IG Story brief |
| May 21 | @backcountry_will | 4 | brief_pending — **TikTok OAuth BLOCKED** | Connect TikTok OAuth or notify creator of hold |
| May 22 | @camptownboys | 5 | brief_pending | Send brief |
| May 22 | @overlanding.tess | 5 | brief_pending | Send brief |
| May 23 | @gear_meadow | 6 | brief_pending | Send brief |
| May 24 | @gravelroad_sam | 7 | brief_pending | Send brief |
| May 25 | @parkrun_nora | 8 | brief_pending | Send brief |
| May 26 | @trail_jared | 9 | brief_pending | Send brief |
| May 27 | @basecamp_lou | 10 | brief_pending | Send brief |
