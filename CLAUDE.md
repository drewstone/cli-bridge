# cli-bridge

This service exposes local agent backends through HTTP APIs.
Read [README.md](README.md) for API usage and [src/config.ts](src/config.ts) for supported configuration.
Backend implementations under [src/backends/](src/backends/) own command invocation and streaming behavior.
Do not assume all backends use the same flags or session protocol.

Preserve the bearer requirement for non-loopback binding and the session identity checks at request boundaries.
For deployment, read [deploy/README.md](deploy/README.md) and verify the target's actual configuration.

Use Conventional Commits and the configured Git identity, without co-authorship or tool-attribution trailers.
Push feature branches and use a reviewed PR; do not push directly to `main`.
