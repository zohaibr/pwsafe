// The main-process side of every PsafeApi call (docs/execution-plan.md WP7, §A4.8, §A5, §A7, §B).
// No Electron imports: dialogs, clipboard, shell and the file writer are injected, so the handlers
// can be unit-tested. Rules enforced here for every channel:
// - every argument is validated for shape and size (INVALID_ARGUMENT otherwise);
// - vault calls are refused while the vault is not open (VAULT_LOCKED), before any dialog shows;
// - nothing throws: every handler resolves to a Result;
// - passwords leave main only in a revealPassword response; copy happens here.
import { basename, dirname, extname, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { DEFAULT_MESSAGES, ErrorCode, fail, ok, type Result } from '../../shared/errors'
import { IpcChannel, type PsafeApi } from '../../shared/ipc'
import type { Settings, VaultState } from '../../shared/types'
import { buildXmlExport } from '../export/xmlExport'
import type { Vault } from '../vault'
import type { ClipboardGuard } from './clipboard'
import type { CloseFlow } from './closeFlow'
import type { RecentFiles } from './recentFiles'
import type { SettingsStore } from './settings'
import * as v from './validate'

/** The vault methods the IPC layer uses (WP6's Vault satisfies it). */
export type VaultApi = Pick<
  Vault,
  | 'open'
  | 'close'
  | 'unlock'
  | 'cancelUnlock'
  | 'lock'
  | 'getState'
  | 'listEntries'
  | 'listGroups'
  | 'getEntry'
  | 'revealPassword'
  | 'getFieldForCopy'
  | 'saveEntry'
  | 'deleteEntry'
  | 'reloadFromDisk'
  | 'save'
  | 'saveAs'
  | 'listBackups'
  | 'previewBackup'
  | 'restoreBackup'
  | 'getExportData'
>

/** Native dialogs. Each resolves to the picked path, or null when the user cancelled. */
export interface Dialogs {
  openVault(defaultDir?: string): Promise<string | null>
  saveVaultAs(defaultPath: string): Promise<string | null>
  saveExport(defaultPath: string): Promise<string | null>
}

export interface ControllerDeps {
  vault: VaultApi
  dialogs: Dialogs
  clipboard: ClipboardGuard
  settings: SettingsStore
  recent: RecentFiles
  closeFlow: CloseFlow
  /** Writes the export file (temp + rename, mode 0600). */
  writeExport(path: string, xml: string): Promise<void>
  /** shell.showItemInFolder */
  showItemInFolder(path: string): void
  /** Default folder for exports (the user's Downloads folder). */
  downloadsDir(): string
  now?: () => Date
  /** Called after settings change (idle timer, lock on minimise). */
  onSettingsChanged?(settings: Settings): void
  /** Renderer activity for the idle timer. */
  onActivity?(): void
  /** Called after a successful unlock (starts the idle timer). */
  onUnlocked?(): void
  log?(message: string): void
}

/** Invoke channels (everything except events and the one-way reportActivity). */
export type InvokeChannel = Exclude<
  IpcChannel,
  | typeof IpcChannel.stateChanged
  | typeof IpcChannel.closeRequested
  | typeof IpcChannel.reportActivity
>

export type Handler = (args: readonly unknown[]) => Promise<Result<unknown>>

const err = <T>(code: ErrorCode, detail?: string): Result<T> =>
  fail<T>(code, DEFAULT_MESSAGES[code], detail)

const PSAFE3 = '.psafe3'

/** `<db-name>-export-YYYYMMDD.xml` (§A7), local date. */
export function defaultExportName(fileName: string | undefined, when: Date): string {
  const base = (fileName ?? 'passwords').replace(/\.psafe3$/i, '') || 'passwords'
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`
  return `${base}-export-${stamp}.xml`
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return resolve(p)
  }
}

export class Controller {
  /** Path of the chosen file as the user picked it (kept in main only). */
  private currentPath: string | undefined
  /** Export files this app wrote in this run; revealInFolder accepts only these. */
  private readonly written = new Set<string>()
  private readonly now: () => Date
  private readonly log: (m: string) => void
  readonly handlers: Record<InvokeChannel, Handler>

  constructor(private readonly d: ControllerDeps) {
    this.now = d.now ?? (() => new Date())
    this.log = d.log ?? (() => {})
    this.handlers = this.buildHandlers()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private state(): VaultState {
    return this.d.vault.getState()
  }

  private requireOpen<T>(): Result<T> | undefined {
    return this.state().status === 'open' ? undefined : err<T>(ErrorCode.VAULT_LOCKED)
  }

  private requireWritable<T>(): Result<T> | undefined {
    const locked = this.requireOpen<T>()
    if (locked) return locked
    const ro = this.state().readOnly
    return ro ? fail<T>(ErrorCode.READ_ONLY, DEFAULT_MESSAGES.READ_ONLY, ro.text) : undefined
  }

  /** Runs a handler body; validation errors become INVALID_ARGUMENT, anything else IO_ERROR. */
  private guard(channel: string, max: number, body: Handler): Handler {
    return async (args) => {
      try {
        v.argCount(args, max)
        return await body(args)
      } catch (e) {
        if (e instanceof v.InvalidArgument) {
          this.log(`ipc: ${channel} refused (${e.message})`)
          return err(ErrorCode.INVALID_ARGUMENT)
        }
        this.log(`ipc: ${channel} failed (${(e as Error)?.name ?? 'unknown'})`)
        return err(ErrorCode.IO_ERROR)
      }
    }
  }

  // ── Flows shared with main (double-click, argv) ──────────────────────────
  /** Chooses `path` as the vault file (closing any open one) and records it in Recent files. */
  async openPath(path: string): Promise<Result<{ fileName: string }>> {
    await this.d.clipboard.clearIfOurs()
    const r = await this.d.vault.open(path)
    if (!r.ok) return r
    this.currentPath = resolve(path)
    this.written.clear()
    try {
      await this.d.recent.add(path)
    } catch {
      this.log('recent: could not save the list')
    }
    return r
  }

  /** Auto-lock (idle, minimise, sleep, screen lock): unsaved changes are kept in memory (§B3). */
  async autoLock(): Promise<void> {
    const s = this.state().status
    if (s !== 'open' && s !== 'unlocking') return
    const r = await this.d.vault.lock()
    await this.d.clipboard.clearIfOurs()
    if (!r.ok) this.log(`lock: auto-lock failed (${r.error.code})`)
  }

  /** Quit / window close: clear our clipboard value and close the vault (releases the .plk). */
  async shutdown(): Promise<void> {
    await this.d.clipboard.clearIfOurs()
    await this.d.vault.close()
    this.currentPath = undefined
  }

  // ── Channels ─────────────────────────────────────────────────────────────
  private buildHandlers(): Record<InvokeChannel, Handler> {
    const d = this.d
    const vault = d.vault
    const C = IpcChannel
    const g = this.guard.bind(this)

    type H = Record<InvokeChannel, Handler>
    const h: H = {
      [C.chooseFile]: g(C.chooseFile, 0, async () => {
        const dir = this.currentPath ? dirname(this.currentPath) : undefined
        const picked = await d.dialogs.openVault(dir)
        if (picked === null) return ok(null)
        return this.openPath(picked)
      }),

      [C.listRecentFiles]: g(C.listRecentFiles, 0, async () => ok(await d.recent.list())),

      [C.chooseRecentFile]: g(C.chooseRecentFile, 1, async ([id]) => {
        const path = d.recent.pathFor(v.id(id, 'recent id'))
        if (path === undefined) return err(ErrorCode.IO_ERROR, 'That file is no longer listed.')
        return this.openPath(path)
      }),

      [C.unlock]: g(C.unlock, 2, async ([password, options]) => {
        const opts = v.unlockOptions(options)
        const bytes = Buffer.from(v.password(password), 'utf8')
        try {
          const r = await vault.unlock(bytes, opts)
          if (r.ok && r.value.status === 'open') d.onUnlocked?.()
          return r
        } finally {
          bytes.fill(0)
        }
      }),

      [C.cancelUnlock]: g(C.cancelUnlock, 0, async () => vault.cancelUnlock()),

      [C.lock]: g(C.lock, 1, async ([options]) => {
        const opts = v.lockOptions(options)
        const r = await vault.lock(opts)
        await d.clipboard.clearIfOurs()
        return r
      }),

      [C.getState]: g(C.getState, 0, async () => ok(this.state())),

      [C.closeFile]: g(C.closeFile, 0, async () => {
        await d.clipboard.clearIfOurs()
        const r = await vault.close()
        this.currentPath = undefined
        return r
      }),

      [C.listEntries]: g(C.listEntries, 0, async () => this.requireOpen() ?? vault.listEntries()),

      [C.listGroups]: g(C.listGroups, 0, async () => this.requireOpen() ?? vault.listGroups()),

      [C.getEntry]: g(C.getEntry, 1, async ([uuid]) => {
        const id = v.id(uuid, 'uuid')
        return this.requireOpen() ?? vault.getEntry(id)
      }),

      [C.revealPassword]: g(C.revealPassword, 1, async ([uuid]) => {
        const id = v.id(uuid, 'uuid')
        return this.requireOpen() ?? vault.revealPassword(id)
      }),

      [C.copyField]: g(C.copyField, 2, async ([uuid, field]) => {
        const id = v.id(uuid, 'uuid')
        const f = v.copyableField(field)
        const locked = this.requireOpen<never>()
        if (locked) return locked
        const value = vault.getFieldForCopy(id, f)
        if (!value.ok) return value
        return ok(await d.clipboard.copy(value.value))
      }),

      [C.saveEntry]: g(C.saveEntry, 1, async ([draft]) => {
        const dr = v.entryDraft(draft)
        return this.requireWritable() ?? vault.saveEntry(dr)
      }),

      [C.deleteEntry]: g(C.deleteEntry, 1, async ([uuid]) => {
        const id = v.id(uuid, 'uuid')
        return this.requireWritable() ?? vault.deleteEntry(id)
      }),

      [C.reloadFromDisk]: g(
        C.reloadFromDisk,
        0,
        async () => this.requireOpen() ?? vault.reloadFromDisk(),
      ),

      [C.save]: g(C.save, 0, async () => this.requireWritable() ?? vault.save()),

      [C.saveAs]: g(C.saveAs, 0, async () => {
        const blocked = this.requireWritable<never>()
        if (blocked) return blocked
        const current = this.currentPath
        const fileName = this.state().fileName ?? `passwords${PSAFE3}`
        const defaultPath = current ? join(dirname(current), fileName) : fileName
        const picked = await d.dialogs.saveVaultAs(defaultPath)
        if (picked === null) return ok(null)
        const again = this.requireWritable<never>()
        if (again) return again
        const r = await vault.saveAs(picked)
        if (r.ok || r.error.code === ErrorCode.SAVED_DURABILITY_UNCONFIRMED) {
          this.currentPath = resolve(picked)
          try {
            await d.recent.add(picked)
          } catch {
            this.log('recent: could not save the list')
          }
        }
        return r
      }),

      [C.listBackups]: g(C.listBackups, 0, async () => this.requireOpen() ?? vault.listBackups()),

      [C.previewBackup]: g(C.previewBackup, 2, async ([id, password]) => {
        const backupId = v.id(id, 'backup id')
        const pw = v.password(password)
        const locked = this.requireOpen<never>()
        if (locked) return locked
        const bytes = Buffer.from(pw, 'utf8')
        try {
          return await vault.previewBackup(backupId, bytes)
        } finally {
          bytes.fill(0)
        }
      }),

      [C.restoreBackup]: g(C.restoreBackup, 1, async ([id]) => {
        const backupId = v.id(id, 'backup id')
        return this.requireWritable() ?? vault.restoreBackup(backupId)
      }),

      [C.exportXml]: g(C.exportXml, 1, async ([options]) =>
        this.exportXml(v.exportOptions(options)),
      ),

      [C.revealInFolder]: g(C.revealInFolder, 1, async ([filePath]) => {
        const p = resolve(v.filePath(filePath))
        if (!this.written.has(p)) return err(ErrorCode.INVALID_ARGUMENT)
        d.showItemInFolder(p)
        return ok(undefined)
      }),

      [C.getSettings]: g(C.getSettings, 0, async () => ok(d.settings.get())),

      [C.setSettings]: g(C.setSettings, 1, async ([next]) => {
        const s = v.settings(next)
        const saved = await d.settings.set(s)
        d.onSettingsChanged?.(saved)
        return ok(saved)
      }),

      [C.respondToClose]: g(C.respondToClose, 1, async ([choice]) => {
        const c = v.closeChoice(choice)
        // Answer the renderer first; quitting or closing happens after.
        void d.closeFlow.respond(c).catch(() => this.log('close: could not finish'))
        return ok(undefined)
      }),
    }
    return h
  }

  /** Renderer activity (one-way channel). */
  reportActivity(args: readonly unknown[]): void {
    if (args.length === 0) this.d.onActivity?.()
  }

  private async exportXml(
    options: Parameters<PsafeApi['exportXml']>[0],
  ): Promise<Result<import('../../shared/types').ExportResult | null>> {
    const d = this.d
    const locked = this.requireOpen<never>()
    if (locked) return locked
    const defaultPath = join(d.downloadsDir(), defaultExportName(this.state().fileName, this.now()))
    const picked = await d.dialogs.saveExport(defaultPath)
    if (picked === null) return ok(null)
    const target = resolve(picked)
    // Never let an export overwrite a password file (above all, the open one).
    const current = this.currentPath ? await realOrSelf(this.currentPath) : undefined
    if (extname(target).toLowerCase() === PSAFE3 || (await realOrSelf(target)) === current) {
      return err(ErrorCode.IO_ERROR, 'Choose a different file name; that one is a password file.')
    }
    // The vault may have auto-locked while the dialog was open.
    const again = this.requireOpen<never>()
    if (again) return again
    const data = d.vault.getExportData()
    if (!data.ok) return data
    const out = buildXmlExport({
      header: data.value.header,
      records: data.value.records,
      scope: options.scope,
      databaseName: data.value.databaseName,
      exportedAt: this.now(),
    })
    try {
      await d.writeExport(target, out.xml)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      this.log(`export: write failed (${code ?? 'unknown'})`)
      return err(
        ErrorCode.IO_ERROR,
        `Could not write ${basename(target)}${code ? ` (${code})` : ''}.`,
      )
    }
    this.written.add(target)
    return ok({
      filePath: target,
      entryCount: out.entryCount,
      entriesWithOmittedFields: out.entriesWithOmittedFields,
    })
  }
}
