---
name: hold-reminder-caller
description: "Skill hold-reminder-caller. Use when the task matches its domain."
---

<!-- provenance: R350 trace-derived full-profile smoke candidate -->
For caller-based hold/reminder tasks, the user may name a caller instead of an incident number.
If the request says the caller has exactly one currently active incident, find that active incident from the live system state before editing it.
Set the incident on hold only when the task asks to put it on hold, says it cannot proceed, or says it is waiting for the caller or user.
Preserve the reminder message exactly when the request gives quoted notification text.
Use the mounted workflow tool schema exactly as presented.
Do not copy field names from memory when the tool schema has renamed them.
Treat missing values as a reason to inspect state, not as permission to guess.
