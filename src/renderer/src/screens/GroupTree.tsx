import { useState } from 'react'
import type { GroupNode } from '@shared/types'
import { Icon } from '../components/Icons'

/** Groups sidebar: "All entries" plus the nested groups; subgroups can be collapsed. */
export function GroupTree(props: {
  groups: GroupNode[]
  total: number
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderNodes = (nodes: GroupNode[], depth: number) => (
    <ul className="group-list">
      {nodes.map((n) => {
        const open = !collapsed.has(n.path)
        return (
          <li key={n.path}>
            <div className="group-row" style={{ paddingInlineStart: `${depth * 14}px` }}>
              {n.children.length > 0 ? (
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${n.name}`}
                  onClick={() => toggle(n.path)}
                >
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                </button>
              ) : (
                <span className="tree-spacer" />
              )}
              <button
                type="button"
                className="group-button"
                aria-current={props.selected === n.path ? 'true' : undefined}
                onClick={() => props.onSelect(n.path)}
              >
                <Icon name="folder" size={14} />
                <span className="group-name">{n.name}</span>{' '}
                <span className="count">
                  {n.entryCount}
                  <span className="visually-hidden"> entries</span>
                </span>
              </button>
            </div>
            {open && n.children.length > 0 && renderNodes(n.children, depth + 1)}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="group-tree">
      <button
        type="button"
        className="group-button all"
        aria-current={props.selected === null ? 'true' : undefined}
        onClick={() => props.onSelect(null)}
      >
        <span className="group-name">All entries</span>{' '}
        <span className="count">
          {props.total}
          <span className="visually-hidden"> entries</span>
        </span>
      </button>
      {renderNodes(props.groups, 0)}
    </div>
  )
}
