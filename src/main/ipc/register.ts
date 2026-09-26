// Binds the controller's handlers to ipcMain. Every message is checked to come from our own
// window's main frame showing our own page; anything else gets INVALID_ARGUMENT and no work.
import { DEFAULT_MESSAGES, ErrorCode, fail } from '../../shared/errors'
import { IpcChannel } from '../../shared/ipc'
import type { Controller, InvokeChannel } from './controller'

/** The parts of an IPC event we check (Electron's IpcMainEvent / IpcMainInvokeEvent). */
export interface SenderInfo {
  sender: unknown
  senderFrame: { url: string } | null
}

export interface IpcMainLike {
  handle(channel: string, fn: (event: SenderInfo, ...args: unknown[]) => Promise<unknown>): void
  on(channel: string, fn: (event: SenderInfo, ...args: unknown[]) => void): void
}

export interface RegisterOptions {
  /** True when the event comes from our window's main frame on our page. */
  isTrustedSender(event: SenderInfo): boolean
  /** Sees every result sent back (test-mode IPC spy). */
  onOutbound?(channel: string, payload: unknown): void
  log?(message: string): void
}

const refused = () => fail(ErrorCode.INVALID_ARGUMENT, DEFAULT_MESSAGES.INVALID_ARGUMENT)

export function registerIpc(ipc: IpcMainLike, controller: Controller, opts: RegisterOptions): void {
  for (const [channel, handler] of Object.entries(controller.handlers) as [
    InvokeChannel,
    Controller['handlers'][InvokeChannel],
  ][]) {
    ipc.handle(channel, async (event, ...args) => {
      let result
      if (!opts.isTrustedSender(event)) {
        opts.log?.(`ipc: ${channel} from an untrusted sender refused`)
        result = refused()
      } else {
        result = await handler(args)
      }
      opts.onOutbound?.(channel, result)
      return result
    })
  }
  ipc.on(IpcChannel.reportActivity, (event, ...args) => {
    if (opts.isTrustedSender(event)) controller.reportActivity(args)
  })
}

/**
 * Whether `url` is the page we loaded: the bundled index.html (file URL, any hash or query) or,
 * in development only, the dev-server origin.
 */
export function isAppUrl(url: string, appFileUrl: string, devServerUrl?: string): boolean {
  const strip = (u: string) => u.split(/[?#]/, 1)[0]
  if (strip(url) === strip(appFileUrl)) return true
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin
    } catch {
      return false
    }
  }
  return false
}
