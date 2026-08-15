export class RunAdmissionClosedError extends Error {
  readonly code = 'run_admission_closed' as const

  constructor() {
    super('run admission is closed because cli-bridge is shutting down')
    this.name = 'RunAdmissionClosedError'
  }
}

/** Synchronous process-lifecycle boundary shared by every run producer. */
export class RunAdmission {
  private open = true

  close(): void {
    this.open = false
  }

  assertOpen(): void {
    if (!this.open) throw new RunAdmissionClosedError()
  }
}
