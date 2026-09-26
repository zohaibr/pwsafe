import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, type PsafeApi } from '@shared/ipc'
import type { VaultState } from '@shared/types'

// Narrow bridge (WP7): one named function per channel with a fixed argument list; no generic
// `invoke`, `send` or `ipcRenderer` is exposed. Main validates every argument again.
const C = IpcChannel
const call = ipcRenderer.invoke.bind(ipcRenderer)

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: PsafeApi = {
  chooseFile: () => call(C.chooseFile),
  listRecentFiles: () => call(C.listRecentFiles),
  chooseRecentFile: (id) => call(C.chooseRecentFile, id),
  unlock: (password, options) => call(C.unlock, password, options),
  cancelUnlock: () => call(C.cancelUnlock),
  lock: (options) => call(C.lock, options),
  getState: () => call(C.getState),
  closeFile: () => call(C.closeFile),
  listEntries: () => call(C.listEntries),
  listGroups: () => call(C.listGroups),
  getEntry: (uuid) => call(C.getEntry, uuid),
  revealPassword: (uuid) => call(C.revealPassword, uuid),
  copyField: (uuid, field) => call(C.copyField, uuid, field),
  saveEntry: (draft) => call(C.saveEntry, draft),
  deleteEntry: (uuid) => call(C.deleteEntry, uuid),
  reloadFromDisk: () => call(C.reloadFromDisk),
  save: () => call(C.save),
  saveAs: () => call(C.saveAs),
  listBackups: () => call(C.listBackups),
  previewBackup: (id, password) => call(C.previewBackup, id, password),
  restoreBackup: (id) => call(C.restoreBackup, id),
  exportXml: (options) => call(C.exportXml, options),
  revealInFolder: (filePath) => call(C.revealInFolder, filePath),
  getSettings: () => call(C.getSettings),
  setSettings: (settings) => call(C.setSettings, settings),
  respondToClose: (choice) => call(C.respondToClose, choice),
  onStateChanged: (listener) => subscribe<VaultState>(C.stateChanged, listener),
  onCloseRequested: (listener) => subscribe<'quit' | 'close-window'>(C.closeRequested, listener),
  reportActivity: () => ipcRenderer.send(C.reportActivity),
}

contextBridge.exposeInMainWorld('psafe', Object.freeze(api))
