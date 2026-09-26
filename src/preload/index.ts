import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, type PsafeApi } from '@shared/ipc'
import type { VaultState } from '@shared/types'

// Narrow bridge: one named function per channel, no generic `invoke` exposed (WP7 owns this file).
const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

function subscribe<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void,
): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as T))
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: PsafeApi = {
  chooseFile: invoke(IpcChannel.chooseFile) as PsafeApi['chooseFile'],
  listRecentFiles: invoke(IpcChannel.listRecentFiles) as PsafeApi['listRecentFiles'],
  chooseRecentFile: invoke(IpcChannel.chooseRecentFile) as PsafeApi['chooseRecentFile'],
  unlock: invoke(IpcChannel.unlock) as PsafeApi['unlock'],
  cancelUnlock: invoke(IpcChannel.cancelUnlock) as PsafeApi['cancelUnlock'],
  lock: invoke(IpcChannel.lock) as PsafeApi['lock'],
  getState: invoke(IpcChannel.getState) as PsafeApi['getState'],
  closeFile: invoke(IpcChannel.closeFile) as PsafeApi['closeFile'],
  listEntries: invoke(IpcChannel.listEntries) as PsafeApi['listEntries'],
  listGroups: invoke(IpcChannel.listGroups) as PsafeApi['listGroups'],
  getEntry: invoke(IpcChannel.getEntry) as PsafeApi['getEntry'],
  revealPassword: invoke(IpcChannel.revealPassword) as PsafeApi['revealPassword'],
  copyField: invoke(IpcChannel.copyField) as PsafeApi['copyField'],
  saveEntry: invoke(IpcChannel.saveEntry) as PsafeApi['saveEntry'],
  deleteEntry: invoke(IpcChannel.deleteEntry) as PsafeApi['deleteEntry'],
  reloadFromDisk: invoke(IpcChannel.reloadFromDisk) as PsafeApi['reloadFromDisk'],
  save: invoke(IpcChannel.save) as PsafeApi['save'],
  saveAs: invoke(IpcChannel.saveAs) as PsafeApi['saveAs'],
  listBackups: invoke(IpcChannel.listBackups) as PsafeApi['listBackups'],
  previewBackup: invoke(IpcChannel.previewBackup) as PsafeApi['previewBackup'],
  restoreBackup: invoke(IpcChannel.restoreBackup) as PsafeApi['restoreBackup'],
  exportXml: invoke(IpcChannel.exportXml) as PsafeApi['exportXml'],
  revealInFolder: invoke(IpcChannel.revealInFolder) as PsafeApi['revealInFolder'],
  getSettings: invoke(IpcChannel.getSettings) as PsafeApi['getSettings'],
  setSettings: invoke(IpcChannel.setSettings) as PsafeApi['setSettings'],
  respondToClose: invoke(IpcChannel.respondToClose) as PsafeApi['respondToClose'],
  onStateChanged: (listener) =>
    subscribe<[VaultState]>(IpcChannel.stateChanged, (state) => listener(state)),
  onCloseRequested: (listener) =>
    subscribe<['quit' | 'close-window']>(IpcChannel.closeRequested, (reason) => listener(reason)),
  reportActivity: () => ipcRenderer.send(IpcChannel.reportActivity),
}

contextBridge.exposeInMainWorld('psafe', api)
