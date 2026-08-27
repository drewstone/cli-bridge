import type { ExecutorFinding } from './types.js'

export interface DockerPreflightMount {
  source: string
  target: string
  kind: 'bind' | 'volume'
  credentialFile?: string
}

export interface DockerPreflightTarget {
  backend: string
  envPrefix: string
  image: string
  bin: string
  containerUser?: string | undefined
  containerHome: string
  mounts: DockerPreflightMount[]
  workspaceRoot?: string | undefined
  buildCommand: string
}

export type PreflightFinding = ExecutorFinding
export type PreflightScope = 'full' | 'credentials' | 'request-path'
