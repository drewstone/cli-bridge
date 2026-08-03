import { startServer } from './server/lifecycle.js'

export { buildApp } from './server/app.js'
export { startServer } from './server/lifecycle.js'
export type { BuildAppExtras, BuiltServer, StartServerOptions } from './server/types.js'

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer()
}
