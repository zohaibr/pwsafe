// In-memory mock of `PsafeApi` for UI development and tests (WP3). It can drive every
// §A4/§A5/§A6 error code and outcome row: pick a recent file whose scenario you want, or set the
// `next*` controls before a save, Save As, reload or export. WP7 replaces it with the real bridge.
import { DEFAULT_MESSAGES, fail, ok, type ErrorCode, type Result } from '@shared/errors'
import type { CopyResult, RecentFile } from '@shared/ipc'
import {
  BACKUP_GENERATIONS,
  CLIPBOARD_CLEAR_MS,
  IDLE_LOCK_DEFAULT_MIN,
  IDLE_LOCK_MAX_MIN,
  IDLE_LOCK_MIN_MIN,
} from '@shared/limits'
import type {
  Banner,
  Entry,
  EntryDraft,
  GroupNode,
  ReadOnlyReason,
  Settings,
  VaultState,
} from '@shared/types'
import type { LockChoice, RendererApi } from '../src/api'
import { DEFAULT_GENERATOR } from '../src/defaults'
import { MOCK_MASTER_PASSWORD, sampleBackups, sampleEntries } from './sampleData'

/** How a mock file behaves when chosen and unlocked. */
export type MockFileScenario =
  | 'normal'
  | 'slow'
  | 'locked-by-other'
  | 'newer-format'
  | 'lock-not-created'
  | 'windows-v1'
  | 'network-volume'
  | 'recovered'
  | 'backup-unknown-state'
  | 'unsupported'
  | 'too-large'
  | 'corrupt'
  | 'integrity'
  | 'io-error'

export interface MockFile {
  id: string
  fileName: string
  folder: string
  scenario: MockFileScenario
}

export type SaveOutcome =
  'ok' | 'conflict' | 'failed' | 'rotation-incomplete' | 'durability' | 'read-only' | 'io-error'
export type SaveAsOutcome = 'ok' | 'cancel' | 'locked' | 'conflict' | 'failed'
export type ExportOutcome = 'ok' | 'cancel' | 'io-error'

export interface MockControls {
  files: MockFile[]
  /** File returned by the native "Open" dialog; null simulates Cancel. */
  chooseFileResult: string | null
  nextSave: SaveOutcome
  nextSaveAs: SaveAsOutcome
  nextExport: ExportOutcome
  nextReload: 'ok' | 'io-error'
  /** Delay before every call resolves, to make async states visible. */
  latencyMs: number
  /** Slow unlock: progress ticks (20 ticks from 0 to 1). */
  slowUnlockTickMs: number
  /** Method names called, in order. Arguments are never recorded (they may be secrets). */
  calls: string[]
  /** Answers the renderer gave to close requests. */
  closeResponses: Array<'save' | 'discard' | 'cancel'>
  /** Simulated clipboard: which entry field was copied last (never the value). */
  clipboard: { uuid: string; field: string } | null
  /** Idle/sleep/minimise lock: keeps unsaved changes in memory (§B3). */
  autoLock(): void
  /** Simulates the user quitting or closing the window. */
  requestClose(reason: 'quit' | 'close-window'): void
  /** Current state, for tests. */
  state(): VaultState
}

