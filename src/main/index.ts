import { app, BrowserWindow, ipcMain } from 'electron'
import { DEFAULT_MESSAGES, fail, ok } from '@shared/errors'
import { IpcChannel } from '@shared/ipc'
import type { VaultState } from '@shared/types'
import { createMainWindow } from './window'

// WP0 stub: every channel answers so the renderer can be built against the contract.
// WP7 replaces these handlers with the real vault service.
const initialState: VaultState = { status: 'no-file', dirtyCount: 0, banners: [] }

function registerStubHandlers(): void {
  for (const channel of Object.values(IpcChannel)) {
    if (channel.startsWith('psafe:event:')) continue
    if (channel === IpcChannel.reportActivity) {
      ipcMain.on(channel, () => {})
      continue
    }
    ipcMain.handle(channel, () =>
      channel === IpcChannel.getState
        ? ok(initialState)
        : fail('IO_ERROR', DEFAULT_MESSAGES.IO_ERROR, 'Not implemented yet'),
    )
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    registerStubHandlers()
    createMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
