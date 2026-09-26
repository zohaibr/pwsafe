import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AppError } from '@shared/errors'
import type { Entry, EntryDraft } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Icon } from '../components/Icons'
import { GeneratorPanel } from './GeneratorPanel'

interface Fields {
  title: string
  group: string
  username: string
  url: string
  email: string
  notes: string
}

/**
 * Add or edit an entry. For an existing entry the password field starts empty and masked; it is
 * only sent if the user changes it, and Show fetches the current value by explicit reveal
 * (§B6, §A4.8).
 */
export function EntryEditor(props: {
  entry: Entry | null
  groupPaths: string[]
  defaultGroup: string
  onSaved: (uuid: string) => void
  onCancel: () => void
}) {
  const api = useApi()
  const { entry } = props
  const listId = useId()
  const [fields, setFields] = useState<Fields>(() => ({
    title: entry?.title ?? '',
    group: entry?.group ?? props.defaultGroup,
    username: entry?.username ?? '',
    url: entry?.url ?? '',
    email: entry?.email ?? '',
    notes: entry?.notes ?? '',
  }))
  const [password, setPassword] = useState('')
  const [passwordChanged, setPasswordChanged] = useState(entry === null)
  const [showPassword, setShowPassword] = useState(false)
  const [showGenerator, setShowGenerator] = useState(false)
  const [titleError, setTitleError] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const set = (key: keyof Fields) => (value: string) => setFields((f) => ({ ...f, [key]: value }))

  const toggleShow = async () => {
    if (showPassword) {
      setShowPassword(false)
      return
    }
    if (entry && !passwordChanged && password === '') {
      const r = await api.revealPassword(entry.uuid)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setPassword(r.value)
    }
    setShowPassword(true)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (fields.title.trim() === '') {
      setTitleError(true)
      titleRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const draft: EntryDraft = { ...fields }
    if (entry) draft.uuid = entry.uuid
    if (passwordChanged) draft.password = password
    const r = await api.saveEntry(draft)
    setBusy(false)
    if (r.ok) props.onSaved(r.value.uuid)
    else setError(r.error)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    }
  }

  const text = (key: keyof Fields, label: string, type: 'text' | 'url' | 'email' = 'text') => (
    <div className="field">
      <label htmlFor={`edit-${key}`}>{label}</label>
      <input
        id={`edit-${key}`}
        type={type}
        value={fields[key]}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  )

  return (
    <form
      className="editor"
      aria-labelledby="editor-title"
      noValidate
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
    >
      <h2 id="editor-title">{entry ? `Edit “${entry.title}”` : 'New entry'}</h2>
      <div className="field">
        <label htmlFor="edit-title">Title (required)</label>
        <input
          ref={titleRef}
          id="edit-title"
          value={fields.title}
          autoComplete="off"
          aria-invalid={titleError || undefined}
          aria-describedby={titleError ? 'edit-title-error' : undefined}
          onChange={(e) => {
            set('title')(e.target.value)
            if (e.target.value.trim()) setTitleError(false)
          }}
        />
        {titleError && (
          <p id="edit-title-error" className="field-error" role="alert">
            Enter a title.
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="edit-group">Group</label>
        <input
          id="edit-group"
          list={listId}
          value={fields.group}
          autoComplete="off"
          aria-describedby="edit-group-hint"
          onChange={(e) => set('group')(e.target.value)}
        />
        <datalist id={listId}>
          {props.groupPaths.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <p id="edit-group-hint" className="muted small">
          Use a dot for subgroups, for example Personal.Banking.
        </p>
      </div>
      {text('username', 'Username')}
      <div className="field">
        <label htmlFor="edit-password">Password</label>
        <div className="input-with-buttons">
          <input
            id="edit-password"
            type={showPassword ? 'text' : 'password'}
            className="mono"
            value={password}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={entry && !passwordChanged ? 'Unchanged' : ''}
            aria-describedby={entry ? 'edit-password-hint' : undefined}
            onChange={(e) => {
              setPassword(e.target.value)
              setPasswordChanged(true)
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            title={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => void toggleShow()}
          >
            <Icon name={showPassword ? 'eyeOff' : 'eye'} />
          </button>
          <button
            type="button"
            className="button"
            aria-expanded={showGenerator}
            aria-controls="generator-panel"
            onClick={() => setShowGenerator((v) => !v)}
          >
            Generate…
          </button>
        </div>
        {entry && (
          <p id="edit-password-hint" className="muted small">
            {passwordChanged
              ? 'The new password is saved with the entry.'
              : 'Leave as is to keep the current password.'}
          </p>
        )}
      </div>
      {showGenerator && (
        <div id="generator-panel">
          <GeneratorPanel
            onUse={(pw) => {
              setPassword(pw)
              setPasswordChanged(true)
              setShowGenerator(false)
              document.getElementById('edit-password')?.focus()
            }}
          />
        </div>
      )}
      {text('url', 'URL', 'url')}
      {text('email', 'Email', 'email')}
      <div className="field">
        <label htmlFor="edit-notes">Notes</label>
        <textarea
          id="edit-notes"
          rows={4}
          value={fields.notes}
          onChange={(e) => set('notes')(e.target.value)}
        />
      </div>
      {error && <ErrorAlert error={error} />}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={busy}>
          {entry ? 'Save entry' : 'Add entry'}
        </button>
        <button type="button" className="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted small">Changes stay in memory until you save the file. Escape cancels.</p>
    </form>
  )
}