export const MOCK_FILES: MockFile[] = [
  { id: 'f-personal', fileName: 'Personal.psafe3', folder: '~/Documents', scenario: 'normal' },
  { id: 'f-archive', fileName: 'Archive-2019.psafe3', folder: '~/Documents', scenario: 'slow' },
  {
    id: 'f-team',
    fileName: 'Team-shared.psafe3',
    folder: '~/Dropbox/Team',
    scenario: 'locked-by-other',
  },
  {
    id: 'f-newer',
    fileName: 'From-new-pwsafe.psafe3',
    folder: '~/Downloads',
    scenario: 'newer-format',
  },
  {
    id: 'f-usb',
    fileName: 'USB-stick.psafe3',
    folder: '/Volumes/DEMO',
    scenario: 'lock-not-created',
  },
  {
    id: 'f-win',
    fileName: 'Windows-copy.psafe3',
    folder: 'C:\\Users\\sam',
    scenario: 'windows-v1',
  },
  { id: 'f-nas', fileName: 'Household.psafe3', folder: '/Volumes/nas', scenario: 'network-volume' },
  { id: 'f-recovered', fileName: 'Recovered.psafe3', folder: '~/Documents', scenario: 'recovered' },
  {
    id: 'f-unknown',
    fileName: 'Messy-backups.psafe3',
    folder: '~/Documents',
    scenario: 'backup-unknown-state',
  },
  { id: 'f-v4', fileName: 'Newer-format.psafe4', folder: '~/Downloads', scenario: 'unsupported' },
  { id: 'f-big', fileName: 'Huge.psafe3', folder: '~/Downloads', scenario: 'too-large' },
  { id: 'f-corrupt', fileName: 'Damaged.psafe3', folder: '~/Downloads', scenario: 'corrupt' },
  { id: 'f-tamper', fileName: 'Tampered.psafe3', folder: '~/Downloads', scenario: 'integrity' },
  { id: 'f-io', fileName: 'Unreadable.psafe3', folder: '/Volumes/gone', scenario: 'io-error' },
]

const READ_ONLY_TEXT: Record<ReadOnlyReason, string> = {
  'newer-format': 'Made by a newer Password Safe; editing disabled to avoid losing data.',
  'locked-by-other': 'Opened read-only because another app has this file open.',
  'lock-not-created':
    "Opened read-only because this app couldn't create a lock file next to it (the folder or drive is read-only).",
  'windows-v1':
    "Opened read-only. On Windows this version can't lock the file the way Password Safe does, so editing is turned off to avoid lost updates.",
  'backup-preview': 'You are looking at a backup. It is read-only.',
}

const DEFAULT_SETTINGS: Settings = {
  idleLockMinutes: IDLE_LOCK_DEFAULT_MIN,
  lockOnMinimize: false,
  generator: DEFAULT_GENERATOR,
}

const err = <T>(code: ErrorCode, detail?: string): Result<T> =>
  fail<T>(code, DEFAULT_MESSAGES[code], detail)

/** Splits a stored group path on unescaped dots. */
export function splitGroupPath(path: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === '\\' && path[i + 1] === '.') {
      cur += '\\.'
      i++
    } else if (c === '.') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts.filter((p) => p !== '')
}

export function buildGroupTree(entries: Entry[]): GroupNode[] {
  const roots: GroupNode[] = []
  for (const e of entries) {
    const parts = splitGroupPath(e.group)
    let level = roots
    let path = ''
    parts.forEach((part, i) => {
      path = path ? `${path}.${part}` : part
      let node = level.find((n) => n.path === path)
      if (!node) {
        node = { path, name: part.replace(/\\\./g, '.'), entryCount: 0, children: [] }
        level.push(node)
      }
      node.entryCount++
      if (i < parts.length - 1) level = node.children
    })
  }
  const sort = (nodes: GroupNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((n) => sort(n.children))
  }
  sort(roots)
  return roots
}

