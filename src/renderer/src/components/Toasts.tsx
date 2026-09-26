import { useEffect, useEffectEvent, type ReactNode } from 'react'
import { CLIPBOARD_CLEAR_MS } from '@shared/limits'
import { useCountdown } from '../hooks'
import { Icon } from './Icons'

/**
 * §B5: the countdown starts at copy (main returns `clearsAt`). Main clears the clipboard at zero
 * only if it still holds our value. Render with `key={clearsAt}` so a new copy restarts it.
 */
export function ClipboardToast(props: { label: string; clearsAt: number; onDone: () => void }) {
  const left = useCountdown(props.clearsAt)
  const done = useEffectEvent(() => props.onDone())
  useEffect(() => {
    if (left > 0) return
    const id = setTimeout(done, 3000)
    return () => clearTimeout(id)
  }, [left])
  return (
    <div className="toast" data-testid="clipboard-toast">
      <Icon name="copy" />
      {left > 0 ? (
        <p>
          <span role="status">
            {props.label} copied.
            <span className="visually-hidden">
              {' '}
              The clipboard clears in {CLIPBOARD_CLEAR_MS / 1000} seconds.
            </span>
          </span>{' '}
          <span aria-hidden="true" data-testid="clipboard-seconds">
            Clears in {left} s
          </span>
        </p>
      ) : (
        <p role="status">Clipboard cleared.</p>
      )}
    </div>
  )
}

export interface Notice {
  id: number
  tone: 'info' | 'warning' | 'success'
  text: string
  /** Extra content, for example a "Reveal in Finder" button. */
  extra?: ReactNode
  /** Auto-hide after a few seconds; otherwise stays until dismissed. */
  transient?: boolean
}

export function NoticeToast(props: { notice: Notice; onDismiss: () => void }) {
  const { notice, onDismiss } = props
  const dismiss = useEffectEvent(() => onDismiss())
  useEffect(() => {
    if (!notice.transient) return
    const id = setTimeout(dismiss, 4000)
    return () => clearTimeout(id)
  }, [notice])
  return (
    <div className={`toast toast-${notice.tone}`} data-testid="notice-toast">
      <Icon name={notice.tone === 'warning' ? 'warning' : 'info'} />
      <div className="toast-body">
        <p role={notice.tone === 'warning' ? 'alert' : 'status'}>{notice.text}</p>
        {notice.extra}
      </div>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  )
}
