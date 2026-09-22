# Salvaged work: provider session receipts

`provider-session-receipts.patch` is `git format-patch` output of commit `c0ab930` on
`fix/provider-session-receipts` (uncommitted on 2026-07-30, committed during the
2026-09-22 salvage after the host outage).

It adds per-turn provider receipts to the legacy session store (ordinal reserved at
admission, provider interval, bridge request digest, exact prompt sha256) and an exact
`GET /v1/sessions/:externalId` lookup.

It does not apply to current `main`: the legacy `sessions` table schema is now exact
(`EXPECTED_SESSION_SCHEMA`), receipts moved to `retained_run_admissions`, and
`GET /v1/sessions/:id` belongs to the retained session API. Re-implementing it means
deciding whether legacy sessions still need their own receipt ledger.

Apply with `git am salvage/provider-session-receipts.patch` on the commit it was written
against (`d165892`).
