import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow } from 'electron'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/limits'

// Hardened window (docs/execution-plan.md WP7): isolated, sandboxed renderer with no Node, web
// security on, no navigation, no new windows, no webviews, DevTools only in unpackaged builds.

/** The file URL of the bundled page; IPC accepts messages only from a frame showing it. */
export const appFileUrl = (): string =>
  pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href

/** The dev-server URL (electron-vite dev only; never set in a packaged build). */
export const devServerUrl = (isPackaged: boolean): string | undefined =>
  isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined

export function createMainWindow(options: { isPackaged: boolean }): BrowserWindow {
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
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !options.isPackaged,
      disableBlinkFeatures: 'Auxclick',
    },
  })

  win.once('ready-to-show', () => win.show())

  const dev = devServerUrl(options.isPackaged)
  if (dev) void win.loadURL(dev)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}
