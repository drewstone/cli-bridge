---
name: verify-before-done
description: "Skill verify-before-done. Use when the task matches its domain."
---

<!-- provenance: degradation finding (memory: checkpoint-restore-and-lock) — workers reach correct values then revise past them. -->
After each change you make, re-read the value you just set to confirm it actually took. Do not declare a step finished until you have observed its result. Never report DONE on a change you have not verified.
