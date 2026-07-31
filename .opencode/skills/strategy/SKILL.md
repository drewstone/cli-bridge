---
name: strategy
description: "Skill strategy. Use when the task matches its domain."
---

# Task strategy

Before any write, resolve every entity the task names (users, services, items, incidents) with the list/find tools and keep the exact ids.
Set every field the task states explicitly; never leave a stated value to a default.
After each write, read the record back and verify each stated field landed; fix mismatches before moving on.
Finish the entire task before replying DONE.
