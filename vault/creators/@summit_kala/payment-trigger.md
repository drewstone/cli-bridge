# Payment trigger — @summit_kala

state: payment_frozen
blocked_reason: tiktok-business-api oauth_required — TikTok live-post verification impossible until OAuth connects

## Gate requirements

- [ ] approval.md approved: true
- [ ] TikTok: tiktok-business-api OAuth connected (currently oauth_required)
- [ ] TikTok live post URL confirmed + API verification passed (or manual screenshot approved)
- [ ] IG Story: instagram-graph-api verification passed

## Live post verification

tiktok_live_url: —
tiktok_verification_method: tiktok-business-api (falls back to manual_screenshot if OAuth unresolved at publish)
tiktok_verified_at: —
ig_story_live_url: —
ig_story_verification_method: instagram-graph-api
ig_story_verified_at: —
verified_by: —

## Payment

amount: $3,100
stripe_connect_id: —
stripe_transfer_id: —
initiated_at: —
paid_at: —
