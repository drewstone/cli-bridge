# Three-turn local evidence proof

The opt-in `evidence` scenario uses the maintained live proof's authenticated
loopback HTTP bridge, fresh HOME/XDG directories, Linux filesystem jail, evidence
capture and owned-process cleanup. It does not use host model credentials or an
externally started daemon. The default `filesystem` scenario still makes its
existing two turns; selecting `evidence` runs only the three turns below.

Use a supported Linux host with working bubblewrap and the checksum-pinned
OpenCode installer in `.github/workflows/live-inference.yml`. That workflow owns
the executable version and checksum. `OPENCODE_BIN` selects the installed binary;
the scenario checks its reported version against that pin before inference.
Install this repository's pinned dependencies through the admitted gate path.

The source supports the named anonymous `opencode/glm-5.3-flash-free` route only.
Before executing it, obtain the operator's supported-host and centralized-slot
admission and retain current [OpenCode pricing](https://opencode.ai/v2/docs/console/models/)
showing that the route and every token category are free. If that evidence is
unavailable or the provider changes its price, stop before inference. A model
name or catalogue listing alone does not establish the permitted cost.

After those admissions, from the repository root:

```sh
CLI_BRIDGE_REAL_OPENCODE_TESTS=1 \
CLI_BRIDGE_LIVE_SCENARIO=evidence \
CLI_BRIDGE_LIVE_MODEL=opencode/glm-5.3-flash-free \
pnpm test:local-inference
```

`CLI_BRIDGE_LIVE_OUT` selects a new private evidence directory. Each turn has a
120-second deadline. This is a three-user-turn allowance, not permission for the
default scenario as an additional run. Main, small, title, summary and compaction
models are pinned to the same selected route, and the provider model whitelist
contains only that model. There is no paid fallback. These config fields and
agent overrides were checked against the installer's pinned OpenCode
[schema](https://github.com/anomalyco/opencode/tree/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/v1/config)
and [agent implementation](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/agent/agent.ts#L267).
The scenario checks the effective config and available model list before starting
the bridge. Auxiliary work, when OpenCode performs it, uses that same route.

1. Read synthetic evidence through the native read tool, returning its random
   matter code, claimed amount, possible cap and unverified applicability.
2. After restarting the actual bridge, resume the same native session and return
   the matter code without tools, source replay or the code in the new prompt.
3. Read amended evidence with a new random revision code, distinguishing the
   previous cap, amended cap and still-unassessed recovery.

Every turn requires nonzero measured input/output tokens, matching reported model
identity and a nonempty parseable answer. Turns one and three require observed
tool calls; turn two requires zero. Every turn tears down its owned Runtime run
and asserts `destroyed`. The receipt also verifies native session continuity,
retains fixture hashes and Runtime artifacts, then cleans owned scratch after
process shutdown. Unknown billed cost stays unknown rather than being invented
from model selection. A health check, blocked preflight or catalogue listing
never counts as a successful proof.

This qualifies only synthetic local Runtime/CLI-Bridge/OpenCode execution when
it passes. It does not qualify Casework, authenticated Agent App browser flows,
legal calibration, managed sandboxes, cloud trace custody or design preview.
The source integration itself is not evidence that inference has completed.
