import { useEffect, useState, type FormEvent } from 'react'
import type { AppError } from '@shared/errors'
import { IDLE_LOCK_MAX_MIN, IDLE_LOCK_MIN_MIN } from '@shared/limits'
import type { Settings } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Modal } from '../components/Modal'

/** §B2 settings: idle lock time (1–60 min, default 5) and lock on minimise (default off). */
export function SettingsDialog(props: { onClose: () => void }) {
  const api = useApi()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState<AppError | null>(null)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    let live = true
    void api.getSettings().then((r) => {
      if (!live) return
      if (r.ok) {
        setSettings(r.value)
        setMinutes(String(r.value.idleLockMinutes))
      } else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [api])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!settings) return
    const m = Number(minutes)
    if (!Number.isInteger(m) || m < IDLE_LOCK_MIN_MIN || m > IDLE_LOCK_MAX_MIN) {
      setInvalid(true)
      document.getElementById('idle-minutes')?.focus()
      return
    }
    const r = await api.setSettings({ ...settings, idleLockMinutes: m })
    if (r.ok) props.onClose()
    else setError(r.error)
  }

  return (
    <Modal title="Settings" onCancel={props.onClose}>
      {!settings && !error && <p className="muted">Loading…</p>}
      {settings && (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <fieldset className="settings-group">
            <legend>Locking</legend>
            <div className="field inline">
              <label htmlFor="idle-minutes">Lock after being idle for</label>
              <input
                id="idle-minutes"
                type="number"
                inputMode="numeric"
                min={IDLE_LOCK_MIN_MIN}
                max={IDLE_LOCK_MAX_MIN}
                step={1}
                className="narrow"
                value={minutes}
                aria-invalid={invalid || undefined}
                aria-describedby="idle-hint"
                onChange={(e) => {
                  setMinutes(e.target.value)
                  setInvalid(false)
                }}
              />
              <span>minutes</span>
            </div>
            <p id="idle-hint" className={invalid ? 'field-error' : 'muted small'}>
              {IDLE_LOCK_MIN_MIN} to {IDLE_LOCK_MAX_MIN} minutes.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.lockOnMinimize}
                onChange={(e) => setSettings({ ...settings, lockOnMinimize: e.target.checked })}
              />
              Lock when the window is minimised
            </label>
            <p className="muted small">
              The file always locks when the computer sleeps or the screen locks. Unsaved changes
              are kept in memory and come back when you unlock.
            </p>
          </fieldset>
          {error && <ErrorAlert error={error} />}
          <div className="modal-actions">
            <button type="submit" className="button primary">
              Save settings
            </button>
            <button type="button" className="button" onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!settings && error && (
        <>
          <ErrorAlert error={error} />
          <div className="modal-actions">
            <button type="button" className="button" onClick={props.onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
