# Brightleaf Dental — Inbound Voice Campaign Config

## Campaign Metadata
- **Practice:** Brightleaf Dental
- **Agent name:** Sam
- **Campaign type:** Inbound call answering + appointment booking
- **Active hours:** Monday–Friday, 8:00 AM – 5:00 PM (timezone of practice)
- **Language:** English (primary), Spanish warm transfer available
- **Recording:** Enabled — disclosure mandatory per call

## Routing Logic

### Call Triage Flow
```
INBOUND CALL
  → Greeting (Sam)
  → Identify need:
      ├── Emergency (pain, trauma, broken tooth, lost filling/crown, swelling)
      │     → Check same-day emergency slots
      │     ├── Slot available → Book immediately, confirm within 60 seconds
      │     └── No slots → Offer next morning or after-hours referral
      ├── New patient (routine exam/cleaning or specific procedure)
      │     → Gather name, phone, insurance
      │     → Book next available 45-min slot (prefer mornings)
      ├── Existing patient (routine, reschedule, specific procedure)
      │     → Pull up by name
      │     → Book or modify appointment
      ├── Administrative (billing, insurance, records, complaint)
      │     → Warm transfer to appropriate staff member
      │     └── If staff unavailable → Schedule callback, do not leave unresolved
      └── Unclear / general inquiry
            → Ask clarifying questions
            → Route to appropriate bucket above
```

### Staff Availability Schedule (for warm transfers)
| Staff | Role | Available For Transfer |
|-------|------|------------------------|
| Maria | Billing/Insurance | Mon–Fri 9:00 AM – 4:30 PM |
| Lisa | Office Manager | Mon–Fri 9:00 AM – 5:00 PM |
| Jen | Clinical Assistant | Mon–Fri 8:00 AM – 4:00 PM |
| Rosa | Front Desk (Spanish) | Mon–Fri 8:00 AM – 2:00 PM |
| Dr. Patel | Dentist | Mon–Fri 8:00 AM – 5:00 PM (clinical hours; transfer only for urgent clinical questions) |

**Callback SLA if transfer target is unavailable:**
- Billing/insurance: within 2 hours
- Office manager: within 4 hours
- Clinical questions: within 2 hours
- Spanish callback: within 2 hours

### After-Hours Behavior (calls received outside 8–5, M–F)
- **Greeting:** "You've reached Brightleaf Dental. Our office is currently closed. If this is a dental emergency, press 1 to be connected to our after-hours line. Otherwise, leave your name, number, and reason for calling, and we'll return your call when we open at 8:00 AM."
- **Emergency option:** Route to after-hours dentist on-call (rotating provider, number: [to be configured])
- **Voicemail capture:** Name, phone, reason for call. Transcribe and email to front desk by 8:15 AM next business day.

## Appointment Slot Logic

### Daily Template (Monday–Friday)
| Time | Slot Type | Duration | Buffer |
|------|-----------|----------|--------|
| 8:00 AM | New patient / procedure | 45 min | — |
| 8:30 AM | Cleaning / established | 30 min | — |
| 9:00 AM | New patient / procedure | 45 min | — |
| 9:30 AM | Cleaning / established | 30 min | — |
| 10:00 AM | Emergency release cutoff | — | — |
| 10:00 AM | Cleaning / procedure | 30–60 min | — |
| 10:30 AM | Cleaning / established | 30 min | — |
| 11:00 AM | Procedure / emergency | 30–60 min | — |
| 11:30 AM | Cleaning / established | 30 min | — |
| 12:00 PM | Last morning slot | 30 min | — |
| 12:30 PM | LUNCH — no bookings | — | — |
| 1:30 PM | First afternoon slot | 30 min | — |
| 2:00 PM | Procedure / emergency | 30–60 min | — |
| 2:30 PM | Cleaning / established | 30 min | — |
| 3:00 PM | Procedure / new patient | 45 min | — |
| 3:30 PM | Cleaning / established | 30 min | — |
| 4:00 PM | Last procedure slot | 30–60 min | — |
| 4:30 PM | Last cleaning slot | 30 min | — |
| 5:00 PM | Office closes | — | — |

