#!/usr/bin/env node
/**
 * BRIDGE_PROXY_SECRET_COMMAND for GitHub (see src/jail/egress.ts).
 *
 *   mint    stdin {key: "github:<owner>/<name>", ttlSeconds?}; prints {secret, expiresAt}.
 *           Mints a single-repo installation token through the Tangle Hub with
 *           contents:write only. The Hub refuses pull_requests:write on this
 *           path on purpose, so a jailed agent can push a branch but cannot open
 *           or merge a PR; the host CLI opens the PR after the run.
 *   revoke  stdin {key, secret}; deletes the installation token at GitHub.
 *
 * TANGLE_API_KEY is the owner's Hub key. Output carries a credential: print
 * nothing else, and never echo the token in an error.
 */

const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com'])
const HUB_MINT_URL = process.env.TANGLE_HUB_URL ?? 'https://id.tangle.tools/v1/hub/github-app/mint-installation-token'

const verb = process.argv[2]
const input = JSON.parse(await readStdin())

if (verb === 'mint') {
  const repo = /^github:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/u.exec(String(input.key))?.[1]
  if (!repo) fail('secretRef.key must be github:<owner>/<name>')
  // The binding's hosts decide where iron-proxy presents the token; a GitHub token goes only to GitHub.
  const hosts = Array.isArray(input.hosts) ? input.hosts : []
  if (!hosts.length || hosts.some((host) => !GITHUB_HOSTS.has(host))) fail(`hosts must be within ${[...GITHUB_HOSTS].join(', ')}`)
  if (!process.env.TANGLE_API_KEY) fail('TANGLE_API_KEY is unset')
  const response = await fetch(HUB_MINT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TANGLE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      repoUrl: `https://github.com/${repo}`,
      permissions: { contents: 'write' },
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({}))
  const minted = body.data ?? {}
  if (!response.ok || typeof minted.token !== 'string') fail(`Hub mint refused: ${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`)
  process.stdout.write(JSON.stringify({ secret: minted.token, expiresAt: minted.expiresAt }))
} else if (verb === 'revoke') {
  const response = await fetch('https://api.github.com/installation/token', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.secret}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  })
  // 401 means the token already expired or was revoked.
  if (response.status !== 204 && response.status !== 401) fail(`GitHub revoke failed: ${response.status}`)
} else {
  fail('usage: proxy-secret-github.mjs mint|revoke < input.json')
}

function fail(message) {
  process.stderr.write(`proxy-secret-github: ${message}\n`)
  process.exit(1)
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}
