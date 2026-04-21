FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl git \
  && rm -rf /var/lib/apt/lists/*

# Install claude-code CLI globally so the Claude backend can spawn it.
# Codex + opencode not installed by default — uncomment if you need them.
RUN npm install -g @anthropic-ai/claude-code@latest

# App deps + build
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
# Expect the operator to mount the host's ~/.claude as /root/.claude so
# the subprocess inherits the same auth. Without this mount, the first
# `/v1/chat/completions` call will trigger `claude login` inside the
# container (which you don't want — run `claude /login` on the host and
# mount ~/.claude read-write instead).
VOLUME /root/.claude

EXPOSE 8787
CMD ["pnpm", "start"]
