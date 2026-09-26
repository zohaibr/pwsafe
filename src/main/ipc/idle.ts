// Idle auto-lock timer (§B2). Runs only while a vault is open; the renderer reports activity
// (throttled) and each report restarts the countdown.
import type { Timers } from './clipboard'

export class IdleLock {
  private timer: unknown
  private running = false

  constructor(
    private readonly timers: Timers,
    private readonly minutes: () => number,
    private readonly onIdle: () => void,
  ) {}

  /** Starts (or restarts) the countdown. */
  start(): void {
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    this.cancel()
  }

  /** User activity: restart the countdown if it is running. */
  activity(): void {
    if (this.running) this.schedule()
  }

  get isRunning(): boolean {
    return this.running
  }

  private schedule(): void {
    this.cancel()
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      this.running = false
      this.onIdle()
    }, this.minutes() * 60_000)
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }
}
