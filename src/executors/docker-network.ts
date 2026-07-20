const DOCKER_NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u

/**
 * Accept the portable subset of Docker network names used by the CLI.
 * Keeping this to one argv-safe token also excludes network modes such as
 * `container:<id>`, which would couple a pool slot to another container.
 */
export function assertDockerNetworkName(value: string, label = 'Docker network'): string {
  if (!DOCKER_NETWORK_NAME.test(value)) {
    throw new Error(
      `invalid ${label}: expected 1-255 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit`,
    )
  }
  return value
}
