# Gate log — append-only audit trail

All state transitions must be logged here with: timestamp, handle, from_state, to_state, actor, evidence_url.
This log is the FTC audit trail. Never edit existing entries.

Format:
```
[YYYY-MM-DD HH:MM UTC] @handle | from_state → to_state | actor: <name> | evidence: <url or note>
```

---

## Log

[2026-05-13 00:00 UTC] PROGRAM INITIALIZED | 12 creators scaffolded in brief_pending | actor: manager | evidence: vault/system/brief.md
[2026-05-13 00:00 UTC] POLICY ADOPTED | payment_policy.md written — live-post verification gate required before any payment | actor: manager | evidence: vault/system/payment_policy.md
[2026-05-13 00:00 UTC] @alpine_avery | brief_pending → brief_sent | actor: manager | evidence: vault/creators/@alpine_avery/brief.md — gate1_deadline set 2026-05-15
[2026-05-13 00:00 UTC] @summit_kala | draft_received → revision_requested | actor: manager | evidence: vault/creators/@summit_kala/disclosure-check.md — TikTok 45s: 3 violations (no Branded Content toggle, no on-screen disclosure ≤3s, no #ad in caption); IG Story draft not received; revision-request-tiktok.md issued 2026-05-17
[2026-05-17 00:00 UTC] @summit_kala | revision_requested (OVERDUE) | actor: drew | evidence: vault/creators/@summit_kala/draft-v1.md — revision was due 2026-05-16; no resubmit received as of 2026-05-17; re-review deadline extended to 2026-05-19; caption and on-screen text re-confirmed in vault; 3 violations unchanged; TikTok OAuth block unchanged
