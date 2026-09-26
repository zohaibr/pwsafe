import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AppError, Result } from '@shared/errors'
import type { VaultState } from '@shared/types'
import type { LockChoice } from '@shared/ipc'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Icon } from '../components/Icons'
import { LockedByOtherDialog } from '../dialogs/LockedByOtherDialog'

/**
 * Locked screen (§B2) and unlock form: file name, master password, Unlock. While a slow file is
 * stretching its key (§A1, §B9) it shows progress and Cancel.
 */
export function UnlockScreen(props: {
  state: VaultState
  onState: (s: VaultState) => void
  /** Set when the user chose "Unlock and save" while quitting (§B3). */
  saveBeforeQuit?: boolean
  onCancelQuitSave?: () => void
}) {
  const api = useApi()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<AppError | null>(null)
  const [lockedBy, setLockedBy] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { state } = props
  const unlocking = state.status === 'unlocking' || pending
  const showProgress = state.status === 'unlocking' && state.unlockProgress !== undefined

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    // The password field is disabled during a slow unlock, so keep focus on Cancel.
    if (showProgress) cancelRef.current?.focus()
  }, [showProgress])

  const finish = (r: Result<VaultState>) => {
    setPending(false)
    if (r.ok) {
      setPassword('')
      props.onState(r.value)
      return
    }
    if (r.error.code === 'LOCKED_BY_OTHER') {
      setLockedBy(r.error)
      return
    }
    setError(r.error)
    if (r.error.code === 'WRONG_PASSWORD') setPassword('')
    // Focus returns to the field once it is enabled again (next paint).
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (unlocking || password === '') return
    setError(null)
    setPending(true)
    finish(await api.unlock(password))
  }

  const choose = async (choice: LockChoice) => {
    setLockedBy(null)
    setPending(true)
    finish(await api.unlock(password, { lockChoice: choice }))
  }

  const chooseAnother = async () => {
    const r = await api.closeFile()
    if (r.ok) props.onState(r.value)
    else setError(r.error)
  }

  return (
    <main className="start" aria-labelledby="unlock-title">
      <form className="start-card" onSubmit={(e) => void submit(e)} aria-busy={unlocking}>
        <div className="brand-mark" aria-hidden="true">
          <Icon name="lock" size={28} />
        </div>
        <h1 id="unlock-title" className="file-title">
          {state.fileName ?? 'Locked'}
        </h1>
        <p className="muted">This file is locked. Enter its master password to open it.</p>
        {props.saveBeforeQuit && (
          <div className="alert alert-info" role="status">
            <Icon name="info" />
            <div>
              <p className="alert-body">
                Unlock to save your changes. The app quits after saving.{' '}
                <button type="button" className="link-button" onClick={props.onCancelQuitSave}>
                  Don&apos;t quit
                </button>
              </p>
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="master-password">Master password</label>
          <input
            ref={inputRef}
            id="master-password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={password}
            disabled={unlocking}
            aria-invalid={error?.code === 'WRONG_PASSWORD' ? true : undefined}
            aria-describedby={error ? 'unlock-error' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {showProgress && (
          <div className="unlock-progress">
            <label htmlFor="unlock-progress">Unlocking…</label>
            <progress id="unlock-progress" max={1} value={state.unlockProgress} />
            <p className="muted">
              This file uses extra-strong key stretching; unlocking takes longer.
            </p>
          </div>
        )}
        <div id="unlock-error">
          {error && error.code !== 'CANCELLED' && <ErrorAlert error={error} />}
          {error?.code === 'CANCELLED' && (
            <p className="muted" role="status">
              Unlock cancelled.
            </p>
          )}
        </div>
        <div className="form-actions">
          {showProgress ? (
            <button
              ref={cancelRef}
              type="button"
              className="button"
              onClick={() => void api.cancelUnlock()}
            >
              Cancel
            </button>
          ) : (
            <button type="submit" className="button primary large" disabled={unlocking}>
              <Icon name="unlock" /> {unlocking ? 'Unlocking…' : 'Unlock'}
            </button>
          )}
          <button
            type="button"
            className="link-button"
            disabled={unlocking}
            onClick={() => void chooseAnother()}
          >
            Open a different file
          </button>
        </div>
      </form>
      {lockedBy && (
        <LockedByOtherDialog
          fileName={state.fileName ?? 'This file'}
          detail={lockedBy.detail}
          onChoose={(c) => void choose(c)}
          onCancel={() => setLockedBy(null)}
        />
      )}
    </main>
  )
}
