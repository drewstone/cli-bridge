export class NetJailProvisionError extends Error {
  readonly code = 'net_jail_unenforceable' as const

  constructor(message: string) {
    super(message)
    this.name = 'NetJailProvisionError'
  }
}