export function createMockApi(init: Partial<MockControls> = {}): {
  api: RendererApi
  controls: MockControls
} {
  let state: VaultState = { status: 'no-file', dirtyCount: 0, banners: [] }
  let file: MockFile | null = null
  let entries: Entry[] = []
  let settings: Settings = structuredClone(DEFAULT_SETTINGS)
  let unlockTimer: ReturnType<typeof setTimeout> | null = null
  let cancelPendingUnlock: (() => void) | null = null
  let backups = sampleBackups()
  let nextUuid = 100
  const stateListeners = new Set<(s: VaultState) => void>()
  const closeListeners = new Set<(r: 'quit' | 'close-window') => void>()

  const controls: MockControls = {
    files: MOCK_FILES,
    chooseFileResult: 'f-personal',
    nextSave: 'ok',
    nextSaveAs: 'ok',
    nextExport: 'ok',
    nextReload: 'ok',
    latencyMs: 0,
    slowUnlockTickMs: 150,
    calls: [],
    closeResponses: [],
    clipboard: null,
    autoLock() {
      if (state.status !== 'open') return
      // §B3: changes are re-encrypted in memory and come back after unlock, still unsaved.
      setState({ status: 'locked', readOnly: undefined, unlockProgress: undefined })
    },
    requestClose(reason) {
      closeListeners.forEach((l) => l(reason))
    },
    state: () => structuredClone(state),
    ...init,
  }

  function setState(patch: Partial<VaultState>): VaultState {
    state = { ...state, ...patch }
    for (const key of Object.keys(state) as Array<keyof VaultState>) {
      if (state[key] === undefined) delete state[key]
    }
    const snapshot = structuredClone(state)
    stateListeners.forEach((l) => l(structuredClone(snapshot)))
    return snapshot
  }

  async function call<T>(
    name: string,
    fn: () => Result<T> | Promise<Result<T>>,
  ): Promise<Result<T>> {
    controls.calls.push(name)
    if (controls.latencyMs > 0) await new Promise((r) => setTimeout(r, controls.latencyMs))
    return fn()
  }

  const needOpen = <T>(): Result<T> | null =>
    state.status === 'open' ? null : err<T>('VAULT_LOCKED')
  const needWritable = <T>(): Result<T> | null =>
    needOpen<T>() ?? (state.readOnly ? err<T>('READ_ONLY', state.readOnly.text) : null)

  const publicEntry = (e: Entry): Entry => ({ ...structuredClone(e), password: '' })
  const find = (uuid: string) => entries.find((e) => e.uuid === uuid)

  function selectFile(id: string): Result<{ fileName: string }> {
    const f = controls.files.find((x) => x.id === id)
    if (!f) return err('IO_ERROR', 'That file is no longer there.')
    if (f.scenario === 'unsupported') return err('UNSUPPORTED_FORMAT')
    if (f.scenario === 'too-large') return err('TOO_LARGE')
    if (f.scenario === 'io-error') return err('IO_ERROR', 'The drive is not connected.')
    file = f
    entries = []
    setState({
      status: 'locked',
      fileName: f.fileName,
      dirtyCount: 0,
      banners: [],
      readOnly: undefined,
      unlockProgress: undefined,
    })
    return ok({ fileName: f.fileName })
  }

  function openedState(f: MockFile, choice?: LockChoice): VaultState {
    const banners: Banner[] = []
    let readOnly: VaultState['readOnly']
    const ro = (reason: ReadOnlyReason) => ({ reason, text: READ_ONLY_TEXT[reason] })
    if (f.scenario === 'newer-format') readOnly = ro('newer-format')
    if (f.scenario === 'lock-not-created') readOnly = ro('lock-not-created')
    if (f.scenario === 'windows-v1') readOnly = ro('windows-v1')
    if (f.scenario === 'locked-by-other' && choice === 'read-only') readOnly = ro('locked-by-other')
    if (f.scenario === 'network-volume')
      banners.push({
        kind: 'warning',
        id: 'network',
        text: 'File is on a network drive; make sure no one else has it open.',
      })
    if (f.scenario === 'recovered')
      banners.push({
        kind: 'info',
        id: 'recovery',
        text: 'Finished an interrupted backup rotation from the last save. Your file and all 3 backups are in place.',
      })
    if (f.scenario === 'backup-unknown-state')
      banners.push({
        kind: 'warning',
        id: 'backup-unknown',
        text: 'Backups are in an unexpected state, so nothing was moved or deleted. Files: Messy-backups.psafe3.bak, Messy-backups.psafe3.bak2, .Messy-backups.psafe3.k3j9.bak-staged. Restore by hand if you need one.',
      })
    // Auto-lock keeps edits in memory (§B3); a fresh open starts clean.
    const keepEdits = state.dirtyCount > 0 && entries.length > 0
    if (!keepEdits) entries = sampleEntries()
    return setState({
      status: 'open',
      fileName: f.fileName,
      readOnly,
      banners,
      unlockProgress: undefined,
      dirtyCount: keepEdits ? state.dirtyCount : 0,
    })
  }

  function doUnlock(password: string, choice?: LockChoice): Promise<Result<VaultState>> {
    const f = file
    if (!f || state.status === 'no-file') return Promise.resolve(err('IO_ERROR', 'No file chosen.'))
    if (state.status === 'open') return Promise.resolve(ok(structuredClone(state)))
    const finish = (): Result<VaultState> => {
      if (password !== MOCK_MASTER_PASSWORD) {
        setState({ status: 'locked', unlockProgress: undefined })
        return err('WRONG_PASSWORD')
      }
      if (f.scenario === 'corrupt') {
        setState({ status: 'locked', unlockProgress: undefined })
        return err('CORRUPT_FILE', 'A record is missing its end marker.')
      }
      if (f.scenario === 'integrity') {
        setState({ status: 'locked', unlockProgress: undefined })
        return err('INTEGRITY_FAILED')
      }
      if (f.scenario === 'locked-by-other' && !choice) {
        setState({ status: 'locked', unlockProgress: undefined })
        return err('LOCKED_BY_OTHER', 'alex@studio-mac:4312')
      }
      return ok(openedState(f, choice))
    }
    if (f.scenario !== 'slow') return Promise.resolve(finish())
    // Slow file: progress from the key-stretch worker, cancellable (§A1, §B9).
    return new Promise((resolve) => {
      let tick = 0
      setState({ status: 'unlocking', unlockProgress: 0 })
      cancelPendingUnlock = () => {
        if (unlockTimer) clearTimeout(unlockTimer)
        unlockTimer = null
        cancelPendingUnlock = null
        setState({ status: 'locked', unlockProgress: undefined })
        resolve(err('CANCELLED'))
      }
      const step = () => {
        tick++
        if (tick >= 20) {
          unlockTimer = null
          cancelPendingUnlock = null
          resolve(finish())
          return
        }
        setState({ unlockProgress: tick / 20 })
        unlockTimer = setTimeout(step, controls.slowUnlockTickMs)
      }
      unlockTimer = setTimeout(step, controls.slowUnlockTickMs)
    })
  }

  function lockNow(): VaultState {
    controls.clipboard = null
    entries = []
    return setState({ status: 'locked', dirtyCount: 0, readOnly: undefined, banners: [] })
  }

  function saveOutcome(outcome: SaveOutcome): Result<VaultState> {
    switch (outcome) {
      case 'conflict':
        return err('FILE_CHANGED_ON_DISK')
      case 'failed':
        return err('SAVE_FAILED', 'Step 4: the new file could not be read back from disk.')
      case 'read-only':
        return err('READ_ONLY')
      case 'io-error':
        return err('IO_ERROR', 'The disk is full.')
      case 'durability':
        setState({ dirtyCount: 0 })
        return err('SAVED_DURABILITY_UNCONFIRMED')
      case 'rotation-incomplete':
        return ok(
          setState({
            dirtyCount: 0,
            banners: [
              ...state.banners.filter((b) => b.id !== 'rotation'),
              {
                kind: 'info',
                id: 'rotation',
                text: "Saved. Backup rotation didn't finish; it will complete next time you open this file.",
              },
            ],
          }),
        )
      case 'ok':
        backups = [
          {
            id: `bak-${Date.now()}`,
            generation: 1,
            modifiedAt: new Date().toISOString(),
            sizeBytes: 12_900,
          },
          ...backups.map((b) => ({ ...b, generation: b.generation + 1 })),
        ].slice(0, BACKUP_GENERATIONS)
        return ok(setState({ dirtyCount: 0 }))
    }
  }

  const api: RendererApi = {
    chooseFile: () =>
      call('chooseFile', () => {
        if (controls.chooseFileResult === null) return ok(null)
        return selectFile(controls.chooseFileResult)
      }),
    listRecentFiles: () =>
      call('listRecentFiles', () =>
        ok<RecentFile[]>(
          controls.files.map(({ id, fileName, folder }) => ({ id, fileName, folder })),
        ),
      ),
    chooseRecentFile: (id) => call('chooseRecentFile', () => selectFile(id)),
    unlock: (password) => call('unlock', () => doUnlock(password)),
    unlockWithLockChoice: (password, choice) =>
      call('unlockWithLockChoice', () => doUnlock(password, choice)),
    cancelUnlock: () =>
      call('cancelUnlock', () => {
        cancelPendingUnlock?.()
        return ok(undefined)
      }),
    lock: () => call('lock', () => (state.status === 'no-file' ? err('IO_ERROR') : ok(lockNow()))),
    getState: () => call('getState', () => ok(structuredClone(state))),
    closeFile: () =>
      call('closeFile', () => {
        lockNow()
        file = null
        return ok(setState({ status: 'no-file', fileName: undefined, dirtyCount: 0 }))
      }),
    listEntries: () =>
      call('listEntries', () => needOpen<Entry[]>() ?? ok(entries.map(publicEntry))),
    listGroups: () =>
      call('listGroups', () => needOpen<GroupNode[]>() ?? ok(buildGroupTree(entries))),
    getEntry: (uuid) =>
      call('getEntry', () => {
        const blocked = needOpen<Entry>()
        if (blocked) return blocked
        const e = find(uuid)
        return e ? ok(publicEntry(e)) : err('INVALID_ARGUMENT', 'No such entry.')
      }),
    revealPassword: (uuid) =>
      call('revealPassword', () => {
        const blocked = needOpen<string>()
        if (blocked) return blocked
        const e = find(uuid)
        if (!e) return err('INVALID_ARGUMENT', 'No such entry.')
        const base = e.baseUuid ? find(e.baseUuid) : undefined
        return ok(base ? base.password : e.password)
      }),
    copyField: (uuid, field) =>
      call('copyField', () => {
        const blocked = needOpen<CopyResult>()
        if (blocked) return blocked
        if (!find(uuid)) return err('INVALID_ARGUMENT', 'No such entry.')
        controls.clipboard = { uuid, field }
        return ok({ clearsAt: Date.now() + CLIPBOARD_CLEAR_MS })
      }),
    saveEntry: (draft: EntryDraft) =>
      call('saveEntry', () => {
        const blocked = needWritable<{ uuid: string }>()
        if (blocked) return blocked
        const now = new Date().toISOString()
        if (draft.uuid) {
          const e = find(draft.uuid)
          if (!e) return err('INVALID_ARGUMENT', 'No such entry.')
          if (!e.editable) return err('RECORD_READ_ONLY', e.readOnlyReason)
          const { password, ...rest } = draft
          delete rest.uuid
          Object.assign(e, rest, { modified: now })
          if (password !== undefined) Object.assign(e, { password, passwordModified: now })
          setState({ dirtyCount: state.dirtyCount + 1 })
          return ok({ uuid: e.uuid })
        }
        const uuid = `5f2c1a6e-new0-4d1a-9a55-${String(nextUuid++).padStart(12, '0')}`
        entries.push({
          uuid,
          title: draft.title ?? '',
          group: draft.group ?? '',
          username: draft.username ?? '',
          password: draft.password ?? '',
          url: draft.url ?? '',
          email: draft.email ?? '',
          notes: draft.notes ?? '',
          created: now,
          modified: now,
          passwordModified: now,
          kind: 'normal',
          editable: true,
          flags: {
            hasHistory: false,
            hasTotp: false,
            hasAttachment: false,
            hasPasskey: false,
            hasCreditCard: false,
            hasCustomFields: false,
            extraFieldCount: 0,
          },
        })
        setState({ dirtyCount: state.dirtyCount + 1 })
        return ok({ uuid })
      }),
    deleteEntry: (uuid) =>
      call('deleteEntry', () => {
        const blocked = needWritable<void>()
        if (blocked) return blocked
        const e = find(uuid)
        if (!e) return err('INVALID_ARGUMENT', 'No such entry.')
        if (!e.editable) return err('RECORD_READ_ONLY', e.readOnlyReason)
        if (e.kind === 'aliasBase' || e.kind === 'shortcutBase')
          return err('RECORD_READ_ONLY', 'Other entries depend on this one.')
        entries = entries.filter((x) => x.uuid !== uuid)
        setState({ dirtyCount: state.dirtyCount + 1 })
        return ok(undefined)
      }),
    reloadFromDisk: () =>
      call('reloadFromDisk', () => {
        const blocked = needOpen<VaultState>()
        if (blocked) return blocked
        if (controls.nextReload === 'io-error') {
          controls.nextReload = 'ok'
          return err('IO_ERROR', 'The file could not be read.')
        }
        entries = sampleEntries()
        return ok(setState({ dirtyCount: 0 }))
      }),
    save: () =>
      call('save', () => {
        const blocked = needOpen<VaultState>()
        if (blocked) return blocked
        if (state.readOnly) return err('READ_ONLY', state.readOnly.text)
        const outcome = controls.nextSave
        controls.nextSave = 'ok'
        return saveOutcome(outcome)
      }),
    saveAs: () =>
      call('saveAs', () => {
        const blocked = needOpen<VaultState | null>()
        if (blocked) return blocked
        if (state.readOnly) return err('READ_ONLY', state.readOnly.text)
        const outcome = controls.nextSaveAs
        controls.nextSaveAs = 'ok'
        if (outcome === 'cancel') return ok(null)
        if (outcome === 'locked') return err('LOCKED_BY_OTHER', 'That file is open in another app.')
        if (outcome === 'conflict')
          return err('FILE_CHANGED_ON_DISK', 'A file appeared at that path.')
        if (outcome === 'failed') return err('SAVE_FAILED', 'Step 3: permission denied.')
        return ok(setState({ dirtyCount: 0, fileName: 'Personal (copy).psafe3', banners: [] }))
      }),
    listBackups: () => call('listBackups', () => needOpen() ?? ok(structuredClone(backups))),
    previewBackup: (id, password) =>
      call('previewBackup', () => {
        const blocked = needOpen<Entry[]>()
        if (blocked) return blocked
        if (!backups.some((b) => b.id === id)) return err('IO_ERROR', 'That backup is gone.')
        if (password !== MOCK_MASTER_PASSWORD) return err('WRONG_PASSWORD')
        const preview = sampleEntries()
          .slice(0, 9)
          .map((e) => ({ ...e, password: '', editable: false, readOnlyReason: 'Backup preview' }))
        return ok(preview)
      }),
    restoreBackup: (id) =>
      call('restoreBackup', () => {
        const blocked = needWritable<VaultState>()
        if (blocked) return blocked
        if (!backups.some((b) => b.id === id)) return err('IO_ERROR', 'That backup is gone.')
        entries = sampleEntries().slice(0, 9)
        return ok(setState({ dirtyCount: 0 }))
      }),
    exportXml: (options) =>
      call('exportXml', () => {
        const blocked = needOpen<null>()
        if (blocked) return blocked
        const outcome = controls.nextExport
        controls.nextExport = 'ok'
        if (outcome === 'cancel') return ok(null)
        if (outcome === 'io-error') return err('IO_ERROR', 'The folder is not writable.')
        const scope = options.scope
        const inScope = entries.filter(
          (e) =>
            scope.kind === 'all' || e.group === scope.path || e.group.startsWith(`${scope.path}.`),
        )
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const base = (state.fileName ?? 'export').replace(/\.psafe3$/, '')
        return ok({
          filePath: `~/Downloads/${base}-export-${stamp}.xml`,
          entryCount: inScope.length,
          entriesWithOmittedFields: inScope.filter(
            (e) => e.flags.hasAttachment || e.flags.hasPasskey || e.flags.hasCustomFields,
          ).length,
        })
      }),
    revealInFolder: () => call('revealInFolder', () => ok(undefined)),
    getSettings: () => call('getSettings', () => ok(structuredClone(settings))),
    setSettings: (next) =>
      call('setSettings', () => {
        const m = next.idleLockMinutes
        if (!Number.isInteger(m) || m < IDLE_LOCK_MIN_MIN || m > IDLE_LOCK_MAX_MIN)
          return err('INVALID_ARGUMENT', 'Idle time must be 1 to 60 minutes.')
        settings = structuredClone(next)
        return ok(structuredClone(settings))
      }),
    onStateChanged: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onCloseRequested: (listener) => {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    respondToClose: (choice) =>
      call('respondToClose', () => {
        controls.closeResponses.push(choice)
        return ok(undefined)
      }),
    reportActivity: () => {
      controls.calls.push('reportActivity')
    },
  }

  return { api, controls }
}
