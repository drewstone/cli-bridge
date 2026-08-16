/**
 * Per-run bookkeeping for outstanding provider dialogs.
 *
 * Four disjoint sets answer the only questions a responder can ask: is this
 * dialog still outstanding, is someone already answering it, was it already
 * answered (and with what bytes), and was it withdrawn. Keeping them apart is
 * what lets a duplicate response be told from a late one.
 */

import type { PendingRunInteraction } from './types.js'

export class RunInteractionLedger {
  private readonly pending = new Map<string, PendingRunInteraction>()
  private readonly resolving = new Set<string>()
  private readonly resolved = new Set<string>()
  private readonly resolvedDigests = new Map<string, string>()
  private readonly cancelled = new Set<string>()
  private readonly effectUnknown = new Set<string>()

  register(interaction: PendingRunInteraction): void {
    if (this.effectUnknown.has(interaction.request.id)) return
    this.pending.set(interaction.request.id, interaction)
  }

  get(id: string): PendingRunInteraction | null {
    return this.pending.get(id) ?? null
  }

  /** Claim one interaction so distinct operation ids cannot answer it twice. */
  claim(id: string): PendingRunInteraction | null {
    const pending = this.pending.get(id)
    if (!pending || this.resolving.has(id) || this.effectUnknown.has(id)) return null
    this.resolving.add(id)
    return pending
  }

  releaseClaim(id: string): void {
    this.resolving.delete(id)
  }

  isResolving(id: string): boolean {
    return this.resolving.has(id)
  }

  resolve(id: string, responseDigest?: string): void {
    this.resolving.delete(id)
    this.pending.delete(id)
    // A resolved native response is proof that the side effect won. Explicit
    // cancellation is serialized behind this method, so only an unrelated
    // terminal notification can have tentatively withdrawn the interaction.
    this.cancelled.delete(id)
    this.resolved.add(id)
    if (responseDigest) this.resolvedDigests.set(id, responseDigest)
  }

  wasResolved(id: string): boolean {
    return this.resolved.has(id)
  }

  resolvedDigest(id: string): string | null {
    return this.resolvedDigests.get(id) ?? null
  }

  wasCancelled(id: string): boolean {
    return this.cancelled.has(id)
  }

  /** Permanently close an interaction whose native effect may have applied. */
  markEffectUnknown(id: string): void {
    this.pending.delete(id)
    this.resolving.delete(id)
    this.effectUnknown.add(id)
  }

  wasEffectUnknown(id: string): boolean {
    return this.effectUnknown.has(id)
  }

  /**
   * Withdraw every outstanding dialog. `publish` records the withdrawal
   * durably and is invoked between marks, so a subscriber woken by one
   * withdrawal sees exactly the state the un-batched sequence produced. The
   * first publish failure is rethrown after every dialog has been withdrawn.
   */
  cancelAll(reason: string, publish: ((id: string, reason: string) => void) | null): void {
    if (this.pending.size === 0) return
    let failure: unknown
    for (const id of this.pending.keys()) {
      this.pending.delete(id)
      this.resolving.delete(id)
      this.cancelled.add(id)
      if (!publish) continue
      try {
        publish(id, reason)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }
}
