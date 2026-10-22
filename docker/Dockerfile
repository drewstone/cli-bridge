FROM node:24.22.1-trixie-slim AS base
WORKDIR /app

# Build toolchain + CLI-install prereqs. curl is needed for the opencode
# installer; git + python3 + make + g++ are for native addon compiles.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
       python3 make g++ curl git ca-certificates unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# --- CLI backends ---
# Install each vendor CLI globally so the backends can spawn them. Users
# still need to run the `*/login` flow inside the container once per
# subscription — see deploy/runbook.md.

# Claude Code (npm package)
RUN npm install -g @anthropic-ai/claude-code@latest

# OpenAI Codex
RUN npm install -g @openai/codex@latest

# opencode (official installer writes to ~/.opencode/bin). Copy the
# binary to /usr/local/bin so it survives the /root/.opencode volume
# mount the runtime layers in (the installer's bin dir otherwise
# gets shadowed by the empty host mount on first boot).
RUN curl -fsSL https://opencode.ai/install | bash \
  && cp /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && chmod +x /usr/local/bin/opencode

# Moonshot's official Kimi CLI — distributed as a uv-installed Python
# tool (`uv tool install kimi-cli`). The installer drops uv at
# ~/.local/bin/uv but PATH doesn't pick that up during the RUN shell,
# so we do it in two steps: install uv explicitly, then run uv tool
# install with an absolute path. Symlink both into /usr/local/bin so
# they're on PATH at runtime AND survive the /root/.kimi volume mount
# (which only covers auth state).
COPY scripts/install-harness.sh scripts/python-security-overrides.txt /usr/local/share/cli-bridge/
RUN sh /usr/local/share/cli-bridge/install-harness.sh kimi

# Factory droid, Sourcegraph amp, Forge left out by default — install
# manually on hosts that need them. They change rapidly.

# --- App install ---
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tests/runtime-consumer/package.json tests/runtime-consumer/
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate \
  && pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm typecheck

# Native addons are built; keep only the runtime libraries in the serving image.
RUN apt-get purge -y --auto-remove make g++

ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=3344
ENV BRIDGE_DATA_DIR=/data
VOLUME /data

# OAuth / session state for each CLI, mounted read-write by the host so
# `claude /login` etc. done on the host propagate into the container and
# survive recreates.
VOLUME /root/.claude
VOLUME /root/.codex
VOLUME /root/.config/opencode
VOLUME /root/.opencode
VOLUME /root/.kimi
VOLUME /root/.config/kimi

EXPOSE 3344
CMD ["pnpm", "start"]
