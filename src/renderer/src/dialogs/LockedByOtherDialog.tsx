import { useState } from 'react'
import type { LockChoice } from '@shared/ipc'
import { Modal } from '../components/Modal'

/** Strips the pid from `user@host:pid` for display. */
export function lockOwner(detail: string | undefined): string {
  if (!detail) return 'another user'
  return detail.replace(/:\d+$/, '')
}

/**
 * §A6: another app holds the `.plk`. We never remove a lock automatically; removing one needs a
 * second, explicit confirmation.
 */
export function LockedByOtherDialog(props: {
  fileName: string
  detail?: string
  onChoose: (choice: LockChoice) => void
  onCancel: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const owner = lockOwner(props.detail)
  const pid = props.detail?.match(/:(\d+)$/)?.[1]
  return (
    <>
      <Modal
        title="This file is open in another app"
        role="alertdialog"
        describedBy="locked-desc"
        onCancel={props.onCancel}
      >
        <div id="locked-desc">
          <p>
            {props.fileName} is locked by <strong>{owner}</strong>
            {pid ? ` (process ${pid})` : ''}. Password Safe or another copy of this app probably has
            it open.
          </p>
          <p className="muted">
            You can open it read-only to look things up, or remove the lock if you are sure nothing
            is using the file.
          </p>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button primary"
            onClick={() => props.onChoose('read-only')}
          >
            Open read-only
          </button>
          <button type="button" className="button" onClick={() => setConfirmRemove(true)}>
            Remove lock and open…
          </button>
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </Modal>
      {confirmRemove && (
        <Modal
          title="Remove the lock?"
          role="alertdialog"
          describedBy="remove-lock-desc"
          onCancel={() => setConfirmRemove(false)}
        >
          <p id="remove-lock-desc">
            Only do this if Password Safe isn&apos;t running with this file on {owner}. If it is,
            you could overwrite each other&apos;s changes.
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => props.onChoose('remove-lock')}
            >
              Remove lock and open
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
