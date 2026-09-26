// The preload API exposed to the renderer as `window.psafe` (docs/execution-plan.md §A4.8, §B, §C).
// The renderer never touches files, keys or Node. Every call returns a Result; nothing throws across IPC.

import type { Result } from './errors'
import type {
  BackupInfo,
  CopyableField,
  Entry,
  EntryDraft,
  ExportOptions,
  ExportResult,
  GroupNode,
  Settings,
  VaultState,
} from './types'

export interface RecentFile {
  /** Opaque id; the main process maps it back to a path. */
  id: string
  fileName: string
  /** Directory shown to the user so they can tell same-named files apart. */
  folder: string
}

/** What to do when another app holds the file's `.plk` lock (§A6). */
export type LockChoice = 'read-only' | 'remove-lock'

export interface UnlockOptions {
  /**
   * Only after unlock failed with LOCKED_BY_OTHER and the user chose in the lock dialog.
   * 'remove-lock' is sent only after the §A6 second confirmation.
   */
  lockChoice?: LockChoice
}

export interface LockOptions {
  /** Drop unsaved changes before locking (the "Don't save" answer in §B3). */
  discardChanges?: boolean
}

export interface CopyResult {
  /** Epoch ms when the clipboard will be cleared (if it still holds this value). */
  clearsAt: number
}

export interface PsafeApi {
  // ── Files ────────────────────────────────────────────────────────────────
  /**
   * Shows the native open dialog. `null` value = user cancelled, and any open vault (with its
   * unsaved changes) stays as it was. The open vault is closed only once a new file is picked.
   */
  chooseFile(): Promise<Result<{ fileName: string } | null>>
  listRecentFiles(): Promise<Result<RecentFile[]>>
  chooseRecentFile(id: string): Promise<Result<{ fileName: string }>>

  // ── Lock state ───────────────────────────────────────────────────────────
  /**
   * Unlocks the chosen file. The password string is unavoidable here (it comes from an
   * <input>); main copies it into a Buffer and drops the string reference at once.
   */
  unlock(password: string, options?: UnlockOptions): Promise<Result<VaultState>>
  cancelUnlock(): Promise<Result<void>>
  /**
   * Manual lock. With unsaved changes the renderer must ask first (§B3); without
   * `discardChanges` the changes are kept for after the next unlock.
   */
  lock(options?: LockOptions): Promise<Result<VaultState>>
  getState(): Promise<Result<VaultState>>
  /** Closes the file (releases its .plk). With unsaved changes the renderer must ask first. */
  closeFile(): Promise<Result<VaultState>>

  // ── Entries (passwords are always '' here) ───────────────────────────────
  listEntries(): Promise<Result<Entry[]>>
  listGroups(): Promise<Result<GroupNode[]>>
  getEntry(uuid: string): Promise<Result<Entry>>
  /** The only call that returns a password to the renderer. */
  revealPassword(uuid: string): Promise<Result<string>>
  /** Copies in the main process; the value never reaches the renderer. */
  copyField(uuid: string, field: CopyableField): Promise<Result<CopyResult>>
  /** Adds (no uuid) or edits an entry in memory. Returns the entry's uuid. */
  saveEntry(draft: EntryDraft): Promise<Result<{ uuid: string }>>
  /** Marks an entry deleted in memory; removed from the file on save. */
  deleteEntry(uuid: string): Promise<Result<void>>
  /** Drops all unsaved changes and reloads from disk (conflict "Reload" option). */
  reloadFromDisk(): Promise<Result<VaultState>>

  // ── Saving ───────────────────────────────────────────────────────────────
  save(): Promise<Result<VaultState>>
  /** Shows the native save dialog. `null` value = user cancelled. */
  saveAs(): Promise<Result<VaultState | null>>

  // ── Backups (§A5) ────────────────────────────────────────────────────────
  listBackups(): Promise<Result<BackupInfo[]>>
  /** Opens a backup read-only for preview. */
  previewBackup(id: string, password: string): Promise<Result<Entry[]>>
  restoreBackup(id: string): Promise<Result<VaultState>>

  // ── Export (§A7) ─────────────────────────────────────────────────────────
  /** Shows the native save dialog, then writes plaintext XML. `null` value = cancelled. */
  exportXml(options: ExportOptions): Promise<Result<ExportResult | null>>
  revealInFolder(filePath: string): Promise<Result<void>>

  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings(): Promise<Result<Settings>>
  setSettings(settings: Settings): Promise<Result<Settings>>

  // ── Events from main ─────────────────────────────────────────────────────
  /** Fires on every state change: lock, unlock progress, dirty count, banners. Returns an unsubscribe fn. */
  onStateChanged(listener: (state: VaultState) => void): () => void
  /** Fires when the user tries to quit or close with unsaved changes (§B3). */
  onCloseRequested(listener: (reason: 'quit' | 'close-window') => void): () => void
  /**
   * Renderer's answer to onCloseRequested. 'save' means the renderer has already saved
   * successfully, so main may go ahead; if the save failed the renderer answers 'cancel'.
   */
  respondToClose(choice: 'save' | 'discard' | 'cancel'): Promise<Result<void>>
  /** Renderer reports user activity for the idle timer. Throttled by the caller. */
  reportActivity(): void
}

/** IPC channel names. One channel per API method, prefixed to avoid collisions. */
export const IpcChannel = {
  chooseFile: 'psafe:chooseFile',
  listRecentFiles: 'psafe:listRecentFiles',
  chooseRecentFile: 'psafe:chooseRecentFile',
  unlock: 'psafe:unlock',
  cancelUnlock: 'psafe:cancelUnlock',
  lock: 'psafe:lock',
  getState: 'psafe:getState',
  closeFile: 'psafe:closeFile',
  listEntries: 'psafe:listEntries',
  listGroups: 'psafe:listGroups',
  getEntry: 'psafe:getEntry',
  revealPassword: 'psafe:revealPassword',
  copyField: 'psafe:copyField',
  saveEntry: 'psafe:saveEntry',
  deleteEntry: 'psafe:deleteEntry',
  reloadFromDisk: 'psafe:reloadFromDisk',
  save: 'psafe:save',
  saveAs: 'psafe:saveAs',
  listBackups: 'psafe:listBackups',
  previewBackup: 'psafe:previewBackup',
  restoreBackup: 'psafe:restoreBackup',
  exportXml: 'psafe:exportXml',
  revealInFolder: 'psafe:revealInFolder',
  getSettings: 'psafe:getSettings',
  setSettings: 'psafe:setSettings',
  respondToClose: 'psafe:respondToClose',
  reportActivity: 'psafe:reportActivity',
  // main → renderer events
  stateChanged: 'psafe:event:stateChanged',
  closeRequested: 'psafe:event:closeRequested',
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
