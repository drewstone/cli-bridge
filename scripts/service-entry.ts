#!/usr/bin/env tsx
/**
 * systemd entrypoint for cli-bridge.
 *
 * Keep the service command line distinct from application dev servers such as
 * `tsx src/server.ts`. Some ADC cleanup paths use broad process patterns for
 * dev servers; running the bridge through this wrapper keeps the long-lived
 * shared bridge out of that blast radius while preserving the normal server
 * startup path.
 */

import { startServer } from '../src/server.js'

await startServer()
