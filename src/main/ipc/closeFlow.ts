// Quit and close-window with unsaved changes (§B3, PsafeApi.onCloseRequested / respondToClose).
// Main asks the renderer, which shows Save / Don't save / Cancel (or, while locked, Unlock and
// save / Quit without saving / Cancel) and answers. 'save' means the renderer already saved.
// Nothing is closed until the answer arrives, so unsaved changes are never lost silently.

export type CloseReason = 'quit' | 'close-window'
export type CloseChoice = 'save' | 'discard' | 'cancel'

export interface CloseFlowDeps {
  /** Unsaved changes, including those kept in memory while locked. */
  dirtyCount(): number
  /** Sends onCloseRequested to the renderer. Returns false when there is no window to ask. */
  ask(reason: CloseReason): boolean
  /** Brings the window to the front (a second quit while we are already asking). */
  focus(): void
  /** Really closes: clear clipboard, close the vault (releases .plk), then quit or close. */
  proceed(reason: CloseReason): Promise<void>
  log?(message: string): void
}

export class CloseFlow {
  private pending: CloseReason | undefined
  private proceeding = false
  private queued: CloseReason | undefined

  constructor(private readonly deps: CloseFlowDeps) {}

  get pendingReason(): CloseReason | undefined {
    return this.pending
  }

  /**
   * The user asked to quit or close the window (the caller has already prevented the default).
   * Asks the renderer when there are unsaved changes, otherwise goes ahead.
   */
  async request(reason: CloseReason): Promise<void> {
    if (this.proceeding) {
      // For example window-all-closed → quit while the window is still closing.
      if (reason === 'quit' || !this.queued) this.queued = reason
      return
    }
    if (this.pending) {
      // Quit while a close-window question is open upgrades it to quit.
      if (reason === 'quit') this.pending = 'quit'
      this.deps.focus()
      return
    }
    if (this.deps.dirtyCount() > 0 && this.deps.ask(reason)) {
      this.pending = reason
      return
    }
    await this.go(reason)
  }

  /** The renderer's answer. An answer with no question pending is ignored. */
  async respond(choice: CloseChoice): Promise<void> {
    const reason = this.pending
    if (!reason) return
    this.pending = undefined
    if (choice === 'cancel') return
    if (choice === 'save' && this.deps.dirtyCount() > 0) {
      // The renderer said it saved but changes remain (for example an edit raced the save).
      this.deps.log?.('close: renderer answered save but changes remain; not closing')
      return
    }
    await this.go(reason)
  }

  private async go(reason: CloseReason): Promise<void> {
    this.proceeding = true
    try {
      await this.deps.proceed(reason)
    } finally {
      this.proceeding = false
    }
    const next = this.queued
    this.queued = undefined
    if (next) await this.request(next)
  }
}
