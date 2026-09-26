// The vault service (docs/execution-plan.md §A5, §A6, §B3, WP6): one open database at a time,
// its `.plk` lock, in-memory edits with dirty tracking, save / Save As / backups / restore and
// open-time recovery. Every public method returns a Result and never throws. No Electron here:
// file system, platform, identity, clock and codec are injected (see VaultDeps and README.md).
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_MESSAGES, ErrorCode, fail, ok, type Result } from '../../shared/errors'
import type { LockChoice, UnlockOptions, LockOptions } from '../../shared/ipc'
import { MAX_FILE_BYTES, SLOW_UNLOCK_THRESHOLD } from '../../shared/limits'
import {
  type Banner,
  type BackupInfo,
  type CopyableField,
  type Entry,
  type EntryDraft,
  type GroupNode,
  HeaderFieldType,
  type RawField,
  type RawRecord,
  type ReadOnlyReason,
  type VaultState,
  type VaultStatus,
} from '../../shared/types'
import type { FileSystem } from '../fs/types'
import { errnoOf, isNotFound } from '../fs/types'
import { isNetworkFs } from '../fs/fsType'
import type { LockHolder, LockPlatform } from '../lockfile/encoding'
import {
  acquireLock,
  holderDetail,
  type HeldLock,
  type LockEnv,
  lockPathFor,
  probeLock,
  releaseLock,
} from '../lockfile/lockfile'
import {
  type CodecDeps,
  decode,
  encode,
  type VaultMeta,
  type VaultModel,
  wipeModel,
} from '../psafe3/codec'
import { decodeText } from '../psafe3/fields'
import { ITER_OFFSET } from '../psafe3/format'
import { stampHeaderForSave } from '../psafe3/header'
import { type StretchFn, stretchKeyInWorker } from '../psafe3/stretch'
import {
  applyDraft,
  buildEntries,
  buildEntry,
  createRecord,
  hasDependants,
  indexRecords,
  readOnlyReasonOf,
  recordUuid,
  resolvePassword,
  type RecordIndex,
} from '../psafe3/views'
import {
  commitNew,
  commitReplace,
  type CommitDeps,
  type CommitOutcome,
  type DiskState,
  readDiskState,
} from './commit'
import { buildGroupTree } from './groups'
import {
  listBackupFiles,
  recoverSidecars,
  rotationUnfinishedBanner,
  unknownStateBanner,
} from './rotation'
import { GENERATIONS, sha256Hex, sidecarsFor } from './sidecars'

export interface VaultDeps {
  fs: FileSystem
  /** Decides the §A6 lock rules; 'win32' opens every vault read-only in v1. */
  platform: LockPlatform
  /** This process as written into `.plk` files: OS user name, host name, pid. */
  identity: LockHolder
  /** Whether a pid is running on this machine (Linux orphan-lock rule); undefined = unknown. */
  processExists: (pid: number) => boolean | undefined
  /** Cipher (Twofish), key stretching (worker by default) and random source. */
  codec: CodecDeps
  /** Clock in epoch milliseconds. Defaults to Date.now. */
  now?: () => number
  /** Written to the header's "last saved by application" field. */
  appName?: string
  /** Non-secret diagnostics (file names, steps, error codes). */
  log?: (message: string) => void
  /** Used between Windows rename retries. */
  sleep?: (ms: number) => Promise<void>
  /** Called as each save step (1–10) starts. For diagnostics and tests. */
  onSaveStep?: (step: number) => void
}

export const READ_ONLY_TEXT: Record<ReadOnlyReason, string> = {
  'newer-format': 'Made by a newer Password Safe; editing disabled to avoid losing data.',
  'locked-by-other': 'Opened read-only because another app has this file open.',
  'lock-not-created':
    "Opened read-only because this app couldn't create a lock file next to it (the folder or drive is read-only).",
  'windows-v1':
    "Opened read-only. On Windows this version can't lock the file the way Password Safe does, so editing is turned off to avoid lost updates.",
  'backup-preview': 'You are looking at a backup. It is read-only.',
}

export const NETWORK_BANNER: Banner = {
  kind: 'warning',
  id: 'network',
  text: 'File is on a network drive; make sure no one else has it open.',
}

export const DEPENDANTS_TEXT = 'Other entries depend on this one.'
export const LOCKED_DESTINATION_TEXT = 'That file is open in another app.'

type ChangeKind = 'added' | 'edited' | 'deleted'

interface OpenModel {
  header: RawField[]
  records: RawRecord[]
  meta: VaultMeta
  /** The master password, owned by the vault; zeroed on lock and close. */
  password: Buffer
  index?: RecordIndex
}

interface Preview {
  id: string
  path: string
  sha256: string
  model: VaultModel
  meta: VaultMeta
  password: Buffer
}

