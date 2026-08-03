import type { JailWritableEnvironment } from './types.js'

const PI_WRITABLE_STATE: readonly JailWritableEnvironment[] = [
  { envVar: 'PI_CODING_AGENT_SESSION_DIR', jailRel: '.pi/sessions' },
]

/** Backend state paths that must be redirected whenever confinement is active. */
export function writableEnvironmentFor(backendName: string): readonly JailWritableEnvironment[] {
  return backendName === 'pi' ? PI_WRITABLE_STATE : []
}
