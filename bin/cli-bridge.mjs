#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { detectLocalSeats, startServer } from '../index.mjs'

try {
  const { values } = parseArgs({ options: { seats: { type: 'boolean' }, 'retire-pools': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) console.log('Usage: cli-bridge [--seats | --retire-pools] [--json]')
  else if (values['retire-pools']) {
    if (values.seats) throw new Error('--retire-pools cannot be combined with --seats')
    const { retirePools } = await import('./retire-pools.mjs')
    const receipt = await retirePools()
    console.log(values.json ? JSON.stringify(receipt) : `Retired ${Object.keys(receipt.slots).length} pool slots; containers and data preserved`)
  } else if (values.seats) {
    const seats = await detectLocalSeats()
    console.log(values.json ? JSON.stringify(seats) : seats.map((seat) =>
      `${seat.harness}: ${seat.status} (${seat.authMode})${seat.fix ? `; run: ${seat.fix}` : ''}`).join('\n'))
  } else if (values.json) throw new Error('--json requires --seats or --retire-pools')
  else await startServer()
} catch (error) {
  const failure = { code: error.code ?? 'BRIDGE_START_FAILED', cause: error.message, fix: 'cli-bridge --help' }
  if (process.argv.includes('--json')) console.log(JSON.stringify(failure))
  else console.error(`cli-bridge: ${failure.cause}; run: ${failure.fix}`)
  process.exitCode = 1
}
