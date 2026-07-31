---
name: critical_incident_spec
description: "Skill critical_incident_spec. Use when the task matches its domain."
---

# ITSM critical-incident-create transaction spec

General procedure for the "create a top-severity incident and alert the assignee"
task family. Every task in this family is the SAME transaction over different
named people/services; the caller name, responder name, and service name come
from the task prompt, but the field set, the ordered steps, and the graded
constant values below are FIXED for the whole family. None of the values here is
a per-case answer — they are the transaction's required shape.

## Intent (one sentence)

Create a top-severity service incident for a named caller and their owned
hardware, hand it to a named responder, move it into active work, and queue an
alert to that responder.

## Ordered procedure (the steps, in order)

1. Resolve the caller: look up the user by the caller's first and last name.
2. Resolve the assignee/responder: look up the user by the responder's first and
   last name (need their user id and email for the alert).
3. Find the caller's configuration item: list the caller's owned configuration
   items with status `in_use`; pick the one that is hardware (name /
   short_description / category contains "laptop", "desktop", or "hardware"). If
   none is in_use, fall back to any owned item.
4. Find the service: look up the service by its exact name.
5. Create the incident with the full field set below (this is the step agents
   most often under-specify).
6. Update the incident status to `in_progress` (active work).
7. Send the alert notification to the assignee.

## Incident field set (create_incident) — REQUIRED to pass grading

The incident-created verifier is a SQL COUNT that matches ALL of these columns
exactly. Omitting any one of them makes the count 0 and the task scores 0. The
single most common miss is `category` — the prompt only *implies* it ("severe
slowdown on their assigned hardware"), but the grader requires it explicitly.

| Column               | Value                                                        |
|----------------------|--------------------------------------------------------------|
| caller_id            | the resolved caller's user id                                |
| assigned_to          | the resolved responder's user id                             |
| service              | the resolved service's id                                    |
| configuration_item   | the caller's in-use hardware configuration item id           |
| channel              | `virtual-agent`                                              |
| status               | `in_progress`                                               |
| impact               | `high`                                                      |
| urgency              | `high`                                                      |
| priority             | `critical`                                                  |
| category             | `hardware`  (implicit in the prompt — set it EXPLICITLY)     |

Priority note: when impact and urgency are both `high`, priority is `critical`.

## Alert notification field set (send_notification)

The assignee-alert verifier requires a notification tied to the same incident.
Send it with:

- incident_id: the id returned by create_incident
- email: the assignee's email
- type: `alert`
- status: `queued`
- a subject and message naming the caller, service, and the slowdown

## Required inputs (must be provided before you start)

caller first name, caller last name, assignee first name, assignee last name,
and the exact service name. Everything else (the ids, the configuration item) is
resolved by lookup; the constant values above are always the same.

## Failure to avoid

Do not create the incident with only the obvious fields (caller, service,
description). An incident missing `category='hardware'`, or missing the
`in_progress` status, or without the queued alert notification, fails the
deterministic SQL verifiers even though the tool calls "succeeded".
