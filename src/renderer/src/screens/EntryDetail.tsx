import { useEffect, useState } from 'react'
import type { AppError } from '@shared/errors'
import type { CopyableField, Entry } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Icon } from '../components/Icons'
import { displayGroup, formatDate } from '../hooks'

const FIELD_LABEL: Record<CopyableField, string> = {
  username: 'Username',
  password: 'Password',
  url: 'URL',
  email: 'Email',
}

/** Why Delete is blocked for this entry, or null when it is allowed. */
export function deleteBlockedReason(entry: Entry, fileReadOnly: boolean): string | null {
  if (fileReadOnly) return 'The file is open read-only.'
  if (!entry.editable) return entry.readOnlyReason ?? 'This entry is read-only.'
  if (entry.kind === 'aliasBase' || entry.kind === 'shortcutBase')
    return 'Other entries depend on this one.'
  return null
}

/** Badges for data this version keeps but does not show or edit (§A3). */
export function preservedBadges(entry: Entry): string[] {
  const f = entry.flags
  const out: string[] = []
  if (f.hasTotp) out.push('Has 2FA (view in Password Safe)')
  if (f.hasAttachment) out.push('Has attachment (kept)')
  if (f.hasPasskey) out.push('Has passkey (kept)')
  if (f.hasCreditCard) out.push('Has card details (kept)')
  if (f.hasCustomFields) out.push('Has custom fields (kept)')
  if (f.hasHistory) out.push('Has password history (kept)')
  return out
}

/**
 * Details pane. The password is masked by default and only fetched on an explicit Show (§B6,
 * §A4.8). Remount with a new `key` to reset reveal (new selection, save, editor closed).
 */