interface Session {
  /** The path the user picked (may be a symlink). */
  openedPath: string
  /** Its real path, resolved at open (§A5 `db`). */
  dbPath: string
  fileName: string
  status: VaultStatus
  /** The first successful unlock took the read-only / lock decisions and ran recovery. */
  initialized: boolean
  lockChoice?: LockChoice
  lock?: HeldLock
  network: boolean
  readOnly?: { reason: ReadOnlyReason; text: string }
  banners: Banner[]
  /** As read at open or written by our last save. */
  disk?: DiskState
  open?: OpenModel
  /** §B3: unsaved changes re-encrypted in memory while locked. */
  blob?: Uint8Array
  changes: Map<string, ChangeKind>
  unlocking?: AbortController
  unlockProgress?: number
  preview?: Preview
}

const err = <T>(code: ErrorCode, detail?: string): Result<T> =>
  fail<T>(code, DEFAULT_MESSAGES[code], detail)

function fieldsEqual(a: readonly RawField[], b: readonly RawField[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.type !== y.type || x.data.length !== y.data.length) return false
    for (let j = 0; j < x.data.length; j++) if (x.data[j] !== y.data[j]) return false
  }
  return true
}

/** §A2 check: the decoded field stream equals the model we meant to write. */
function modelsEqual(a: VaultModel, b: VaultModel): boolean {
  if (!fieldsEqual(a.header, b.header) || a.records.length !== b.records.length) return false
  return a.records.every((r, i) => fieldsEqual(r.fields, b.records[i]!.fields))
}

/** Stretch memo for one save: the encode, the step-2 re-parse and step-4 verify share one P'. */
function memoStretch(base: StretchFn): { fn: StretchFn; wipe: () => void } {
  const cache = new Map<string, Uint8Array>()
  const fn: StretchFn = async (password, salt, iterations, options) => {
    const key = `${Buffer.from(salt).toString('hex')}:${iterations}`
    const hit = cache.get(key)
    if (hit) return hit.slice()
    const p = await base(password, salt, iterations, options)
    cache.set(key, p.slice())
    return p
  }
  return { fn, wipe: () => cache.forEach((v) => v.fill(0)) }
}

/** Swaps in the stamped header and zeroes the save-metadata buffers it replaced (§A4.8). */
function replaceHeader(m: OpenModel, stamped: RawField[]): void {
  const kept = new Set(stamped.map((f) => f.data))
  for (const f of m.header) if (!kept.has(f.data)) f.data.fill(0)
  m.header = stamped
}

function copyModel(m: VaultModel): VaultModel {
  return {
    header: m.header.map((f) => ({ type: f.type, data: f.data })),
    records: m.records.map((r) => ({ fields: r.fields.slice() })),
  }
}