**Emergency slots:** Two slots held daily — one at 10:00 AM or 11:00 AM, one at 2:00 PM or 3:00 PM. Released to general booking at 10:00 AM if unused.

### Booking Constraints
- Never double-book Dr. Patel. One chair, one patient at a time.
- Leave 15-minute buffer between complex procedures (crowns, root canals) when possible.
- Hygiene cleanings can overlap with Dr. Patel's exam portion — Jen handles cleanings independently.

## Disposition Codes (Call Outcome Logging)

| Code | Meaning |
|------|---------|
| `booked_new_pt` | New patient appointment scheduled |
| `booked_existing` | Existing patient appointment scheduled |
| `booked_emergency` | Same-day emergency appointment scheduled |
| `booked_procedure` | Specific procedure appointment scheduled |
| `rescheduled` | Existing appointment moved to new time |
| `cancelled` | Appointment cancelled (note: 24hr policy) |
| `nurture_email` | Caller requested info, no appointment yet |
| `transfer_billing` | Warm transfer to Maria |
| `transfer_manager` | Warm transfer to Lisa |
| `transfer_clinical` | Warm transfer to Jen |
| `transfer_spanish` | Warm transfer to Rosa |
| `callback_scheduled` | Promised callback at specific time |
| `voicemail` | Caller left message after hours |
| `er_referral` | Directed to ER / 911 for severe emergency |
| `dnc_request` | Caller requested no future calls (log and suppress) |
| `hangup` | Caller hung up before resolution |

## Integration Points

### Required Connections
1. **Practice Management System / Calendar**
   - Read available slots in real time
   - Write booked appointments
   - Flag existing patients by phone number lookup
   - **Status:** NOT YET CONNECTED — needs PMS API credentials (Dentrix, Open Dental, Eaglesoft, or generic CalDAV)

2. **SMS/Reminder System**
   - Trigger appointment confirmation text immediately after booking
   - Trigger day-before reminder text at 4:00 PM
   - **Status:** NOT YET CONNECTED — needs Twilio or practice SMS provider API key

3. **Insurance Verification (optional but recommended)**
   - Send patient info to Maria's queue for Delta Dental eligibility check
   - **Status:** MANUAL — Maria handles via Delta Dental portal

### Fallback When Integrations Are Down
If the calendar/PMS is unreachable:
- "I'm having trouble accessing our schedule right now. Let me take your name and number, and I'll have a team member call you back within 30 minutes to confirm your appointment time. Is that okay?"
- Write the request to a local queue (SQLite / file) and alert the front desk via SMS or email.

## KPIs and Kill Criteria

### Weekly Targets
- **Answer rate:** > 95% of calls during business hours
- **Booking rate:** > 70% of non-administrative calls result in a scheduled appointment
- **Emergency booking rate:** > 90% of emergency calls get a same-day or next-morning slot
- **Transfer resolution rate:** > 95% of warm transfers connect successfully
- **Callback SLA hit rate:** > 90% of promised callbacks made on time

### Kill Criteria (flag for human review if violated)
- Booking rate drops below 50% for 3 consecutive days
- Average call duration exceeds 8 minutes (indicates confusion or inefficiency)
- Caller asks for a human > 20% of calls in a single day
- Multiple complaints about "robot" or "not listening" in a week
- Emergency calls missed or misrouted (any instance = immediate review)

## Compliance Checklist
- [ ] Recording disclosure active on every call
- [ ] HIPAA training completed for agent configuration (no patient info confirmed to unidentified callers)
- [ ] DNC/suppression list maintained and scrubbed
- [ ] After-hours emergency routing tested weekly
- [ ] Callback SLA audited daily
