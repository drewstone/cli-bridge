import { tsImport } from 'tsx/esm/api'

const server = await tsImport('./src/server.ts', import.meta.url)
export const { loadConfig, localBackends, startServer, detectLocalSeats, listLocalModels } = server
