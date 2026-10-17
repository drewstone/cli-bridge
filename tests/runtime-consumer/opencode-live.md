# Real local OpenCode check

Use the existing stack, not a new server or simulated model:

```
Runtime bridge executor -> localhost:3344 -> OpenCode -> selected provider/model
```

Run on the same machine as CLI-Bridge. Install the repo's pinned dependencies and OpenCode normally. Select an exact model from `opencode models` and verify its access and pricing in your own account. There is no default model and no fallback. Hosting the harness locally does not host its model weights locally.

From the repo root, in the first terminal:

```sh
pnpm install --frozen-lockfile
opencode models
BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=3344 BRIDGE_BACKENDS=opencode \
  OPENCODE_EXECUTOR=host BRIDGE_DATA_DIR="$(mktemp -d)" pnpm start
```

In a second terminal, select the same exact `provider/model` shown by OpenCode:

```sh
export OPENCODE_MODEL='opencode/glm-5.3-flash' # example; verify access/price first
# Supply BRIDGE_BEARER here if the bridge requires it. Never commit that value.
node tests/runtime-consumer/opencode-live.mjs
node tests/runtime-consumer/opencode-live.mjs --run
```

The first command checks prerequisites without model inference. Only `--run` authorizes inference, and the selected account may be charged. Each turn has a 120-second deadline, configurable with `--timeout-ms`; this is not a hard dollar cap. Existing operator jail and credential policy is not disabled or modified. No production service is contacted except the selected model provider through OpenCode. Run in a dedicated development account/environment, never against client matters.

The live path imports the Runtime already pinned by this consumer workspace. It makes three real turns with no transport interception or fake backend:

1. Read a temporary synthetic matter through OpenCode's native read tool. The file contains a random matter code not supplied in the prompt.
2. Resume the same bridge session and return that code without calling tools or replaying the file in the new prompt.
3. Read updated evidence containing another random code. Report the old and amended caps separately, leaving recovery unassessed.

A pass requires matching answers, actual tool-call counts, nonzero measured input/output tokens, and a matching reported model. Unknown dollar cost stays unknown. Gateway-reported identity is not independent verification of provider model weights. A successful `/health` alone never passes the test. Errors, missing dependencies, model substitutions, and blocked prerequisites return nonzero.

The command prints its private evidence directory with a `proof.json`, full Runtime artifacts, fixture hashes, script hash, and package/CLI identity. It preserves the synthetic working directory and bridge session for inspection; remove them after review. Run `--help` for options. The script does not install dependencies, modify credentials, start an extra execution framework, or run on ordinary CI automatically.

This proves a narrow local execution path when successful. It does **not** prove the authenticated Casework app, background reassessment, browser streaming/reload/stop, a managed sandbox, or the design preview's backend integration. Those must use the application's real producers and case tools; changing a model URL alone does not move a sandbox-owned workflow onto the local bridge.
