import { useEffect, useState, type FormEvent } from 'react'
import type { AppError } from '@shared/errors'
import type { BackupInfo, Entry, VaultState } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { displayGroup, formatDate } from '../hooks'

const GEN_NAME = (g: number) => (g === 1 ? '.bak' : `.bak${g}`)

/**
 * §A5 Restore: pick a backup, enter its password (the one current when it was made), preview it
 * read-only, then "Restore this version" replaces the file through a normal save.
 */
export function RestoreDialog(props: {
  dirtyCount: number
  onRestored: (s: VaultState) => void
  onCancel: () => void
}) {
  const api = useApi()
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<Entry[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void api.listBackups().then((r) => {
      if (!live) return
      if (r.ok) {
        setBackups(r.value)
        setChosen(r.value[0]?.id ?? null)
      } else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [api])

  const doPreview = async (e: FormEvent) => {
    e.preventDefault()
    if (!chosen) return
    setBusy(true)
    setError(null)
    const r = await api.previewBackup(chosen, password)
    setBusy(false)
    if (r.ok) {
      setPreview(r.value)
      setPassword('')
    } else setError(r.error)
  }

  const restore = async () => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    const r = await api.restoreBackup(chosen)
    setBusy(false)
    if (r.ok) props.onRestored(r.value)
    else setError(r.error)
  }

  const picked = backups?.find((b) => b.id === chosen)

  return (
    <Modal title="Restore from backup" wide onCancel={props.onCancel}>
      {backups === null && !error && <p className="muted">Loading backups…</p>}
      {backups?.length === 0 && <p>There are no backups of this file yet.</p>}
      {backups && backups.length > 0 && preview === null && (
        <form onSubmit={(e) => void doPreview(e)}>
          <fieldset className="backup-list">
            <legend>Backups (newest first)</legend>
            {backups.map((b) => (
              <label key={b.id} className="radio-row">
                <input
                  type="radio"
                  name="backup"
                  value={b.id}
                  checked={chosen === b.id}
                  onChange={() => setChosen(b.id)}
                />
                <span>
                  <strong>{formatDate(b.modifiedAt)}</strong>
                  <span className="muted">
                    {' '}
                    · {GEN_NAME(b.generation)} · {(b.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="backup-password">Master password of this backup</label>
            <input
              id="backup-password"
              type="password"
              autoComplete="off"
              value={password}
              aria-describedby="backup-password-hint"
              onChange={(e) => setPassword(e.target.value)}
            />
            <p id="backup-password-hint" className="muted small">
              The password the file had when this backup was made. The backup opens read-only.
            </p>
          </div>
          {error && <ErrorAlert error={error} />}
          <div className="modal-actions">
            <button type="submit" className="button primary" disabled={busy || password === ''}>
              Preview
            </button>
            <button type="button" className="button" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {preview !== null && picked && (
        <>
          <p className="banner banner-readonly" role="status">
            Previewing the backup from {formatDate(picked.modifiedAt)} ({preview.length} entries).
            Read-only.
          </p>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Backup entries">
            <table className="preview-table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Username</th>
                  <th scope="col">Group</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((e) => (
                  <tr key={e.uuid}>
                    <td>{e.title}</td>
                    <td>{e.username || '—'}</td>
                    <td>{displayGroup(e.group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            Restoring replaces the current file with this version. The current file becomes the
            newest backup, so nothing is lost.
            {props.dirtyCount > 0 &&
              ` Your ${props.dirtyCount} unsaved ${props.dirtyCount === 1 ? 'change is' : 'changes are'} discarded.`}
          </p>
          {error && <ErrorAlert error={error} />}
          <div className="modal-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void restore()}
            >
              Restore this version
            </button>
            <button type="button" className="button" onClick={() => setPreview(null)}>
              Back
            </button>
            <button type="button" className="button" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
      {(backups?.length === 0 || (error && backups === null)) && (
        <>
          {error && <ErrorAlert error={error} />}
          <div className="modal-actions">
            <button type="button" className="button" onClick={props.onCancel}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
