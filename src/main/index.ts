// Main process entry (WP7): hardening, the vault service wired to IPC, auto-lock, the quit /
// close-window flow, and opening .psafe3 files from the OS (double-click, argv).
import { hostname, userInfo } from 'node:os'
import { resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  shell,
  type WebContents,
} from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { VaultState } from '@shared/types'
import { createTwofish } from './crypto/twofish/twofish'
import { createNodeFileSystem } from './fs'
import { ClipboardGuard, realTimers } from './ipc/clipboard'
import { CloseFlow, type CloseReason } from './ipc/closeFlow'
import { Controller, type Dialogs } from './ipc/controller'
import { IdleLock } from './ipc/idle'
import { writeFileAtomic } from './ipc/jsonFile'
import { fileFromArgv } from './ipc/openFile'
import { RecentFiles } from './ipc/recentFiles'
import { isAppUrl, registerIpc, type SenderInfo } from './ipc/register'
import { SettingsStore } from './ipc/settings'
import { ipcSpyList, readTestMode } from './ipc/testMode'
import { disableSpellChecker } from './session'
import { Vault } from './vault'
import { appFileUrl, createMainWindow, devServerUrl } from './window'

const log = (m: string) => console.warn(`[psafe3] ${m}`)
const testMode = readTestMode(process.env, app.isPackaged)
if (testMode?.userData) app.setPath('userData', resolve(testMode.userData))

// The only renderer is created sandboxed (window.ts); no other window or webview can be opened.
// (app.enableSandbox() is not used: it also forces the sandbox onto helper processes, which then
// ignore --no-sandbox where the OS can't provide one, e.g. Linux CI containers.)

/** A .psafe3 the OS asked us to open before we were ready (macOS open-file, argv). */
let pendingOpen: string | undefined = fileFromArgv(process.argv)
let mainWindow: BrowserWindow | undefined
let controller: Controller | undefined
let vault: Vault | undefined
let closeFlow: CloseFlow | undefined
let settings: SettingsStore | undefined
/** Close/quit that the user has approved (or that had nothing to lose): nothing may stop it now. */
let quitApproved = false
let closeApproved = false

// macOS double-click / "Open With". Can fire before 'ready'.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (controller) void openFromOs(path)
  else pendingOpen = path
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    showWindow()
    const path = fileFromArgv(argv, workingDirectory)
    if (path && controller) void openFromOs(path)
  })
  hardenWebContents()
  // Every session, including the default one, as soon as it exists: no spell-checker downloads.
  app.on('session-created', (ses) => disableSpellChecker(ses, process.platform))
  void app.whenReady().then(start)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (controller) mainWindow = openWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** App-wide rules for every web contents: no navigation, no new windows, no webviews. */
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

/** Denies every permission (camera, notifications, clipboard-read…) and all remote loads. */
function hardenSession(): void {
  const ses = session.defaultSession
  // Also here, in case the default session was created before our 'session-created' listener.
  disableSpellChecker(ses, process.platform)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  const dev = devServerUrl(app.isPackaged)
  const devOrigin = dev ? new URL(dev).origin : undefined
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const local =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      (devOrigin !== undefined && (url.startsWith(devOrigin) || url.startsWith('ws://localhost')))
    if (!local) log('blocked a network request from the renderer')
    callback({ cancel: !local })
  })
}

function electronDialogs(): Dialogs {
  const parent = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined)
  const filters = [{ name: 'Password Safe V3', extensions: ['psafe3'] }]
  const show = async (
    kind: 'open' | 'saveAs' | 'export',
    native: (w?: BrowserWindow) => Promise<string | null>,
  ): Promise<string | null> => {
    if (testMode) return testMode.dialogPath(kind)
    return native(parent())
  }
  return {
    openVault: (defaultDir) =>
      show('open', async (w) => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Open a Password Safe file',
          properties: ['openFile'],
          filters,
          ...(defaultDir ? { defaultPath: defaultDir } : {}),
        }
        const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
      }),
    saveVaultAs: (defaultPath) =>
      show('saveAs', async (w) => {
        const opts: Electron.SaveDialogOptions = {
          title: 'Save As',
          defaultPath,
          filters,
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        }
        const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
        return r.canceled || !r.filePath ? null : r.filePath
      }),
    saveExport: (defaultPath) =>
      show('export', async (w) => {
        const opts: Electron.SaveDialogOptions = {
          title: 'Export to XML (not encrypted)',
          defaultPath,
          filters: [{ name: 'Password Safe XML', extensions: ['xml'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        }
        const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
        return r.canceled || !r.filePath ? null : r.filePath
      }),
  }
}

function send(channel: string, payload: unknown): boolean {
  const w = mainWindow
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false
  if (testMode?.ipcSpy) ipcSpyList().push({ channel, payload: structuredClone(payload) })
  w.webContents.send(channel, payload)
  return true
}

function openWindow(): BrowserWindow {
  const win = createMainWindow({ isPackaged: app.isPackaged })
  win.on('close', (event) => {
    if (quitApproved || closeApproved) return
    event.preventDefault()
    void closeFlow?.request('close-window')
  })
  win.on('minimize', () => {
    if (settings?.get().lockOnMinimize) void controller?.autoLock()
  })
  win.on('closed', () => {
    closeApproved = false
    if (mainWindow === win) mainWindow = undefined
  })
  return win
}

async function openFromOs(path: string): Promise<void> {
  const c = controller
  if (!c) return
  showWindow()
  const state = vault?.getState()
  if (state && state.dirtyCount > 0) {
    // Never drop unsaved changes to follow a double-click.
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      message: 'Save or discard your changes first',
      detail: `${state.fileName ?? 'The open file'} has unsaved changes. Save them (or close the file) and then open the other file again.`,
      buttons: ['OK'],
    }
    if (mainWindow) await dialog.showMessageBox(mainWindow, opts)
    else await dialog.showMessageBox(opts)
    return
  }
  const r = await c.openPath(path)
  if (!r.ok) log(`open from OS failed (${r.error.code})`)
}

