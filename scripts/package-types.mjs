import { readFile, writeFile } from 'node:fs/promises'

const server = await readFile(new URL('../types/server.d.ts', import.meta.url), 'utf8')
const signature = server.match(/^export declare function startServer\([^;]+;/m)?.[0]
if (!signature) throw new Error('The emitted Bridge server declaration has no startServer signature')
await writeFile(new URL('../types/package.d.ts', import.meta.url), [
  "import type { BridgeServer, StartServerOptions } from './server-options.js';",
  "export { loadConfig } from './config.js';",
  "export type { BridgeServer, StartServerOptions } from './server-options.js';",
  signature,
  '',
].join('\n'))
