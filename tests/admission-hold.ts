import type { AdmissionClass, AdmissionGate } from '../src/admission.js'

let nextHoldId = 0

export interface Hold {
  /**
   * End the held job, which is what makes the gate release the slot. Resolves
   * once the gate has taken the slot back: the gate's release is chained to
   * this promise first, so its handler runs before the awaiting caller's.
   */
  end(): Promise<void>
}

/**
 * Hold one admission slot the way a running job holds it.
 *
 * The gate exposes no release, so a test ends a hold by ending the job the slot
 * was charged to — the same contract the chat route uses. The returned promise
 * pends while the caller is queued and rejects with the gate's typed rejection,
 * so ordering and refusal assertions read exactly as they do against `acquire`.
 */
export async function holdSlot(
  gate: AdmissionGate,
  admissionClass: AdmissionClass = 'bulk',
  signal?: AbortSignal,
): Promise<Hold> {
  const id = `held-${nextHoldId++}`
  let finished = false
  let endJob!: () => void
  const job = new Promise<void>((resolve) => { endJob = resolve })
  const slot = await gate.acquire({
    work: { id, isFinished: () => finished },
    admissionClass,
    ...(signal ? { signal } : {}),
  })
  slot.holdUntil(job)
  return {
    end: () => {
      finished = true
      endJob()
      return job
    },
  }
}
