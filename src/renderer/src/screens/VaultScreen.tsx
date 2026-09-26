import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { DEFAULT_MESSAGES, type AppError } from '@shared/errors'
import { SIDEBAR_COLLAPSE_WIDTH } from '@shared/limits'
import type { Entry, ExportResult, GroupNode, VaultState } from '@shared/types'
import { useApi } from '../api'
import { BannerRow, ReadOnlyBanner } from '../components/Feedback'
import { Icon } from '../components/Icons'
import { isModalOpen } from '../components/Modal'
import { ClipboardToast, NoticeToast, type Notice } from '../components/Toasts'
import { ExportDialog } from '../dialogs/ExportDialog'
import { RestoreDialog } from '../dialogs/RestoreDialog'
import { SettingsDialog } from '../dialogs/SettingsDialog'
import {
  ConflictDialog,
  DeleteDialog,
  ErrorDialog,
  UnsavedDialog,
  type UnsavedAction,
} from '../dialogs/SimpleDialogs'
import { displayGroup, inGroup, isMac, shortcutLabel, useWindowWidth } from '../hooks'
import { EntryDetail, deleteBlockedReason } from './EntryDetail'
import { EntryEditor } from './EntryEditor'
import { EntryList } from './EntryList'
import { GroupTree } from './GroupTree'

export interface CloseRequest {
  reason: 'quit' | 'close-window'
  /** The user chose "Unlock and save" while locked: save as soon as the vault is open. */
  saveNow: boolean
}

type Dialog =
  | { kind: 'delete'; entry: Entry; error: AppError | null }
  | { kind: 'unsaved'; action: UnsavedAction; error: AppError | null }
  | { kind: 'conflict'; error: AppError | null }
  | { kind: 'error'; error: AppError }
  | { kind: 'restore' }
  | { kind: 'export' }
  | { kind: 'settings' }

const appError = (code: AppError['code'], detail?: string): AppError =>
  detail === undefined
    ? { code, message: DEFAULT_MESSAGES[code] }
    : { code, message: DEFAULT_MESSAGES[code], detail }

function flattenGroups(nodes: GroupNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.path)
    flattenGroups(n.children, out)
  }
  return out
}

function findGroupName(nodes: GroupNode[], path: string): string | undefined {
  for (const n of nodes) {
    if (n.path === path) return n.name
    const inner = findGroupName(n.children, path)
    if (inner) return inner
  }
  return undefined
}

function matches(e: Entry, q: string): boolean {
  if (!q) return true
  const needle = q.toLocaleLowerCase()
  return [e.title, e.username, e.url, e.email, e.notes, displayGroup(e.group)].some((v) =>
    v.toLocaleLowerCase().includes(needle),
  )
}

