import { tsImport } from 'tsx/esm/api'

const server = await tsImport('./src/server.ts', import.meta.url)
export const { loadConfig, startServer, detectLocalSeats, listLocalModels } = server
