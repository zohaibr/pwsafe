import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/limits'

// Hardened window (docs/execution-plan.md WP7). WP0 stub; WP7 owns this file.
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: 'psafe3 Opener',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // No navigation away from the bundled app and no new windows.
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}
