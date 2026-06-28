# Capsule Security Voice Agent — Campaign Configuration

## Campaign Name
Capsule-CISO-Outbound-Q2-2026

## Goal
Book qualified 15-minute technical briefings between Daniel Roth and CISOs / security leaders at companies deploying AI agents.

## Success Metrics

| Metric | Target | Kill Criterion |
|--------|--------|----------------|
| Calls per day | 40–60 | Below 30 for 3 consecutive days → diagnose dialer/list issue |
| Contact rate (human answer) | 8–12% | Below 5% for 5 days → review data quality / timezone logic |
| Consent rate (continue past recording disclosure) | 60%+ | Below 40% → review disclosure script / caller ID reputation |
| Meeting booking rate (of calls with consent) | 5–8% | Below 2% for 10 days → kill campaign and rewrite opener |
| Cost per meeting | <$350 | >$700 by day 14 → pause and diagnose |

## Target List

**Source:** Enriched account list from spreadsheet + LinkedIn Navigator + public signal
**Size:** 300 accounts, 2–3 contacts per account = 600–900 numbers
**Refresh cycle:** Weekly. Remove bounces, DNC requests, and "never call me" dispositions.

### Enrichment requirements before dialing
- [ ] Direct dial or mobile number (not main line)
- [ ] Timezone derived from HQ location or area code
- [ ] Title verified: CISO, VP Security, Director Security, Head of AI Governance
- [ ] Signal verified: public AI-agent initiative, job posting, conference talk, or product launch
- [ ] DNC scrubbed: National DNC Registry + internal suppression list
- [ ] Bounce check: if email is known, verify it did not hard-bounce in the last 90 days

### Priority tiers
1. **Tier 1:** Accounts with confirmed AI-agent pilot or production deployment. Call first.
2. **Tier 2:** Accounts with AI security job postings or recent AI product launches. Call second.
3. **Tier 3:** Accounts in target sector/size with technographic fit but no explicit signal. Call last.

## Call Schedule

| Timezone | Dial window (local time) | Notes |
|----------|--------------------------|-------|
| Eastern (ET) | 9:00 AM – 11:30 AM | Highest answer rates for CISOs |
| Central (CT) | 9:00 AM – 11:30 AM | |
| Mountain (MT) | 9:00 AM – 11:30 AM | |
| Pacific (PT) | 9:00 AM – 11:30 AM | |

**Rule:** Never dial before 9:00 AM or after 5:00 PM in the prospect's local timezone. The old pattern of 9 AM ET for everyone is retired.

**Days:** Tuesday, Wednesday, Thursday only. Monday CISOs are in standups. Friday answer rates drop 40%.

## Compliance Stack

### Recording Disclosure
- Mandatory script: "This call is being recorded for quality. Do I have your consent to continue?"
- Must be spoken before any substantive conversation.
- If prospect declines: offer to disconnect and send email. Log disposition.

### DNC Scrubbing
- **National DNC Registry:** Scrub daily via TelemarketingSalesRule API or vendor (e.g., PossibleNOW, CompliancePoint).
- **Internal suppression list:** Maintain in real-time. Any "never call me again" or hangup at disclosure adds the number for 12 months minimum.
- **State-level:** If calling California, Colorado, or Virginia, ensure state-level DNC and consent rules are met. Consult legal if unsure.

### Caller ID
- Use a local number matching the prospect's area code where possible.
- Display company name: "Capsule Security" or "Capsule Sec" — never a blocked or spoofed number.
- Callback number must ring to the BDR or a voicemail box checked within 4 business hours.

### Data Retention
- Call recordings: Retain 90 days, then purge unless legally required.
- Call logs and dispositions: Retain indefinitely for compliance.
- Prospect PII: Minimize collection. Email and phone only. No SSN, no DOB.

## Agent Configuration (ph0ny platform)

```json
{
  "agent_id": "capsule-ciso-outbound-2026",
  "name": "Capsule Security — CISO Alert",
  "voice": {
    "provider": "ph0ny",
    "gender": "neutral",
    "style": "professional_peer",
    "speed": 145,
    "fillers": "minimal",
    "pause_handling": "allow_interrupt"
  },
  "language": "en-US",
  "max_call_duration_seconds": 300,
  "transfer_config": {
    "enabled": true,
    "transfer_number": "[BDR phone]",
    "warm_transfer": true,
    "context_message": true
  },
  "knowledge_base": {
    "endpoint": "/v1/agents/capsule-ciso-outbound-2026/knowledge",
    "refresh_interval_hours": 24
  },
  "dispositions": [
    "meeting_booked",
    "nurture_emailed",
    "callback_requested",
    "not_interested",
    "wrong_person",
    "dnc_request",
    "hangup_at_disclosure",
    "voicemail",
    "transfer_to_bdr"
  ]
}
```

## Human BDR Handoff Protocol

The one BDR operator monitors the ph0ny dashboard for:
- Warm transfers (answer within 10 seconds)
- Callback requests (return within 4 business hours)
- "Meeting booked" dispositions (send calendar invite within 2 minutes)
- "Nurture" dispositions (send one-pager within 2 minutes)

Daily standup: BDR reviews yesterday's call logs, updates the suppression list, and flags numbers that need enrichment.

## Kill Criteria

1. **If CAC per meeting > $700 by day 14:** Pause campaign. Diagnose: list quality? Opener? Competitor noise? Fix and re-test with 50-call pilot before full resume.
2. **If contact rate < 5% for 5 consecutive days:** Pause. The data is stale or the numbers are bad. Refresh enrichment before resuming.
3. **If consent rate < 40%:** The recording disclosure or caller ID reputation is broken. Fix and re-test.
4. **If two or more prospects complain to legal or threaten action:** Immediate pause. Review script with counsel before resuming.
5. **If BDR cannot handle warm-transfer volume:** Cap daily dials to match BDR capacity. Never let a warm transfer go to voicemail.

## Open Questions to Resolve Before Activation

1. What is the exact Calendly / calendar link for Daniel's 15-minute briefings?
2. What is the one-sentence wedge versus Lakera — is it "runtime vs. prompt layer" or something sharper?
3. Which 10 accounts are most realistic to book in the next 30 days?
4. Does the BDR have capacity to take warm transfers during the 9–11:30 AM dial windows?
5. Has legal reviewed the recording disclosure script for all states we plan to call?
