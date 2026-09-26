import { useRef, useState } from 'react'
import type { AppError } from '@shared/errors'
import { BACKUP_GENERATIONS } from '@shared/limits'
import type { Entry } from '@shared/types'
import { ErrorAlert } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { presentError } from '../errorText'

/** §B4: exact backup wording, matching §A5. */
export const DELETE_BACKUP_TEXT = `Removed from the file when you save. Each save keeps the previous ${BACKUP_GENERATIONS} versions as backups, which you can restore from File → Restore from backup.`

export function DeleteDialog(props: {
  entry: Entry
  error: AppError | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      title={`Delete “${props.entry.title}”?`}
      role="alertdialog"
      describedBy="delete-desc"
      initialFocus={cancelRef}
      onCancel={props.onCancel}
    >
      <p id="delete-desc">{DELETE_BACKUP_TEXT}</p>
      {props.error && <ErrorAlert error={props.error} />}
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="button danger" onClick={props.onConfirm}>
          Delete entry
        </button>
      </div>
    </Modal>
  )
}

export type UnsavedAction = 'lock' | 'close' | 'open-other' | 'quit' | 'close-window'

const UNSAVED_TITLE: Record<UnsavedAction, string> = {
  lock: 'Save changes before locking?',
  close: 'Save changes before closing?',
  'open-other': 'Save changes before opening another file?',
  quit: 'Save changes before quitting?',
  'close-window': 'Save changes before closing the window?',
}

/** §B3: manual lock, Close, Quit, Open another file with unsaved changes. */
export function UnsavedDialog(props: {
  action: UnsavedAction
  fileName: string
  dirtyCount: number
  busy: boolean
  error: AppError | null
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  const n = props.dirtyCount
  return (
    <Modal
      title={UNSAVED_TITLE[props.action]}
      role="alertdialog"
      describedBy="unsaved-desc"
      onCancel={props.onCancel}
    >
      <p id="unsaved-desc">
        {props.fileName} has {n} unsaved {n === 1 ? 'change' : 'changes'}. If you don&apos;t save,
        {n === 1 ? ' it is' : ' they are'} lost.
      </p>
      {props.error && <ErrorAlert error={props.error} />}
      <div className="modal-actions">
        <button
          type="button"
          className="button primary"
          disabled={props.busy}
          onClick={props.onSave}
        >
          Save
        </button>
        <button type="button" className="button" disabled={props.busy} onClick={props.onDiscard}>
          Don&apos;t save
        </button>
        <button type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** §B3: quitting while locked with unsaved changes. */
export function QuitWhileLockedDialog(props: {
  dirtyCount: number
  reason: 'quit' | 'close-window'
  onUnlockAndSave: () => void
  onQuitWithoutSaving: () => void
  onCancel: () => void
}) {
  const n = props.dirtyCount
  const verb = props.reason === 'quit' ? 'Quit' : 'Close'
  return (
    <Modal
      title="The file is locked and has unsaved changes"
      role="alertdialog"
      describedBy="quit-locked-desc"
      onCancel={props.onCancel}
    >
      <p id="quit-locked-desc">
        {n} unsaved {n === 1 ? 'change is' : 'changes are'} kept in memory while the file is locked.
        Unlock to save {n === 1 ? 'it' : 'them'}, or {verb.toLowerCase()} without saving.
      </p>
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={props.onUnlockAndSave}>
          Unlock and save
        </button>
        <button type="button" className="button" onClick={props.onQuitWithoutSaving}>
          {verb} without saving
        </button>
        <button type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** §A5 rows 1 and 6: the file changed on disk. */
export function ConflictDialog(props: {
  busy: boolean
  error: AppError | null
  onSaveAs: () => void
  onReload: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title="The file was changed by another app"
      role="alertdialog"
      describedBy="conflict-desc"
      onCancel={props.onCancel}
    >
      <p id="conflict-desc">
        Someone or something changed this file since you opened it, so saving now could overwrite
        their changes. Nothing was written. Your changes are still here, unsaved.
      </p>
      {props.error && <ErrorAlert error={props.error} />}
      <div className="modal-actions">
        <button
          type="button"
          className="button primary"
          disabled={props.busy}
          onClick={props.onSaveAs}
        >
          Save As…
        </button>
        <button
          type="button"
          className="button danger-outline"
          disabled={props.busy}
          onClick={props.onReload}
        >
          Reload (discard my changes)
        </button>
        <button type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** Any other error that needs acknowledging (save failed, I/O error, read-only…). */
export function ErrorDialog(props: { error: AppError; onClose: () => void }) {
  const p = presentError(props.error)
  return (
    <Modal title={p.title} role="alertdialog" describedBy="error-desc" onCancel={props.onClose}>
      <div id="error-desc" data-code={props.error.code}>
        <p>{props.error.message}</p>
        {props.error.detail && <p className="muted">{props.error.detail}</p>}
        {props.error.code === 'SAVE_FAILED' && (
          <p className="muted">
            Your file and its backups on disk are exactly as they were. Try again, or use Save As to
            save a copy elsewhere.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={props.onClose}>
          OK
        </button>
      </div>
    </Modal>
  )
}

export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false)
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }
  return [busy, run]
}
