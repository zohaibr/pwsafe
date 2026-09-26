import type { ReactNode } from 'react'
import type { AppError } from '@shared/errors'
import type { Banner } from '@shared/types'
import { presentError } from '../errorText'
import { Icon } from './Icons'

/** Inline message for an error returned by the API. Announced to screen readers. */
export function ErrorAlert(props: { error: AppError; children?: ReactNode }) {
  const p = presentError(props.error)
  return (
    <div
      className={`alert alert-${p.tone}`}
      role={p.tone === 'info' ? 'status' : 'alert'}
      data-code={props.error.code}
    >
      <Icon name={p.tone === 'info' ? 'info' : 'warning'} />
      <div>
        {!p.body.startsWith(p.title) && <p className="alert-title">{p.title}</p>}
        <p className="alert-body">{p.body}</p>
        {props.children}
      </div>
    </div>
  )
}

/** Read-only banner (§B8, §A1, §A6). Not dismissible: it stays while the file is read-only. */
export function ReadOnlyBanner(props: { text: string }) {
  return (
    <div className="banner banner-readonly" role="status" data-testid="readonly-banner">
      <Icon name="lock" />
      <p>
        <strong>Read-only.</strong> {props.text} Browsing, copying and export still work.
      </p>
    </div>
  )
}

export function BannerRow(props: { banner: Banner; onDismiss: () => void }) {
  const { banner } = props
  return (
    <div className={`banner banner-${banner.kind}`} role="status">
      <Icon name={banner.kind === 'warning' ? 'warning' : 'info'} />
      <p>{banner.text}</p>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss message"
        onClick={props.onDismiss}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}