async function start(): Promise<void> {
  hardenSession()
  const userData = app.getPath('userData')
  settings = new SettingsStore(userData, log)
  await settings.load()
  const recent = new RecentFiles(userData)
  await recent.load()

  const v = new Vault({
    fs: createNodeFileSystem(),
    platform:
      process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    identity: { user: userInfo().username, host: hostname(), pid: process.pid },
    processExists: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined
      }
    },
    codec: { cipherFactory: createTwofish },
    appName: `psafe3 Opener V${app.getVersion()}`,
    log,
  })
  vault = v

  const settingsStore = settings
  const idle = new IdleLock(
    realTimers,
    () => settingsStore.get().idleLockMinutes,
    () => void controller?.autoLock(),
  )

  closeFlow = new CloseFlow({
    dirtyCount: () => v.getState().dirtyCount,
    ask: (reason: CloseReason) => {
      showWindow()
      return send(IpcChannel.closeRequested, reason)
    },
    focus: showWindow,
    proceed: async (reason) => {
      await controller?.shutdown()
      if (reason === 'quit') {
        quitApproved = true
        app.quit()
      } else {
        closeApproved = true
        mainWindow?.close()
      }
    },
    log,
  })

  const c = new Controller({
    vault: v,
    dialogs: electronDialogs(),
    clipboard: new ClipboardGuard(clipboard),
    settings: settingsStore,
    recent,
    closeFlow,
    writeExport: (path, xml) => writeFileAtomic(path, xml, 0o600),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    downloadsDir: () => app.getPath('downloads'),
    onSettingsChanged: () => {
      if (idle.isRunning) idle.start()
    },
    onActivity: () => idle.activity(),
    onUnlocked: () => idle.start(),
    log,
  })
  controller = c

  v.onStateChanged((state: VaultState) => {
    if (state.status !== 'open') idle.stop()
    else if (!idle.isRunning) idle.start()
    send(IpcChannel.stateChanged, state)
  })

  const appUrl = appFileUrl()
  const dev = devServerUrl(app.isPackaged)
  registerIpc(ipcMain as unknown as Parameters<typeof registerIpc>[0], c, {
    isTrustedSender: (event: SenderInfo) => {
      const w = mainWindow
      if (!w || w.isDestroyed()) return false
      const e = event as Electron.IpcMainInvokeEvent
      if (e.sender !== w.webContents) return false
      const frame = e.senderFrame
      if (!frame || frame !== w.webContents.mainFrame) return false
      return isAppUrl(frame.url, appUrl, dev)
    },
    ...(testMode?.ipcSpy
      ? {
          onOutbound: (channel: string, payload: unknown) =>
            ipcSpyList().push({ channel, payload: structuredClone(payload) }),
        }
      : {}),
    log,
  })

  // Sleep and screen lock always lock (§B2); unsaved changes stay in memory (§B3).
  powerMonitor.on('suspend', () => void c.autoLock())
  powerMonitor.on('lock-screen', () => void c.autoLock())

  app.on('before-quit', (event) => {
    if (quitApproved) return
    event.preventDefault()
    void closeFlow?.request('quit')
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = openWindow()
  })

  mainWindow = openWindow()
  if (pendingOpen) {
    const p = pendingOpen
    pendingOpen = undefined
    mainWindow.webContents.once('did-finish-load', () => void openFromOs(p))
  }
}
