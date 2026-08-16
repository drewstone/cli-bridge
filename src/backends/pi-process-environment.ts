import { parseSafeRetainedEnv } from '../sessions/retained/contract.js'

const PI_INHERITED_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'PWD',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'PNPM_HOME',
  'NODE_PATH',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_TELEMETRY',
] as const

/** Build a Pi child environment from a neutral allowlist and request-owned values. */
export function piToolProcessEnvironment(
  inherited: NodeJS.ProcessEnv,
  requestValues: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const key of PI_INHERITED_ENV_KEYS) {
    const value = inherited[key]
    if (typeof value === 'string' && value.length > 0) child[key] = value
  }
  const safeRequestValues = parseSafeRetainedEnv(
    Object.fromEntries(
      Object.entries(requestValues).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  )
  for (const [key, value] of Object.entries(safeRequestValues)) child[key] = value
  return child
}
