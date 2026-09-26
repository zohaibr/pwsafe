// Clipboard copy in the main process (§A4.8, §B5). The value never reaches the renderer. The
// clipboard is cleared CLIPBOARD_CLEAR_MS after the copy, on lock and on quit, and only when it
// still holds the value we put there (so something the user copied since is left alone).
import { CLIPBOARD_CLEAR_MS } from '../../shared/limits'

/** Electron's clipboard (async since Electron 44) or a test double. */
export interface ClipboardLike {
  readText(): Promise<string> | string
  writeText(text: string): Promise<void> | void
}

export interface Timers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // Never keep the process alive just for a pending clear.
    if (typeof t === 'object' && t !== null && 'unref' in t) t.unref()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class ClipboardGuard {
  private copied: string | undefined
  private timer: unknown
  /** Clipboard operations run one at a time, in call order. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly clipboard: ClipboardLike,
    private readonly timers: Timers = realTimers,
    private readonly clearMs: number = CLIPBOARD_CLEAR_MS,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => {})
    return next
  }

  /** Copies `value`; returns when it will be cleared. Copying again restarts the timer. */
  copy(value: string): Promise<{ clearsAt: number }> {
    return this.serial(async () => {
      this.cancelTimer()
      await this.clipboard.writeText(value)
      this.copied = value
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined
        void this.clearIfOurs()
      }, this.clearMs)
      return { clearsAt: this.timers.now() + this.clearMs }
    })
  }

  /** Clears now (lock, quit) if the clipboard still holds our value. Never rejects. */
  clearIfOurs(): Promise<void> {
    return this.serial(async () => {
      this.cancelTimer()
      const ours = this.copied
      this.copied = undefined
      if (ours === undefined) return
      try {
        if ((await this.clipboard.readText()) === ours) await this.clipboard.writeText('')
      } catch {
        // Clipboard not available (headless); nothing we can do.
      }
    })
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }
}
