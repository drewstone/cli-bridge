#!/usr/bin/env tsx
/**
 * verify — health-probe every configured backend, print pass/fail.
 * Run BEFORE `pnpm start` to confirm the CLIs you expect are installed
 * + logged in.
 */

import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const { registry, sessions } = buildApp(config)

  console.log('cli-bridge verify')
  console.log('─'.repeat(60))
  let allOk = true
  for (const b of registry.all()) {
    const h = await b.health()
    const emoji = h.state === 'ready' ? '✓' : h.state === 'unavailable' ? '◦' : '✗'
    console.log(`${emoji} ${b.name.padEnd(14)} ${h.state.padEnd(12)} ${h.detail ?? h.version ?? ''}`)
    if (h.state === 'error') allOk = false
  }
  sessions.close()
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error('verify failed:', err)
  process.exit(1)
})
