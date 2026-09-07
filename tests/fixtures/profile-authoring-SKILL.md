---
name: profile-authoring
description: "Author an exact AgentProfile when a pursuit needs a new agent or method."
---

# Profile authoring

An `AgentProfile` defines one agent.
The task defines one assignment and its checked result.
Runtime executes both without choosing the research method or organization.

## Choose the node shape

An `AgentProfile` with zero Runtime coordination tools is a leaf execution profile.
It completes its assigned work and returns its result.

An `AgentProfile` with any Runtime coordination tool is a persistent managed node.
It can inspect recorded work, receive control, and continue after interruption through Runtime.

Only `agent_runtime_coordination_spawn_worker: true` grants recursion.
No metadata field, name, description, or fixed role label grants authority.
Do not use fixed role labels to choose an agent's work.
Describe the actual assignment in its task instead.

Grant `submit_result` only when Runtime supplies that node an independent deliverable check.
Otherwise preserve work in durable artifacts and use only the controls granted to the profile.
Grant only the observation, journal, steering, or stop controls its task needs.
Do not grant a coordination tool because another profile used it.

## Author from evidence

Read the task, workspace state, Runtime journal, relevant artifacts, and prior profiles.
Name the observed reason for a new or changed profile.
Name the result that would support the choice and the result that would reverse it.
Reuse a profile only when its complete instrument fits the assignment.

## Define the instrument

1. Read the current `agentProfileSchema` from the spawn tool or Interface package.
2. Set `harness`, `model.default`, and `model.provider` explicitly before execution; schema-valid planning profiles may omit them.
3. Choose the prompt and capabilities the assignment needs, including tools, MCP servers, permissions, skills, files, and resources.
   Give the task a required artifact, runnable check, named inputs, and stop condition.
4. Validate the profile, choose a stable assignment key, and reserve a deliberate budget.
5. Dispatch the exact profile and task.
6. Compare Runtime's recorded profile identity and materialization receipt with what you authored.

After a refusal, check missing execution settings and the selected execution path before changing capabilities.
Preserve the assignment's required tools, files, and skills while correcting the declaration.
If the configured path cannot carry them, report that execution limitation with the refused profile intact.

## Propagate recursion deliberately

Every spawn-capable profile carries one inline, byte-identical copy of this skill.
Read the mounted `profile-authoring/SKILL.md` and copy its bytes without transcription.
Give a child `spawn_worker` only when its own assignment needs to create descendants.
Give a leaf no Runtime coordination tools unless it must remain a managed node.

## Preserve the boundary

`AgentProfile.tools` freezes named tool permission before launch.
`AgentProfile.mcp` freezes server configuration.
The harness loads only explicitly pinned native extensions.
Ambient machine extensions are not part of the profile.

Record the authored profile identity, materialization receipt, provider and extension versions, and model-visible tool schemas.
Fail before inference when a required declared capability is unavailable.
Runtime owns its generated coordination endpoint, so omit its alias from `profile.mcp`.

The research agent chooses methods, prompts, tools, models, decomposition, experiments, and candidate profiles.
The operator fixes the pursuit, maximum resources, frozen checks, cancellation authority, and activation decision.
Runtime and Sandbox own identity, execution, recovery, accounting, and placement.
Eval owns independent assessment and comparison.
