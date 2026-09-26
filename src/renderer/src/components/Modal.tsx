import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function isModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/**
 * Accessible modal dialog: labelled by its title, focus moves in on open and back on close,
 * Tab stays inside, Escape cancels, and everything else on the page is `inert` meanwhile.
 */
export function Modal(props: {
  title: string
  children: ReactNode
  onCancel: () => void
  /** Element to focus first; defaults to the first focusable control. */
  initialFocus?: RefObject<HTMLElement | null>
  /** 'alertdialog' for confirmations and warnings. */
  role?: 'dialog' | 'alertdialog'
  /** Id of the element that describes the dialog. */
  describedBy?: string
  wide?: boolean
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const { initialFocus, onCancel } = props
  const onCancelRef = useRef(onCancel)
  useLayoutEffect(() => {
    onCancelRef.current = onCancel
  })

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const madeInert: Element[] = []
    const backdrop = root.parentElement
    for (const el of Array.from(document.body.children)) {
      if (el === backdrop || el.hasAttribute('inert')) continue
      el.setAttribute('inert', '')
      madeInert.push(el)
    }
    const first = initialFocus?.current ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root
    first.focus()
    return () => {
      madeInert.forEach((el) => el.removeAttribute('inert'))
      if (previous && previous.isConnected) previous.focus()
    }
  }, [initialFocus])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      onCancelRef.current()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={props.wide ? 'modal modal-wide' : 'modal'}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="modal-title">
          {props.title}
        </h2>
        {props.children}
      </div>
    </div>,
    document.body,
  )
}
