FROM node:22-slim AS base
WORKDIR /app

# Build toolchain + CLI-install prereqs. curl is needed for the opencode
# installer; git + python3 + make + g++ are for native addon compiles.
RUN apt-get update \
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

# Moonshot's official Kimi CLI — the legit path to Kimi For Coding.
# Installer default lands the binary under the user's home; we copy it
# out to /usr/local/bin for the same volume-shadow reason as opencode.
RUN curl -LsSf https://code.kimi.com/install.sh | bash \
  && if [ -x /root/.kimi/bin/kimi ]; then cp /root/.kimi/bin/kimi /usr/local/bin/kimi; \
     elif [ -x /root/.local/bin/kimi ]; then cp /root/.local/bin/kimi /usr/local/bin/kimi; \
     fi \
  && chmod +x /usr/local/bin/kimi || true

# Factory droid, Sourcegraph amp, Forge left out by default — install
# manually on hosts that need them. They change rapidly.

# --- App install ---
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10 --activate \
  && pnpm install --frozen-lockfile --prod=false \
  && pnpm rebuild better-sqlite3
COPY . .
RUN pnpm typecheck

ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=8787
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

EXPOSE 8787
CMD ["pnpm", "start"]
