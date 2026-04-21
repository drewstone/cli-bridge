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
curl -fsS http://127.0.0.1:8787/health
```

## Remote: Hetzner box behind Caddy

If you want to hit cli-bridge from a phone / laptop / CI:

1. Bind loopback in `docker/compose.yml` (the default).
2. Set `BRIDGE_BEARER` to a random 32-byte hex string.
3. Add a Caddy site that terminates TLS, forwards to `127.0.0.1:8787`,
   and requires an `Authorization: Bearer …` header.
4. Mount the Caddy config + cli-bridge compose as siblings under `/srv`,
   e.g. the same layout as `tangle-router`.

Example Caddyfile fragment:

```caddy
bridge.drewstone.dev {
    # strip + forward only if bearer matches — never pass unverified
    @authed header Authorization "Bearer {env.EXPECTED_BEARER}"
    handle @authed {
        reverse_proxy 127.0.0.1:8787 {
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
curl -fsS http://127.0.0.1:8787/health

# Model catalog
curl -fsS http://127.0.0.1:8787/v1/models | jq

# First real call (replace bearer if configured)
curl -sS http://127.0.0.1:8787/v1/chat/completions \
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
