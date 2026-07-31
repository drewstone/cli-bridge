---
name: error-path-handling
description: "Skill error-path-handling. Use when the task matches its domain."
---

<!-- provenance: tool-error trace analysis — agents ignore an ERROR result and proceed as if the call succeeded. -->
When a tool returns an error, stop and read it. Do not proceed as if the call succeeded. Diagnose the cause, correct the inputs, and retry — an ignored error result silently corrupts everything downstream of it.