export class Vault {
  private session: Session | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(state: VaultState) => void>()
  private readonly now: () => number
  private readonly log: (m: string) => void
  private readonly random: (n: number) => Uint8Array

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.random = deps.codec.randomBytes ?? ((n) => new Uint8Array(nodeRandomBytes(n)))
  }

  // ── State ────────────────────────────────────────────────────────────────
  getState(): VaultState {
    const s = this.session
    if (!s) return { status: 'no-file', dirtyCount: 0, banners: [] }
    const state: VaultState = {
      status: s.status,
      fileName: s.fileName,
      dirtyCount: s.changes.size,
      banners: s.status === 'open' ? s.banners.map((b) => ({ ...b })) : [],
    }
    if (s.status === 'open' && s.readOnly) state.readOnly = { ...s.readOnly }
    if (s.status === 'unlocking' && s.unlockProgress !== undefined) {
      state.unlockProgress = s.unlockProgress
    }
    return state
  }

  /** Fires on every state change. Returns an unsubscribe function. */
  onStateChanged(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const state = this.getState()
    for (const l of this.listeners) {
      try {
        l(structuredClone(state))
      } catch {
        // A listener must not break the vault.
      }
    }
  }

  /** Runs vault-changing operations one at a time, in call order. Never rejects. */
  private run<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    const next = this.queue.then(async () => {
      try {
        return await fn()
      } catch (e) {
        this.log(`vault: unexpected error (${errnoOf(e) ?? (e as Error)?.name ?? 'unknown'})`)
        return err<T>(ErrorCode.IO_ERROR)
      }
    })
    this.queue = next.catch(() => {})
    return next
  }

  private lockEnv(network: boolean): LockEnv {
    return {
      fs: this.deps.fs,
      platform: this.deps.platform,
      identity: this.deps.identity,
      processExists: this.deps.processExists,
      network,
    }
  }

  private commitDeps(): CommitDeps {
    const d: CommitDeps = {
      fs: this.deps.fs,
      platform: this.deps.platform,
      randomTag: () => Buffer.from(this.random(6).subarray(0, 6)).toString('hex'),
      sleep: this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      log: this.log,
    }
    if (this.deps.onSaveStep) d.onStep = this.deps.onSaveStep
    return d
  }

  private async isNetwork(dir: string): Promise<boolean> {
    try {
      return isNetworkFs(await this.deps.fs.fsType(dir))
    } catch {
      return false
    }
  }

  // ── Files ────────────────────────────────────────────────────────────────
  /**
   * Chooses a file (after the user picked it). Any open file is closed first, dropping unsaved
   * changes: the caller asks the user before calling. Nothing is read or locked yet.
   */
  open(path: string): Promise<Result<{ fileName: string }>> {
    this.session?.unlocking?.abort()
    return this.run(async () => {
      await this.closeSession()
      const openedPath = resolve(path)
      let dbPath: string
      try {
        dbPath = await this.deps.fs.realpath(openedPath)
        const st = await this.deps.fs.lstat(dbPath)
        if (!st.isFile) return err(ErrorCode.IO_ERROR, 'That is not a file.')
      } catch (e) {
        return err(ErrorCode.IO_ERROR, isNotFound(e) ? 'That file is no longer there.' : undefined)
      }
      this.session = {
        openedPath,
        dbPath,
        fileName: basename(openedPath),
        status: 'locked',
        initialized: false,
        network: false,
        banners: [],
        changes: new Map(),
      }
      this.emit()
      return ok({ fileName: basename(openedPath) })
    })
  }

  /** Closes the file: releases its `.plk` and drops every secret. Unsaved changes are dropped. */
  close(): Promise<Result<VaultState>> {
    this.session?.unlocking?.abort()
    return this.run(async () => {
      await this.closeSession()
      this.emit()
      return ok(this.getState())
    })
  }

  private async closeSession(): Promise<void> {
    const s = this.session
    if (!s) return
    this.wipeSecrets(s)
    s.blob = undefined
    s.changes.clear()
    if (s.lock) {
      await releaseLock(this.deps.fs, s.lock)
      s.lock = undefined
    }
    this.session = undefined
  }

  private wipeSecrets(s: Session): void {
    if (s.open) {
      wipeModel(s.open)
      s.open.password.fill(0)
      s.open = undefined
    }
    this.dropPreview(s)
  }

  private dropPreview(s: Session): void {
    if (s.preview) {
      wipeModel(s.preview.model)
      s.preview.password.fill(0)
      s.preview = undefined
    }
  }

  // ── Lock state ───────────────────────────────────────────────────────────
  /**
   * Unlocks the chosen file. The vault copies `password` into its own buffer; the caller keeps
   * ownership of (and should zero) the one it passed. The first unlock of a file applies §A6: it
   * returns LOCKED_BY_OTHER (detail "user@host:pid") when another app holds the `.plk`, unless
   * `options.lockChoice` says what to do. Rejected files are never locked or written.
   */
  unlock(password: Uint8Array, options: UnlockOptions = {}): Promise<Result<VaultState>> {
    return this.run(async () => {
      const s = this.session
      if (!s) return err(ErrorCode.IO_ERROR, 'No file chosen.')
      if (s.open) return ok(this.getState())
      if (options.lockChoice) s.lockChoice = options.lockChoice
      const pw = Buffer.from(password)
      let keep = false
      try {
        return await this.doUnlock(s, pw, (k) => (keep = k))
      } catch (e) {
        if (s.status === 'unlocking') {
          s.status = 'locked'
          s.unlocking = undefined
          s.unlockProgress = undefined
          this.emit()
        }
        throw e
      } finally {
        if (!keep) pw.fill(0)
      }
    })
  }

  private async doUnlock(
    s: Session,
    pw: Buffer,
    keepPassword: (k: boolean) => void,
  ): Promise<Result<VaultState>> {
    const { fs, platform } = this.deps
    const backToLocked = <T>(r: Result<T>): Result<T> => {
      s.status = 'locked'
      s.unlockProgress = undefined
      s.unlocking = undefined
      this.emit()
      return r
    }

    // §A6 probe before any expensive work, so a locked file is reported at once.
    if (!s.initialized && platform !== 'win32') {
      s.network = await this.isNetwork(dirname(s.dbPath))
      if (!s.lockChoice) {
        const probe = await probeLock(s.dbPath, this.lockEnv(s.network))
        if (probe.state === 'held') {
          return err(ErrorCode.LOCKED_BY_OTHER, holderDetail(probe.holder))
        }
      }
    }

    // Source: the in-memory blob of unsaved changes (§B3), or the file.
    let bytes: Uint8Array
    let disk: DiskState | undefined
    if (s.blob) bytes = s.blob
    else {
      if (await this.oversize(s.dbPath)) return err(ErrorCode.TOO_LARGE)
      try {
        const r = await readDiskState(fs, s.dbPath)
        bytes = r.bytes
        disk = r.state
      } catch (e) {
        return err(ErrorCode.IO_ERROR, isNotFound(e) ? 'That file is no longer there.' : undefined)
      }
    }
    const iterations =
      bytes.length >= ITER_OFFSET + 4
        ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
            ITER_OFFSET,
            true,
          )
        : 0
    const slow = iterations > SLOW_UNLOCK_THRESHOLD
    const ac = new AbortController()
    s.unlocking = ac
    s.status = 'unlocking'
    s.unlockProgress = slow ? 0 : undefined
    this.emit()
    const decoded = await decode(bytes, pw, this.deps.codec, {
      signal: ac.signal,
      ...(slow
        ? {
            onProgress: (f: number) => {
              if (s.unlocking !== ac) return
              s.unlockProgress = f
              this.emit()
            },
          }
        : {}),
    })
    if (!decoded.ok) return backToLocked(decoded)
    if (ac.signal.aborted || this.session !== s) {
      wipeModel(decoded.value)
      return backToLocked(err(ErrorCode.CANCELLED))
    }
    const { meta } = decoded.value

    if (!s.initialized) {
      if (platform === 'win32') s.readOnly = this.readOnly('windows-v1')
      else if (meta.readOnlyReason === 'newer-format') s.readOnly = this.readOnly('newer-format')
      else if (s.lockChoice === 'read-only') s.readOnly = this.readOnly('locked-by-other')
      else {
        const acq = await acquireLock(s.dbPath, this.lockEnv(s.network), {
          removeExisting: s.lockChoice === 'remove-lock',
        })
        if (acq.kind === 'acquired') {
          s.lock = acq.lock
          if (acq.removed) this.log(`lock: removed existing lock (${acq.removed})`)
        } else if (acq.kind === 'held') {
          wipeModel(decoded.value)
          return backToLocked(err(ErrorCode.LOCKED_BY_OTHER, holderDetail(acq.holder)))
        } else {
          this.log(
            `lock: could not create (${acq.kind === 'cannot-create' ? (acq.code ?? '?') : acq.kind})`,
          )
          s.readOnly = this.readOnly('lock-not-created')
        }
      }
      if (s.network) s.banners.push({ ...NETWORK_BANNER })
      if (!s.readOnly) {
        const report = await recoverSidecars(fs, s.dbPath, this.log)
        s.banners.push(...report.banners)
      }
      s.initialized = true
    } else if (!s.blob && meta.readOnlyReason === 'newer-format' && !s.readOnly) {
      s.readOnly = this.readOnly('newer-format')
    }

    keepPassword(true)
    s.open = { header: decoded.value.header, records: decoded.value.records, meta, password: pw }
    if (disk) s.disk = disk
    s.blob = undefined
    s.status = 'open'
    s.unlocking = undefined
    s.unlockProgress = undefined
    this.emit()
    return ok(this.getState())
  }

  /**
   * §A4 step 1 before reading: a file over the size cap is refused without loading it into
   * memory (decode checks the size again on the bytes it gets). Unknown size: false, and the
   * read that follows reports the error.
   */
  private async oversize(path: string): Promise<boolean> {
    try {
      return (await this.deps.fs.lstat(path)).size > MAX_FILE_BYTES
    } catch {
      return false
    }
  }

  private readOnly(reason: ReadOnlyReason): { reason: ReadOnlyReason; text: string } {
    return { reason, text: READ_ONLY_TEXT[reason] }
  }

  /** Cancels a running unlock (slow key stretching). */
  cancelUnlock(): Result<void> {
    this.session?.unlocking?.abort()
    return ok(undefined)
  }

  /**
   * Locks the vault. With unsaved changes and no `discardChanges` (auto-lock, or the user chose
   * to keep them), the model is re-encrypted in memory under the same master password (§B3) and
   * the plaintext and password are dropped; the next unlock brings the changes back, still
   * unsaved. Nothing is written to disk. The `.plk` stays held while locked.
   */
  lock(options: LockOptions = {}): Promise<Result<VaultState>> {
    this.session?.unlocking?.abort()
    return this.run(async () => {
      const s = this.session
      if (!s) return ok(this.getState())
      this.dropPreview(s)
      const open = s.open
      if (!open) return ok(this.getState())
      // Refuse entry access at once; the re-encryption below may take a moment.
      s.status = 'locked'
      this.emit()
      if (options.discardChanges) s.changes.clear()
      if (s.changes.size > 0) {
        const blob = await encode(
          { header: open.header, records: open.records },
          open.password,
          this.deps.codec,
          { iterations: open.meta.iterations },
        )
        if (!blob.ok) {
          s.status = 'open'
          this.emit()
          this.log('lock: could not re-encrypt unsaved changes; staying unlocked')
          return err(ErrorCode.IO_ERROR, 'Could not keep your unsaved changes while locking.')
        }
        s.blob = blob.value
      }
      this.wipeSecrets(s)
      this.emit()
      return ok(this.getState())
    })
  }

  // ── Entries ──────────────────────────────────────────────────────────────
  private openModel(): Result<OpenModel> {
    const s = this.session
    if (!s || s.status !== 'open' || !s.open) return err(ErrorCode.VAULT_LOCKED)
    return ok(s.open)
  }

  private writable(): Result<{ s: Session; m: OpenModel }> {
    const m = this.openModel()
    if (!m.ok) return m
    const s = this.session!
    if (s.readOnly) return fail(ErrorCode.READ_ONLY, DEFAULT_MESSAGES.READ_ONLY, s.readOnly.text)
    return ok({ s, m: m.value })
  }

  private indexOf(m: OpenModel): RecordIndex {
    m.index ??= indexRecords(m.records)
    return m.index
  }

  private findRecord(m: OpenModel, uuid: string): RawRecord | undefined {
    if (typeof uuid !== 'string') return undefined
    const pos = /^#(\d+)$/.exec(uuid)
    if (pos) {
      const r = m.records[Number(pos[1])]
      return r && recordUuid(r) === undefined ? r : undefined
    }
    return this.indexOf(m).byUuid.get(uuid.toLowerCase())
  }

  /** Every entry, in file order. Passwords are always ''. */
  listEntries(): Result<Entry[]> {
    const m = this.openModel()
    if (!m.ok) return m
    const index = this.indexOf(m.value)
    return ok(m.value.records.map((r) => buildEntry(r, index)))
  }

  listGroups(): Result<GroupNode[]> {
    const m = this.openModel()
    if (!m.ok) return m
    const entries = buildEntries(m.value.records)
    const empty = m.value.header
      .filter((f) => f.type === HeaderFieldType.EMPTY_GROUPS)
      .map((f) => decodeText(f.data))
      .filter((g): g is string => g !== undefined && g !== '')
    return ok(buildGroupTree(entries, empty))
  }

  /** One entry; the password is ''. */
  getEntry(uuid: string): Result<Entry> {
    const m = this.openModel()
    if (!m.ok) return m
    const r = this.findRecord(m.value, uuid)
    if (!r) return err(ErrorCode.INVALID_ARGUMENT, 'No such entry.')
    return ok(buildEntry(r, this.indexOf(m.value)))
  }

  /** The password to show for a reveal (aliases and shortcuts resolve to their base's). */
  revealPassword(uuid: string): Result<string> {
    const m = this.openModel()
    if (!m.ok) return m
    const r = this.findRecord(m.value, uuid)
    if (!r) return err(ErrorCode.INVALID_ARGUMENT, 'No such entry.')
    const pw = resolvePassword(r, this.indexOf(m.value))
    if (pw === undefined) return err(ErrorCode.RECORD_READ_ONLY, 'This password is not valid text.')
    return ok(pw)
  }

  /** The value to put on the clipboard (copy happens in main, §A4.8). */
  getFieldForCopy(uuid: string, field: CopyableField): Result<string> {
    if (field === 'password') return this.revealPassword(uuid)
    const m = this.openModel()
    if (!m.ok) return m
    const r = this.findRecord(m.value, uuid)
    if (!r) return err(ErrorCode.INVALID_ARGUMENT, 'No such entry.')
    if (field !== 'username' && field !== 'url' && field !== 'email') {
      return err(ErrorCode.INVALID_ARGUMENT, 'Unknown field.')
    }
    return ok(buildEntry(r, this.indexOf(m.value))[field])
  }

  private markChanged(s: Session, uuid: string, kind: ChangeKind): void {
    const prev = s.changes.get(uuid)
    if (kind === 'edited' && prev) return
    if (kind === 'deleted' && prev === 'added') s.changes.delete(uuid)
    else s.changes.set(uuid, kind)
  }

  /** Adds (no uuid) or edits an entry in memory. Only the editable fields change (§A3). */
  saveEntry(draft: EntryDraft): Promise<Result<{ uuid: string }>> {
    return this.run(async () => {
      const w = this.writable()
      if (!w.ok) return w
      const { s, m } = w.value
      const now = Math.floor(this.now() / 1000)
      if (draft.uuid !== undefined) {
        const rec = this.findRecord(m, draft.uuid)
        if (!rec) return err(ErrorCode.INVALID_ARGUMENT, 'No such entry.')
        const index = this.indexOf(m)
        const r = applyDraft(rec, draft, index, { now })
        if (!r.ok) return r
        const uuid = recordUuid(rec)!
        if (r.value !== rec) {
          m.records[index.position.get(rec)!] = r.value
          // Best effort (§A4.8): zero the replaced values, e.g. the old password.
          const kept = new Set(r.value.fields.map((f) => f.data))
          for (const f of rec.fields) if (!kept.has(f.data)) f.data.fill(0)
          m.index = undefined
          this.markChanged(s, uuid, 'edited')
          this.emit()
        }
        return ok({ uuid })
      }
      const r = createRecord(draft, { now, randomBytes: this.random })
      if (!r.ok) return r
      m.records.push(r.value)
      m.index = undefined
      const uuid = recordUuid(r.value)!
      this.markChanged(s, uuid, 'added')
      this.emit()
      return ok({ uuid })
    })
  }

  /** Removes an entry from memory; it leaves the file on the next save (counts as a change). */
  deleteEntry(uuid: string): Promise<Result<void>> {
    return this.run(async () => {
      const w = this.writable()
      if (!w.ok) return w
      const { s, m } = w.value
      const rec = this.findRecord(m, uuid)
      if (!rec) return err(ErrorCode.INVALID_ARGUMENT, 'No such entry.')
      const index = this.indexOf(m)
      const reason = readOnlyReasonOf(rec, index)
      if (reason !== undefined) return err(ErrorCode.RECORD_READ_ONLY, reason)
      if (hasDependants(rec, index)) return err(ErrorCode.RECORD_READ_ONLY, DEPENDANTS_TEXT)
      m.records.splice(index.position.get(rec)!, 1)
      m.index = undefined
      this.markChanged(s, recordUuid(rec)!, 'deleted')
      for (const f of rec.fields) f.data.fill(0)
      this.emit()
      return ok(undefined)
    })
  }

  /** Drops unsaved changes and reads the file again with the current password. */
  reloadFromDisk(): Promise<Result<VaultState>> {
    return this.run(async () => {
      const m = this.openModel()
      if (!m.ok) return m
      const s = this.session!
      if (await this.oversize(s.dbPath)) return err(ErrorCode.TOO_LARGE)
      let r
      try {
        r = await readDiskState(this.deps.fs, s.dbPath)
      } catch (e) {
        return err(ErrorCode.IO_ERROR, isNotFound(e) ? 'That file is no longer there.' : undefined)
      }
      const d = await decode(r.bytes, m.value.password, this.deps.codec)
      if (!d.ok) return d
      const password = m.value.password
      wipeModel(m.value)
      s.open = { header: d.value.header, records: d.value.records, meta: d.value.meta, password }
      if (d.value.meta.readOnlyReason === 'newer-format' && !s.readOnly) {
        s.readOnly = this.readOnly('newer-format')
      }
      s.disk = r.state
      s.changes.clear()
      this.emit()
      return ok(this.getState())
    })
  }

  // ── Saving ───────────────────────────────────────────────────────────────
  /**
   * Builds step 2 (encode + re-parse) and step 4 (verify) for the commit pipeline, with one
   * shared key stretch. Returns the stamped header the file will contain.
   */
  private savePlan(model: VaultModel, password: Uint8Array, iterations: number) {
    const stamped = stampHeaderForSave(model.header, {
      now: Math.floor(this.now() / 1000),
      application: this.deps.appName ?? 'psafe3 Opener',
      user: this.deps.identity.user,
      host: this.deps.identity.host,
    })
    const target: VaultModel = { header: stamped, records: model.records.slice() }
    const memo = memoStretch(this.deps.codec.stretch ?? stretchKeyInWorker)
    const codec: CodecDeps = { ...this.deps.codec, stretch: memo.fn }
    const check = async (bytes: Uint8Array, what: string): Promise<Result<void>> => {
      const d = await decode(bytes, password, codec)
      if (!d.ok) return err(ErrorCode.SAVE_FAILED, `${what} (${d.error.code})`)
      const same = modelsEqual(d.value, target)
      wipeModel(d.value)
      return same ? ok(undefined) : err(ErrorCode.SAVE_FAILED, `${what}: the data did not match`)
    }
    const produce = async (): Promise<Result<Uint8Array>> => {
      const e = await encode(target, password, codec, { iterations })
      if (!e.ok)
        return err(ErrorCode.SAVE_FAILED, `the file could not be encoded (${e.error.code})`)
      const c = await check(e.value, 'the encoded file did not read back')
      return c.ok ? ok(e.value) : c
    }
    const verify = (bytes: Uint8Array) => check(bytes, 'the new file on disk did not verify')
    return { stamped, target, produce, verify, done: memo.wipe }
  }

  /** Maps a commit outcome onto the session and the API result (§A5 outcome table). */
  private finishSave(
    s: Session,
    outcome: CommitOutcome,
    apply: (disk: DiskState) => void,
  ): Result<VaultState> {
    if (outcome.kind === 'failed') {
      if (outcome.code === 'FILE_CHANGED_ON_DISK') return err(ErrorCode.FILE_CHANGED_ON_DISK)
      return err(ErrorCode.SAVE_FAILED, outcome.detail)
    }
    apply(outcome.disk)
    s.changes.clear()
    s.banners = s.banners.filter(
      (b) => b.id !== 'rotation' && b.id !== 'backup-unknown' && b.id !== 'recovery',
    )
    if (outcome.rotation.kind !== 'done') s.banners.push(rotationUnfinishedBanner())
    this.emit()
    if (!outcome.durable) return err(ErrorCode.SAVED_DURABILITY_UNCONFIRMED)
    return ok(this.getState())
  }

  private async unknownBannerIfNeeded(s: Session, outcome: CommitOutcome): Promise<void> {
    if (outcome.kind === 'saved' && outcome.rotation.kind === 'unknown-state') {
      s.banners.push(unknownStateBanner(await listBackupFiles(this.deps.fs, sidecarsFor(s.dbPath))))
      this.emit()
    }
  }

  /** §A5 steps 1–10 on the active file. */
  save(): Promise<Result<VaultState>> {
    return this.run(() => this.saveNow())
  }

  private async saveNow(): Promise<Result<VaultState>> {
    const w = this.writable()
    if (!w.ok) return w
    const { s, m } = w.value
    if (!s.disk) return err(ErrorCode.IO_ERROR)
    const plan = this.savePlan(m, m.password, m.meta.iterations)
    try {
      const outcome = await commitReplace(
        this.commitDeps(),
        { dbPath: s.dbPath, openedPath: s.openedPath, expected: s.disk },
        plan.produce,
        plan.verify,
      )
      const result = this.finishSave(s, outcome, (disk) => {
        s.disk = disk
        replaceHeader(m, plan.stamped)
      })
      await this.unknownBannerIfNeeded(s, outcome)
      return result
    } finally {
      plan.done()
    }
  }

  /**
   * Save As… to `destination` (the path the user picked in the native dialog, which already asked
   * about replacing an existing file). §A5 Save As table: same file → Save; new path → link commit;
   * existing file → full steps 1–10 against it (it becomes its own .bak); a destination whose `.plk`
   * exists (another app, or this one) → LOCKED_BY_OTHER, nothing written. On success the
   * destination becomes the active file and the old `.plk` is released.
   */
  saveAs(destination: string): Promise<Result<VaultState>> {
    return this.run(async () => {
      const w = this.writable()
      if (!w.ok) return w
      const { s, m } = w.value
      const { fs } = this.deps
      if (typeof destination !== 'string' || destination === '') {
        return err(ErrorCode.INVALID_ARGUMENT)
      }
      const destAbs = resolve(destination)
      if (destAbs === s.openedPath) return this.saveNow()
      let exists: boolean
      let destReal: string
      try {
        try {
          await fs.lstat(destAbs)
          exists = true
        } catch (e) {
          if (!isNotFound(e)) throw e
          exists = false
        }
        if (exists) {
          destReal = await fs.realpath(destAbs)
          if (destReal === s.dbPath) return this.saveNow()
          const st = await fs.lstat(destReal)
          if (!st.isFile) return err(ErrorCode.IO_ERROR, 'That is not a file.')
        } else {
          destReal = join(await fs.realpath(dirname(destAbs)), basename(destAbs))
        }
      } catch (e) {
        return err(
          ErrorCode.IO_ERROR,
          isNotFound(e) ? 'That folder is no longer there.' : undefined,
        )
      }
      // Only one vault is open at a time: a destination sharing our lock name is "in use".
      if (lockPathFor(destReal) === lockPathFor(s.dbPath)) {
        return fail(ErrorCode.LOCKED_BY_OTHER, LOCKED_DESTINATION_TEXT)
      }
      const network = await this.isNetwork(dirname(destReal))
      // Strict for Save As: any existing .plk refuses (no own/orphan removal), hence network: true.
      const acq = await acquireLock(destReal, { ...this.lockEnv(network), network: true })
      if (acq.kind === 'held') return fail(ErrorCode.LOCKED_BY_OTHER, LOCKED_DESTINATION_TEXT)
      if (acq.kind !== 'acquired') {
        return err(
          ErrorCode.SAVE_FAILED,
          "Couldn't create a lock file next to that file, so nothing was written.",
        )
      }
      const destLock = acq.lock
      const plan = this.savePlan(m, m.password, m.meta.iterations)
      let outcome: CommitOutcome
      try {
        if (exists) {
          let expected: DiskState
          try {
            expected = (await readDiskState(fs, destReal)).state
          } catch {
            await releaseLock(fs, destLock)
            return err(ErrorCode.FILE_CHANGED_ON_DISK)
          }
          outcome = await commitReplace(
            this.commitDeps(),
            { dbPath: destReal, openedPath: destAbs, expected },
            plan.produce,
            plan.verify,
          )
        } else {
          const mode = s.disk?.mode ?? 0o600
          outcome = await commitNew(this.commitDeps(), destReal, mode, plan.produce, plan.verify)
        }
      } finally {
        plan.done()
      }
      if (outcome.kind === 'failed') {
        await releaseLock(fs, destLock)
        return this.finishSave(s, outcome, () => {})
      }
      const oldLock = s.lock
      const result = this.finishSave(s, outcome, (disk) => {
        s.disk = disk
        s.openedPath = destAbs
        s.dbPath = destReal
        s.fileName = basename(destAbs)
        s.lock = destLock
        s.network = network
        s.banners = network ? [{ ...NETWORK_BANNER }] : []
        replaceHeader(m, plan.stamped)
        this.dropPreview(s)
      })
      if (oldLock) await releaseLock(fs, oldLock)
      await this.unknownBannerIfNeeded(s, outcome)
      return result
    })
  }

  // ── Backups ──────────────────────────────────────────────────────────────
  private async backups(s: Session): Promise<(BackupInfo & { path: string })[]> {
    const sc = sidecarsFor(s.dbPath)
    const out: (BackupInfo & { path: string })[] = []
    for (const gen of GENERATIONS) {
      const path = sc.backup(gen)
      try {
        const st = await this.deps.fs.lstat(path)
        if (!st.isFile) continue
        out.push({
          id: `b${gen}-${st.ino}-${Math.round(st.mtimeMs)}-${st.size}`,
          generation: gen,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          sizeBytes: st.size,
          path,
        })
      } catch {
        // Missing generation.
      }
    }
    return out
  }

  /** The backup generations next to the file, newest first. */
  listBackups(): Promise<Result<BackupInfo[]>> {
    return this.run(async () => {
      const m = this.openModel()
      if (!m.ok) return m
      return ok((await this.backups(this.session!)).map(({ path: _p, ...b }) => b))
    })
  }

  /**
   * Opens a backup read-only for preview with its own password (it may be an older one). Nothing
   * is written. The preview is kept until lock, close, another preview or a restore.
   */
  previewBackup(id: string, password: Uint8Array): Promise<Result<Entry[]>> {
    return this.run(async () => {
      const m = this.openModel()
      if (!m.ok) return m
      const s = this.session!
      const b = (await this.backups(s)).find((x) => x.id === id)
      if (!b) return err(ErrorCode.IO_ERROR, 'That backup is gone.')
      if (b.sizeBytes > MAX_FILE_BYTES) return err(ErrorCode.TOO_LARGE)
      let bytes: Uint8Array
      try {
        bytes = await this.deps.fs.readFile(b.path)
      } catch {
        return err(ErrorCode.IO_ERROR, 'That backup could not be read.')
      }
      const pw = Buffer.from(password)
      const d = await decode(bytes, pw, this.deps.codec)
      if (!d.ok) {
        pw.fill(0)
        return d
      }
      this.dropPreview(s)
      s.preview = {
        id,
        path: b.path,
        sha256: sha256Hex(bytes),
        model: { header: d.value.header, records: d.value.records },
        meta: d.value.meta,
        password: pw,
      }
      const entries = buildEntries(d.value.records).map((e) => ({
        ...e,
        editable: false,
        readOnlyReason: READ_ONLY_TEXT['backup-preview'],
      }))
      return ok(entries)
    })
  }

  /**
   * Replaces the current file with the previewed backup through steps 1–10, so the current file
   * becomes `.bak` and nothing is lost. The restored content keeps the backup's password, which
   * becomes the vault's password. Unsaved changes are dropped (the caller asks first).
   */
  restoreBackup(id: string): Promise<Result<VaultState>> {
    return this.run(async () => {
      const w = this.writable()
      if (!w.ok) return w
      const { s, m } = w.value
      const p = s.preview
      if (!p || p.id !== id) return err(ErrorCode.INVALID_ARGUMENT, 'Preview the backup first.')
      if (p.meta.readOnlyReason) {
        return fail(ErrorCode.READ_ONLY, DEFAULT_MESSAGES.READ_ONLY, READ_ONLY_TEXT['newer-format'])
      }
      try {
        if (sha256Hex(await this.deps.fs.readFile(p.path)) !== p.sha256) {
          return err(ErrorCode.IO_ERROR, 'That backup changed. Preview it again.')
        }
      } catch {
        return err(ErrorCode.IO_ERROR, 'That backup is gone.')
      }
      if (!s.disk) return err(ErrorCode.IO_ERROR)
      const restored = copyModel(p.model)
      const plan = this.savePlan(restored, p.password, p.meta.iterations)
      let outcome: CommitOutcome
      try {
        outcome = await commitReplace(
          this.commitDeps(),
          { dbPath: s.dbPath, openedPath: s.openedPath, expected: s.disk },
          plan.produce,
          plan.verify,
        )
      } finally {
        plan.done()
      }
      const result = this.finishSave(s, outcome, (disk) => {
        s.disk = disk
        const password = Buffer.from(p.password)
        wipeModel(m)
        m.password.fill(0)
        s.open = { header: plan.stamped, records: restored.records, meta: p.meta, password }
        // The preview's buffers now back the active model; only zero its password copy.
        p.password.fill(0)
        s.preview = undefined
      })
      await this.unknownBannerIfNeeded(s, outcome)
      return result
    })
  }

  // ── Export ───────────────────────────────────────────────────────────────
  /**
   * The current model (with unsaved edits) for WP4's buildXmlExport. The returned arrays are
   * copies, but the field bytes are shared: use them before the next lock, which zeroes them.
   */
  getExportData(): Result<{ header: RawField[]; records: RawRecord[]; databaseName: string }> {
    const m = this.openModel()
    if (!m.ok) return m
    return ok({
      header: m.value.header.slice(),
      records: m.value.records.map((r) => ({ fields: r.fields.slice() })),
      databaseName: this.session!.fileName,
    })
  }
}
