# Deploying cli-bridge

Two supported shapes: Docker (recommended) and systemd bare-metal. Both
assume you're deploying to **your own** dev machine or personal remote
box — cli-bridge is not designed for multi-user serving.

---

## Docker (recommended)

```bash
# on the target host
git clone https://github.com/drewstone/cli-bridge.git /srv/cli-bridge
cd /srv/cli-bridge
cp .env.example .env
# edit .env — set BRIDGE_BEARER if binding non-loopback

# Log into the CLI(s) ON THE HOST first — the container mounts ~/.claude
# read-write, so one host login is enough. Inside the container is too
# late (the OAuth flow needs a browser).
claude /login

docker compose -f docker/compose.yml up -d --build
curl -fsS http://127.0.0.1:3344/health
```

## Remote: Hetzner box behind Caddy

If you want to hit cli-bridge from a phone / laptop / CI:

1. Bind loopback in `docker/compose.yml` (the default).
2. Set `BRIDGE_BEARER` to a random 32-byte hex string.
3. Add a Caddy site that terminates TLS, forwards to `127.0.0.1:3344`,
   and requires an `Authorization: Bearer …` header.
4. Mount the Caddy config + cli-bridge compose as siblings under `/srv`,
   e.g. the same layout as `tangle-router`.

Example Caddyfile fragment:

```caddy
bridge.drewstone.dev {
    # strip + forward only if bearer matches — never pass unverified
    @authed header Authorization "Bearer {env.EXPECTED_BEARER}"
    handle @authed {
        reverse_proxy 127.0.0.1:3344 {
            header_up -Authorization
        }
    }
    respond 401
}
```

The header strip + re-check makes cli-bridge's own bearer the second
factor; Caddy does the first. If one layer fails, the other still
catches.

## systemd (bare-metal, no Docker)

```bash
sudo mkdir -p /srv/cli-bridge
sudo chown $USER:$USER /srv/cli-bridge
git clone https://github.com/drewstone/cli-bridge.git /srv/cli-bridge
cd /srv/cli-bridge
pnpm install --prod
cp .env.example .env
# edit .env

# Install the systemd unit (template form lets you run multiple
# instances under different users if you want)
sudo cp deploy/cli-bridge.service /etc/systemd/system/cli-bridge@.service
sudo systemctl daemon-reload
sudo systemctl enable --now cli-bridge@$USER
sudo journalctl -u cli-bridge@$USER -f
```

## Sanity checks after deploy

```bash
# Health
curl -fsS http://127.0.0.1:3344/health

# Model catalog
curl -fsS http://127.0.0.1:3344/v1/models | jq

# First real call (replace bearer if configured)
curl -sS http://127.0.0.1:3344/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: smoke' \
  -d '{"model":"claude","messages":[{"role":"user","content":"ping"}],"stream":false}' | jq
```

## Updating

```bash
cd /srv/cli-bridge
git pull
pnpm install
# Docker:
docker compose -f docker/compose.yml up -d --build
# systemd:
sudo systemctl restart cli-bridge@$USER
```

## Gotchas

- **Claude Code auth expires periodically.** If `/health` reports the
  Claude backend as `error` after weeks of uptime, re-run `claude /login`
  on the host. The container picks up the new token on next call.
- **better-sqlite3 native binding.** First `pnpm install` must build it;
  if your host's glibc differs from the image's, the Docker build
  rebuilds in-container. No action needed unless you see
  `Could not locate the bindings file` in logs.
- **OAuth and headless hosts.** If the box has no browser, do `claude
  /login` from a laptop, then rsync `~/.claude` to the host. The token
  is portable across machines as long as the OS type matches.

## Pi version and retained sessions

The maintained Pi installer selects 1.0.2, the version exercised by
`tests/pi-native-handled-real.test.ts`. Retained handled-input completion
requires its explicit `data.disposition: "handled"` response. Pi 0.87.1 returns
an ordinary success response for both handled and started inputs, so the
bridge cannot safely interpret that response as completion. Never treat a
missing disposition as handled.

On a host with other Pi consumers, install into a service-owned prefix through
the existing installer instead of replacing their shared executable:

```bash
pi_prefix=/srv/cli-bridge/harnesses/pi-1.0.2
npm_config_prefix="$pi_prefix" pnpm install:harness pi
"$pi_prefix/bin/pi" --version
```

Set `PI_BIN` to that absolute executable in this bridge's owning service
configuration. A retained request cannot select a different service binary.
Keep a shared environment file and other services' PATHs unchanged. If a
wrapper also loads an environment file, check that it does not overwrite the
service-specific `PI_BIN`.

For a private npm install, add
`$pi_prefix/lib/node_modules/@earendil-works/pi-coding-agent` to the service's
existing `BRIDGE_JAIL_RO_PATHS` list. Pi's extension loader needs its installed
`jiti` dependency beside the bundled CLI. Bind only this credential-free
package tree read-only, never its parent home, provider configuration, or
session directories. This operator bind is visible to every fs-jailed worker;
it does not enable or lower the jail floor. A retained host request can raise
its own confinement with `execution.jail.mode=fs-jail` and a scratch root.

Use the registered deployer's idle check before replacing the service: admitted
and queued requests, executor work, and retained sessions must be drained by
their owner. Retain the prior binary and configuration for rollback. The
checkout revision, selected binary, and `/health` version are deployment
evidence; they do not prove a retained turn completed.

Before claiming adoption, run two owned handled inputs through the retained
HTTP API and retain terminal completion and same-child reuse. Use an explicit
input extension that returns `action: "handled"`, preserving its extension
events. Ordinary model responses do not qualify for this regression proof.
The earlier zero-loopback-request native fixture is useful qualification, not
a requirement to add an inference-free transport to the retained API.
Use an authorized configured route with verified resource limits to initialize
the native child. Handled input requires no model response, so a null served
model is expected. Do not add a paid fallback or weaken the filesystem jail.
Bound the proof to one owned session, two serial inputs, and 90 seconds; cancel
unexpected model/tool activity and close only the proof session. Record
observed usage and unknown counters honestly rather than infer zero billing
from missing events.