/** The open vault: toolbar, groups, entry list and details, and every dialog they can raise. */
export function VaultScreen(props: {
  state: VaultState
  onState: (s: VaultState) => void
  closeRequest: CloseRequest | null
  onCloseHandled: () => void
}) {
  const api = useApi()
  const { state, onState, closeRequest, onCloseHandled } = props
  const readOnly = state.readOnly !== undefined
  const fileName = state.fileName ?? 'This file'

  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [groups, setGroups] = useState<GroupNode[]>([])
  const [group, setGroup] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ uuid: string | null } | null>(null)
  const [revision, setRevision] = useState(0)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [clip, setClip] = useState<{ label: string; clearsAt: number } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const narrow = useWindowWidth() < SIDEBAR_COLLAPSE_WIDTH
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusedOnce = useRef(false)

  const showNotice = (n: Omit<Notice, 'id'>) =>
    setNotice((prev) => ({ ...n, id: (prev?.id ?? 0) + 1 }))

  const load = useCallback(() => Promise.all([api.listEntries(), api.listGroups()]), [api])
  const apply = ([e, g]: Awaited<ReturnType<typeof load>>) => {
    if (e.ok) setEntries(e.value)
    else setDialog({ kind: 'error', error: e.error })
    if (g.ok) setGroups(g.value)
  }
  const refresh = async () => apply(await load())

  useEffect(() => {
    let live = true
    void load().then(([e, g]) => {
      if (!live) return
      if (e.ok) setEntries(e.value)
      else setDialog({ kind: 'error', error: e.error })
      if (g.ok) setGroups(g.value)
    })
    return () => {
      live = false
    }
  }, [load])

  useEffect(() => {
    if (entries && !focusedOnce.current) {
      focusedOnce.current = true
      listRef.current?.focus()
    }
  }, [entries])

  const visible = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => inGroup(e.group, group) && matches(e, query))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries, group, query],
  )

  const focusList = () => requestAnimationFrame(() => listRef.current?.focus())

  // ── Save and friends (§A5 outcomes) ─────────────────────────────────────
  const runSave = async (): Promise<boolean> => {
    if (readOnly) {
      setDialog({ kind: 'error', error: appError('READ_ONLY', state.readOnly?.text) })
      return false
    }
    setBusy(true)
    const r = await api.save()
    setBusy(false)
    return handleSaveResult(r)
  }

  const handleSaveResult = async (r: Awaited<ReturnType<typeof api.save>>): Promise<boolean> => {
    if (r.ok) {
      onState(r.value)
      setRevision((v) => v + 1)
      showNotice({ tone: 'success', text: 'Saved.', transient: true })
      return true
    }
    if (r.error.code === 'SAVED_DURABILITY_UNCONFIRMED') {
      // Saved (§A5 row 9): not a failure, but the user should know.
      const s = await api.getState()
      if (s.ok) onState(s.value)
      setRevision((v) => v + 1)
      showNotice({ tone: 'warning', text: r.error.message })
      return true
    }
    if (r.error.code === 'FILE_CHANGED_ON_DISK') setDialog({ kind: 'conflict', error: null })
    else setDialog({ kind: 'error', error: r.error })
    return false
  }

  const runSaveAs = async (fromConflict: boolean) => {
    setBusy(true)
    const r = await api.saveAs()
    setBusy(false)
    if (r.ok) {
      if (r.value === null) return
      onState(r.value)
      setDialog(null)
      setRevision((v) => v + 1)
      showNotice({ tone: 'success', text: `Saved as ${r.value.fileName ?? 'a new file'}.` })
      void refresh()
      return
    }
    if (r.error.code === 'SAVED_DURABILITY_UNCONFIRMED') {
      const s = await api.getState()
      if (s.ok) onState(s.value)
      setDialog(null)
      showNotice({ tone: 'warning', text: r.error.message })
      return
    }
    setDialog(
      fromConflict ? { kind: 'conflict', error: r.error } : { kind: 'error', error: r.error },
    )
  }

  const runReload = async () => {
    setBusy(true)
    const r = await api.reloadFromDisk()
    setBusy(false)
    if (!r.ok) {
      setDialog({ kind: 'conflict', error: r.error })
      return
    }
    onState(r.value)
    setDialog(null)
    setEditor(null)
    setRevision((v) => v + 1)
    showNotice({ tone: 'info', text: 'Reloaded the file from disk.', transient: true })
    void refresh()
  }

  const doLock = async (discardChanges = false) => {
    const r = await api.lock(discardChanges ? { discardChanges: true } : undefined)
    if (r.ok) onState(r.value)
    else setDialog({ kind: 'error', error: r.error })
  }

  const doClose = async () => {
    const r = await api.closeFile()
    if (r.ok) onState(r.value)
    else setDialog({ kind: 'error', error: r.error })
  }

  const doOpenOther = async () => {
    const r = await api.chooseFile()
    if (!r.ok) {
      setDialog({ kind: 'error', error: r.error })
      return
    }
    if (r.value === null) return
    const s = await api.getState()
    if (s.ok) onState(s.value)
  }

  const guarded = (action: 'lock' | 'close' | 'open-other') => {
    setMenuOpen(false)
    if (state.dirtyCount > 0) {
      setDialog({ kind: 'unsaved', action, error: null })
      return
    }
    if (action === 'lock') void doLock()
    else if (action === 'close') void doClose()
    else void doOpenOther()
  }

  const unsavedAction: UnsavedAction | null =
    dialog?.kind === 'unsaved'
      ? dialog.action
      : closeRequest && !closeRequest.saveNow
        ? closeRequest.reason
        : null
  const isCloseAction = (a: UnsavedAction) => a === 'quit' || a === 'close-window'

  const answerClose = async (choice: 'save' | 'discard' | 'cancel') => {
    onCloseHandled()
    await api.respondToClose(choice)
  }

  const unsavedSave = async (action: UnsavedAction) => {
    const saved = await runSave()
    if (!saved) {
      if (isCloseAction(action)) await answerClose('cancel')
      return
    }
    setDialog(null)
    if (isCloseAction(action)) await answerClose('save')
    else if (action === 'lock') await doLock()
    else if (action === 'close') await doClose()
    else await doOpenOther()
  }

  const unsavedDiscard = async (action: UnsavedAction) => {
    setDialog(null)
    if (isCloseAction(action)) await answerClose('discard')
    else if (action === 'lock') await doLock(true)
    else if (action === 'close') await doClose()
    else await doOpenOther()
  }

  const unsavedCancel = (action: UnsavedAction) => {
    setDialog(null)
    if (isCloseAction(action)) void answerClose('cancel')
  }

  // "Unlock and save" while quitting: save as soon as we are open, then answer main.
  const saveForClose = useEffectEvent(async () => {
    // No state is set before the first await (this runs from an effect).
    const saved = readOnly ? false : await handleSaveResult(await api.save())
    await answerClose(saved ? 'save' : 'cancel')
  })
  const saveNow = closeRequest?.saveNow === true
  const savingForClose = useRef(false)
  useEffect(() => {
    // The ref keeps StrictMode's double effect run from saving twice.
    if (!saveNow || savingForClose.current) return
    savingForClose.current = true
    void saveForClose()
  }, [saveNow])

  // ── Entries ──────────────────────────────────────────────────────────────
  const newEntry = () => {
    if (readOnly) return
    setMenuOpen(false)
    setEditor({ uuid: null })
  }

  const askDelete = (uuid: string) => {
    const entry = entries?.find((e) => e.uuid === uuid)
    if (!entry) return
    const blocked = deleteBlockedReason(entry, readOnly)
    if (blocked) {
      setDialog({
        kind: 'error',
        error: appError(readOnly ? 'READ_ONLY' : 'RECORD_READ_ONLY', blocked),
      })
      return
    }
    setDialog({ kind: 'delete', entry, error: null })
  }

  const confirmDelete = async (entry: Entry) => {
    const r = await api.deleteEntry(entry.uuid)
    if (!r.ok) {
      setDialog({ kind: 'delete', entry, error: r.error })
      return
    }
    const i = visible.findIndex((e) => e.uuid === entry.uuid)
    const next = visible[i + 1] ?? visible[i - 1]
    setSelected(next ? next.uuid : null)
    setDialog(null)
    await refresh()
    focusList()
  }

  // ── Keyboard shortcuts (§B7) ─────────────────────────────────────────────
  const onShortcut = useEffectEvent((e: globalThis.KeyboardEvent) => {
    if (isModalOpen()) return
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 'f') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (k === 's') {
      e.preventDefault()
      if (!readOnly && state.dirtyCount > 0 && !busy) void runSave()
    } else if (k === 'l') {
      e.preventDefault()
      guarded('lock')
    } else if (k === 'n') {
      e.preventDefault()
      if (!editor) newEntry()
    }
  })
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => onShortcut(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // File menu: close on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !menuButtonRef.current?.contains(t)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuOpen])

  const menuItem = (label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        setMenuOpen(false)
        onClick()
      }}
    >
      {label}
    </button>
  )

  const onExported = (res: ExportResult) => {
    setDialog(null)
    const omitted =
      res.entriesWithOmittedFields > 0
        ? ` ${res.entriesWithOmittedFields} ${res.entriesWithOmittedFields === 1 ? 'entry had' : 'entries had'} fields XML can't hold.`
        : ''
    showNotice({
      tone: 'warning',
      text: `Exported ${res.entryCount} entries to ${res.filePath}. It is not encrypted: delete it when you no longer need it.${omitted}`,
      extra: (
        <div className="toast-actions">
          <button
            type="button"
            className="button small"
            onClick={() => void api.revealInFolder(res.filePath)}
          >
            {isMac() ? 'Reveal in Finder' : 'Show in folder'}
          </button>
        </div>
      ),
    })
  }

  const editingEntry =
    editor?.uuid != null ? (entries?.find((e) => e.uuid === editor.uuid) ?? null) : null
  const groupTitle = group === null ? 'All entries' : (findGroupName(groups, group) ?? group)
  const banners = state.banners.filter((b) => !dismissed.has(b.id))
  const showSidebar = !narrow || sidebarOpen

  return (
    <div className={`vault${narrow ? ' narrow' : ''}`}>
      <header className="toolbar" aria-label="Toolbar">
        {narrow && (
          <button
            type="button"
            className="icon-button"
            aria-label={sidebarOpen ? 'Hide groups' : 'Show groups'}
            aria-expanded={sidebarOpen}
            aria-controls="groups-pane"
            title={sidebarOpen ? 'Hide groups' : 'Show groups'}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <Icon name="sidebar" />
          </button>
        )}
        <div className="file-info">
          <h1 className="file-name">{fileName}</h1>
          {readOnly && (
            <span className="badge badge-readonly">
              <Icon name="lock" size={12} /> Read-only
            </span>
          )}
          {state.dirtyCount > 0 && (
            <span className="badge badge-dirty" data-testid="dirty-count">
              Unsaved changes ({state.dirtyCount})
            </span>
          )}
        </div>
        <div className="search">
          <Icon name="search" />
          <label htmlFor="search" className="visually-hidden">
            Search entries
          </label>
          <input
            ref={searchRef}
            id="search"
            type="search"
            placeholder={`Search (${shortcutLabel('F')})`}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="button"
          disabled={readOnly || editor !== null}
          title={`New entry (${shortcutLabel('N')})`}
          onClick={newEntry}
        >
          <Icon name="plus" /> New entry
        </button>
        <button
          type="button"
          className="button primary"
          disabled={readOnly || state.dirtyCount === 0 || busy}
          title={`Save (${shortcutLabel('S')})`}
          onClick={() => void runSave()}
        >
          Save
        </button>
        <button
          type="button"
          className="button"
          title={`Lock (${shortcutLabel('L')})`}
          onClick={() => guarded('lock')}
        >
          <Icon name="lock" /> Lock
        </button>
        <div className="menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            className="button"
            aria-expanded={menuOpen}
            aria-controls="file-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            File <Icon name="chevronDown" size={14} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              id="file-menu"
              className="menu"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setMenuOpen(false)
                  menuButtonRef.current?.focus()
                }
              }}
            >
              {menuItem('Open another file…', () => guarded('open-other'))}
              {menuItem('Save As…', () => void runSaveAs(false), readOnly)}
              {menuItem('Restore from backup…', () => setDialog({ kind: 'restore' }), readOnly)}
              {menuItem('Export XML…', () => setDialog({ kind: 'export' }))}
              {menuItem('Settings…', () => setDialog({ kind: 'settings' }))}
              {menuItem('Close file', () => guarded('close'))}
            </div>
          )}
        </div>
      </header>

      {(state.readOnly || banners.length > 0) && (
        <div className="banners">
          {state.readOnly && <ReadOnlyBanner text={state.readOnly.text} />}
          {banners.map((b) => (
            <BannerRow
              key={b.id}
              banner={b}
              onDismiss={() => setDismissed((prev) => new Set(prev).add(b.id))}
            />
          ))}
        </div>
      )}

      <div className="panes">
        {showSidebar && (
          <nav id="groups-pane" className="pane groups-pane" aria-label="Groups">
            <GroupTree
              groups={groups}
              total={entries?.length ?? 0}
              selected={group}
              onSelect={(g) => {
                setGroup(g)
                if (narrow) setSidebarOpen(false)
              }}
            />
          </nav>
        )}
        <section className="pane list-pane" aria-labelledby="list-title">
          <div className="pane-header">
            <h2 id="list-title">{groupTitle}</h2>
            <span className="muted">
              {visible.length} {visible.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>
          {entries === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <EntryList
              ref={listRef}
              entries={visible}
              label={`Entries in ${groupTitle}`}
              selected={selected}
              onSelect={(uuid) => {
                setSelected(uuid)
                if (editor) setEditor(null)
              }}
              onDelete={askDelete}
            />
          )}
        </section>
        <section className="pane detail-pane" aria-label="Details">
          {editor ? (
            <EntryEditor
              key={editor.uuid ?? 'new'}
              entry={editingEntry}
              groupPaths={flattenGroups(groups)}
              defaultGroup={group ?? ''}
              onSaved={(uuid) => {
                setEditor(null)
                setSelected(uuid)
                setRevision((v) => v + 1)
                void refresh()
                focusList()
              }}
              onCancel={() => {
                setEditor(null)
                focusList()
              }}
            />
          ) : selected && entries ? (
            <EntryDetail
              key={`${selected}:${revision}`}
              uuid={selected}
              allEntries={entries}
              fileReadOnly={readOnly}
              onEdit={() => setEditor({ uuid: selected })}
              onDelete={() => askDelete(selected)}
              onSelect={(uuid) => {
                setGroup(null)
                setSelected(uuid)
              }}
              onCopied={(label, clearsAt) => setClip({ label, clearsAt })}
            />
          ) : (
            <div className="empty-detail">
              <Icon name="shield" size={32} />
              <p className="muted">Select an entry to see its details.</p>
            </div>
          )}
        </section>
      </div>

      <div className="toasts">
        {clip && (
          <ClipboardToast
            key={clip.clearsAt}
            label={clip.label}
            clearsAt={clip.clearsAt}
            onDone={() => setClip(null)}
          />
        )}
        {notice && (
          <NoticeToast key={notice.id} notice={notice} onDismiss={() => setNotice(null)} />
        )}
      </div>

      {dialog?.kind === 'delete' && (
        <DeleteDialog
          entry={dialog.entry}
          error={dialog.error}
          onConfirm={() => void confirmDelete(dialog.entry)}
          onCancel={() => setDialog(null)}
        />
      )}
      {unsavedAction && (
        <UnsavedDialog
          action={unsavedAction}
          fileName={fileName}
          dirtyCount={state.dirtyCount}
          busy={busy}
          error={dialog?.kind === 'unsaved' ? dialog.error : null}
          onSave={() => void unsavedSave(unsavedAction)}
          onDiscard={() => void unsavedDiscard(unsavedAction)}
          onCancel={() => unsavedCancel(unsavedAction)}
        />
      )}
      {dialog?.kind === 'conflict' && (
        <ConflictDialog
          busy={busy}
          error={dialog.error}
          onSaveAs={() => void runSaveAs(true)}
          onReload={() => void runReload()}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'error' && (
        <ErrorDialog error={dialog.error} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'restore' && (
        <RestoreDialog
          dirtyCount={state.dirtyCount}
          onCancel={() => setDialog(null)}
          onRestored={(s) => {
            onState(s)
            setDialog(null)
            setSelected(null)
            setRevision((v) => v + 1)
            showNotice({
              tone: 'success',
              text: 'Restored the backup. The previous file is now the newest backup.',
            })
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'export' && entries && (
        <ExportDialog
          entries={entries}
          currentGroup={group}
          onExported={onExported}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
    </div>
  )
}