export function EntryDetail(props: {
  uuid: string
  allEntries: Entry[]
  fileReadOnly: boolean
  onEdit: () => void
  onDelete: () => void
  onSelect: (uuid: string) => void
  onCopied: (label: string, clearsAt: number) => void
}) {
  const api = useApi()
  const [entry, setEntry] = useState<Entry | null>(null)
  const [loadError, setLoadError] = useState<AppError | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void api.getEntry(props.uuid).then((r) => {
      if (!live) return
      if (r.ok) setEntry(r.value)
      else setLoadError(r.error)
    })
    return () => {
      live = false
    }
  }, [api, props.uuid])

  if (loadError) return <ErrorAlert error={loadError} />
  if (!entry) return <p className="muted">Loading…</p>

  const copy = async (field: CopyableField) => {
    setError(null)
    const r = await api.copyField(entry.uuid, field)
    if (r.ok) props.onCopied(FIELD_LABEL[field], r.value.clearsAt)
    else setError(r.error)
  }

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null)
      return
    }
    setError(null)
    const r = await api.revealPassword(entry.uuid)
    if (r.ok) setRevealed(r.value)
    else setError(r.error)
  }

  const base = entry.baseUuid ? props.allEntries.find((e) => e.uuid === entry.baseUuid) : undefined
  const editBlocked = props.fileReadOnly
    ? 'The file is open read-only.'
    : entry.editable
      ? null
      : (entry.readOnlyReason ?? 'This entry is read-only.')
  const deleteBlocked = deleteBlockedReason(entry, props.fileReadOnly)
  const badges = preservedBadges(entry)

  const copyButton = (field: CopyableField) => (
    <button
      type="button"
      className="icon-button"
      aria-label={`Copy ${FIELD_LABEL[field].toLowerCase()}`}
      title={`Copy ${FIELD_LABEL[field].toLowerCase()}`}
      onClick={() => void copy(field)}
    >
      <Icon name="copy" />
    </button>
  )

  return (
    <article className="detail" aria-labelledby="detail-title">
      <header className="detail-header">
        <div>
          <h2 id="detail-title">{entry.title || '(no title)'}</h2>
          <p className="muted">{displayGroup(entry.group)}</p>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="button"
            disabled={editBlocked !== null}
            aria-describedby={!entry.editable ? 'detail-readonly' : undefined}
            onClick={props.onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="button danger-outline"
            disabled={deleteBlocked !== null}
            aria-describedby={
              !entry.editable
                ? 'detail-readonly'
                : deleteBlocked && !props.fileReadOnly
                  ? 'detail-delete-blocked'
                  : undefined
            }
            onClick={props.onDelete}
          >
            Delete
          </button>
        </div>
      </header>

      {!entry.editable && (
        <p className="record-readonly" id="detail-readonly" data-testid="record-readonly">
          <Icon name="lock" />
          <span>
            <strong>Read-only entry.</strong> {entry.readOnlyReason}
          </span>
        </p>
      )}
      {entry.editable && deleteBlocked && !props.fileReadOnly && (
        <p className="muted small" id="detail-delete-blocked">
          Can&apos;t delete: {deleteBlocked}
        </p>
      )}
      {(entry.kind === 'alias' || entry.kind === 'shortcut') && (
        <p className="link-note">
          <Icon name="link" /> {entry.kind === 'alias' ? 'Alias of' : 'Shortcut to'}{' '}
          {base ? (
            <button type="button" className="link-button" onClick={() => props.onSelect(base.uuid)}>
              {base.title}
            </button>
          ) : (
            'an entry that is not in this file'
          )}
          . Copying the password copies the base entry&apos;s password.
        </p>
      )}

      {error && <ErrorAlert error={error} />}

      <dl className="fields">
        <div className="field-row">
          <dt>Username</dt>
          <dd>
            <span className="value">{entry.username || '—'}</span>
            {entry.username && copyButton('username')}
          </dd>
        </div>
        <div className="field-row">
          <dt>Password</dt>
          <dd>
            <span className="value mono" data-testid="password-value">
              {revealed === null ? (
                <>
                  <span aria-hidden="true">••••••••••••</span>
                  <span className="visually-hidden">Hidden</span>
                </>
              ) : (
                revealed
              )}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={revealed === null ? 'Show password' : 'Hide password'}
              aria-pressed={revealed !== null}
              title={revealed === null ? 'Show password' : 'Hide password'}
              onClick={() => void toggleReveal()}
            >
              <Icon name={revealed === null ? 'eye' : 'eyeOff'} />
            </button>
            {copyButton('password')}
          </dd>
        </div>
        <div className="field-row">
          <dt>URL</dt>
          <dd>
            <span className="value">{entry.url || '—'}</span>
            {entry.url && copyButton('url')}
          </dd>
        </div>
        <div className="field-row">
          <dt>Email</dt>
          <dd>
            <span className="value">{entry.email || '—'}</span>
            {entry.email && copyButton('email')}
          </dd>
        </div>
        <div className="field-row notes">
          <dt>Notes</dt>
          <dd>
            <span className="value pre">{entry.notes || '—'}</span>
          </dd>
        </div>
      </dl>

      {(badges.length > 0 || entry.flags.extraFieldCount > 0) && (
        <section className="preserved" aria-label="Kept data">
          <ul className="badges">
            {badges.map((b) => (
              <li key={b} className="badge">
                {b}
              </li>
            ))}
          </ul>
          {entry.flags.extraFieldCount > 0 && (
            <p className="muted small">
              {entry.flags.extraFieldCount} more{' '}
              {entry.flags.extraFieldCount === 1 ? 'field is' : 'fields are'} kept unchanged when
              you save.
            </p>
          )}
        </section>
      )}

      <dl className="times">
        <div>
          <dt>Created</dt>
          <dd>{formatDate(entry.created)}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{formatDate(entry.modified)}</dd>
        </div>
        <div>
          <dt>Password changed</dt>
          <dd>{formatDate(entry.passwordModified)}</dd>
        </div>
        {entry.expires && (
          <div>
            <dt>Expires</dt>
            <dd>{formatDate(entry.expires)}</dd>
          </div>
        )}
      </dl>
    </article>
  )
}
