import { useState, type FormEvent } from 'react'
import type { AppError } from '@shared/errors'
import type { Entry, ExportResult } from '@shared/types'
import { useApi } from '../api'
import { ErrorAlert } from '../components/Feedback'
import { Icon } from '../components/Icons'
import { Modal } from '../components/Modal'
import { displayGroup, inGroup } from '../hooks'

/** Entries with data Password Safe XML has no place for (§A7), estimated from the flags. */
export function omittedFieldCount(entries: Entry[]): number {
  return entries.filter(
    (e) => e.flags.hasAttachment || e.flags.hasPasskey || e.flags.hasCustomFields,
  ).length
}

/**
 * §A7 export: scope, what won't be exported, and the mandatory plaintext warning with an
 * "I understand" checkbox. The native save dialog (main) picks the destination.
 */
export function ExportDialog(props: {
  entries: Entry[]
  currentGroup: string | null
  onExported: (result: ExportResult) => void
  onCancel: () => void
}) {
  const api = useApi()
  const [scope, setScope] = useState<'all' | 'group'>(props.currentGroup ? 'group' : 'all')
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  const group = props.currentGroup

  const inScope = props.entries.filter((e) => scope === 'all' || inGroup(e.group, group))
  const omitted = omittedFieldCount(inScope)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!understood) return
    setBusy(true)
    setError(null)
    const r = await api.exportXml({
      scope: scope === 'group' && group ? { kind: 'group', path: group } : { kind: 'all' },
    })
    setBusy(false)
    if (!r.ok) setError(r.error)
    else if (r.value) props.onExported(r.value)
  }

  return (
    <Modal title="Export to XML" onCancel={props.onCancel}>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset className="radio-group">
          <legend>What to export</legend>
          <label className="radio-row">
            <input
              type="radio"
              name="scope"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            All entries ({props.entries.length})
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="scope"
              checked={scope === 'group'}
              disabled={!group}
              onChange={() => setScope('group')}
            />
            {group
              ? `Current group: ${displayGroup(group)}, with subgroups (${props.entries.filter((e) => inGroup(e.group, group)).length})`
              : 'Current group (select a group first)'}
          </label>
        </fieldset>
        <p className="muted small">
          Password Safe XML format. Read-only entries are included.{' '}
          {omitted > 0
            ? `${omitted} ${omitted === 1 ? 'entry has' : 'entries have'} attachments, passkeys or custom fields that XML can't hold; those fields won't be exported.`
            : 'Every field shown in this app will be exported.'}
        </p>
        <div className="alert alert-warning" id="export-warning">
          <Icon name="warning" />
          <div>
            <p className="alert-title">The exported file is not encrypted</p>
            <p className="alert-body">
              Anyone who can open it can read every password in it. Keep it somewhere safe and
              delete it when you no longer need it. This app never deletes it for you.
            </p>
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={understood}
            aria-describedby="export-warning"
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          I understand the file will contain my passwords in plain text
        </label>
        {error && <ErrorAlert error={error} />}
        <div className="modal-actions">
          <button type="submit" className="button primary" disabled={!understood || busy}>
            Export…
          </button>
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
