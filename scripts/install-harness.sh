#!/usr/bin/env sh
set -eu

harness="${1:-}"
if [ -z "$harness" ]; then
  echo "usage: scripts/install-harness.sh <claude|codex|opencode|kimi|gemini|pi|prime|all>" >&2
  exit 2
fi

install_claude() {
  npm install -g @anthropic-ai/claude-code@latest
}

install_codex() {
  npm install -g @openai/codex@latest
}

install_opencode() {
  curl -fsSL https://opencode.ai/install | bash
  if [ -x "${HOME:-/root}/.opencode/bin/opencode" ]; then
    mkdir -p /usr/local/bin 2>/dev/null || true
    cp "${HOME:-/root}/.opencode/bin/opencode" /usr/local/bin/opencode 2>/dev/null \
      && chmod +x /usr/local/bin/opencode 2>/dev/null \
      || true
  fi
}

install_kimi() {
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  uv_bin="$(command -v uv || true)"
  if [ -z "$uv_bin" ] && [ -x "${HOME:-/root}/.local/bin/uv" ]; then
    uv_bin="${HOME:-/root}/.local/bin/uv"
  fi
  if [ -z "$uv_bin" ]; then
    echo "uv install did not produce a uv binary on PATH or ~/.local/bin" >&2
    exit 1
  fi
  "$uv_bin" tool install --python 3.13 kimi-cli
  if [ -x "${HOME:-/root}/.local/bin/kimi" ]; then
    mkdir -p /usr/local/bin 2>/dev/null || true
    ln -sf "${HOME:-/root}/.local/bin/kimi" /usr/local/bin/kimi 2>/dev/null || true
    ln -sf "$uv_bin" /usr/local/bin/uv 2>/dev/null || true
  fi
}

install_gemini() {
  npm install -g @google/gemini-cli@latest
}

install_pi() {
  npm install -g @earendil-works/pi-coding-agent@latest
}

# prime-agent is a hard FORK of pi that reuses pi's npm name. The registry
# serves the upstream pi line under that name (`npm view
# @earendil-works/pi-coding-agent version` -> 0.84.x; the fork's 0.7.x versions
# do not exist there), and the two are wire-incompatible: different daemon
# schema, different config dir, different agent-dir env var. Installing from
# the registry would put upstream pi on PATH under a prime-looking name, and
# every fork-verified claim in src/backends/prime.ts would then be asserted
# against the wrong agent. So this builds from source and exposes the built
# entrypoint as `prime-agent` — the name PRIME_BIN defaults to.
install_prime() {
  if ! command -v node >/dev/null 2>&1; then
    echo "prime-agent needs node >= 22.8 to build; install node first" >&2
    exit 1
  fi
  src_dir="${PRIME_SRC_DIR:-${HOME:-/root}/.cache/cli-bridge/prime-agent}"
  if [ -d "$src_dir/.git" ]; then
    git -C "$src_dir" fetch --tags origin
  else
    mkdir -p "$(dirname "$src_dir")"
    git clone https://github.com/PrimeIntellect-ai/prime-agent "$src_dir"
  fi
  # Pin the commit src/backends/prime.ts is verified against unless the
  # operator names another; an unpinned build silently changes the contract.
  git -C "$src_dir" checkout "${PRIME_AGENT_REF:-be9e2fa0}"
  (cd "$src_dir" && npm install && npm run build)
  entry="$src_dir/packages/coding-agent/dist/bundle/cli.js"
  if [ ! -f "$entry" ]; then
    echo "prime-agent build produced no $entry" >&2
    exit 1
  fi
  mkdir -p /usr/local/bin 2>/dev/null || true
  printf '#!/usr/bin/env sh\nexec node "%s" "$@"\n' "$entry" > /usr/local/bin/prime-agent
  chmod +x /usr/local/bin/prime-agent
  echo "installed prime-agent -> $entry (do NOT install it as \`pi\`)"
}

install_one() {
  case "$1" in
    claude) install_claude ;;
    codex) install_codex ;;
    opencode) install_opencode ;;
    kimi) install_kimi ;;
    gemini) install_gemini ;;
    pi) install_pi ;;
    prime) install_prime ;;
    *) echo "unknown harness: $1" >&2; exit 2 ;;
  esac
}

# `all` stays registry-installable on purpose: prime is a source build (clone +
# npm build) and is requested by name.
if [ "$harness" = "all" ]; then
  for name in claude codex opencode kimi gemini pi; do
    echo "==> installing $name"
    install_one "$name"
  done
else
  install_one "$harness"
fi
