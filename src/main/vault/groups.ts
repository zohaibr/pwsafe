// Group tree for the sidebar, built from entry group paths and the header's empty groups.
import type { Entry, GroupNode } from '../../shared/types'

/** Splits a stored group path on unescaped dots (Password Safe escapes a literal dot as "\."). */
export function splitGroupPath(path: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!
    if (c === '\\' && path[i + 1] === '.') {
      cur += '\\.'
      i++
    } else if (c === '.') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts.filter((p) => p !== '')
}

/**
 * Builds the tree. `entryCount` counts the entries in a group and all its subgroups. Groups from
 * the header's empty-group list appear with a count of 0.
 */
export function buildGroupTree(
  entries: readonly Entry[],
  emptyGroups: readonly string[] = [],
): GroupNode[] {
  const roots: GroupNode[] = []
  const add = (group: string, counts: boolean) => {
    const parts = splitGroupPath(group)
    let level = roots
    let path = ''
    parts.forEach((part, i) => {
      path = path ? `${path}.${part}` : part
      let node = level.find((n) => n.path === path)
      if (!node) {
        node = { path, name: part.replace(/\\\./g, '.'), entryCount: 0, children: [] }
        level.push(node)
      }
      if (counts) node.entryCount++
      if (i < parts.length - 1) level = node.children
    })
  }
  for (const e of entries) add(e.group, true)
  for (const g of emptyGroups) add(g, false)
  const sort = (nodes: GroupNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((n) => sort(n.children))
  }
  sort(roots)
  return roots
}
