import { forwardRef, useEffect, type KeyboardEvent } from 'react'
import type { Entry } from '@shared/types'
import { Icon } from '../components/Icons'
import { displayGroup } from '../hooks'

const optionId = (uuid: string) => `entry-${uuid}`

/**
 * Entry list as a single-select listbox: arrows/Home/End move the selection, Delete (or
 * Backspace, the Mac "delete" key) asks to delete the selected entry (§B7).
 */
export const EntryList = forwardRef<
  HTMLUListElement,
  {
    entries: Entry[]
    label: string
    selected: string | null
    onSelect: (uuid: string) => void
    onDelete: (uuid: string) => void
  }
>(function EntryList(props, ref) {
  const { entries, selected } = props
  const index = entries.findIndex((e) => e.uuid === selected)

  useEffect(() => {
    if (!selected) return
    const el = document.getElementById(optionId(selected))
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = entries.length - 1
    let next: number | null = null
    if (e.key === 'ArrowDown') next = Math.min(last, index + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      props.onDelete(selected)
      return
    }
    if (next === null) return
    e.preventDefault()
    const target = entries[next]
    if (target) props.onSelect(target.uuid)
  }

  if (entries.length === 0) {
    return (
      <p className="empty" role="status">
        No entries here.
      </p>
    )
  }

  return (
    <ul
      ref={ref}
      className="entry-list"
      role="listbox"
      aria-label={props.label}
      tabIndex={0}
      aria-activedescendant={index >= 0 && selected ? optionId(selected) : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (index < 0 && entries[0]) props.onSelect(entries[0].uuid)
      }}
    >
      {entries.map((e) => (
        <li
          key={e.uuid}
          id={optionId(e.uuid)}
          role="option"
          aria-selected={e.uuid === selected}
          className="entry-item"
          onClick={() => props.onSelect(e.uuid)}
        >
          <span className="entry-avatar" aria-hidden="true">
            {(e.title.trim()[0] ?? '?').toUpperCase()}
          </span>
          <span className="entry-text">
            <span className="entry-title">
              {e.title || '(no title)'}
              {!e.editable && (
                <span className="inline-badge" title="Read-only">
                  <Icon name="lock" size={12} />
                  <span className="visually-hidden">, read-only</span>
                </span>
              )}
              {(e.kind === 'alias' || e.kind === 'shortcut') && (
                <span className="inline-badge" title={e.kind === 'alias' ? 'Alias' : 'Shortcut'}>
                  <Icon name="link" size={12} />
                  <span className="visually-hidden">, {e.kind}</span>
                </span>
              )}
            </span>
            <span className="entry-sub">
              {e.username || '—'} · {displayGroup(e.group)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
})
