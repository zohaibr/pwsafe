import { useEffect, useState, useSyncExternalStore } from 'react'

function subscribeResize(cb: () => void): () => void {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth)
}

/**
 * Seconds left until `until` (epoch ms), ticking while above zero. Remount (key) the component
 * when `until` changes so the starting time is fresh.
 */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= until) clearInterval(id)
    }, 250)
    return () => clearInterval(id)
  }, [until])
  if (until === null) return 0
  return Math.max(0, Math.ceil((until - now) / 1000))
}

/** True when the platform uses ⌘ for shortcuts. */
export const isMac = (): boolean =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Display text for a shortcut: "⌘S" on macOS, "Ctrl+S" elsewhere. */
export const shortcutLabel = (key: string): string => (isMac() ? `⌘${key}` : `Ctrl+${key}`)

/** Unescapes a stored group path for display: `a.b\.c` → `a › b.c`. */
export function displayGroup(path: string): string {
  if (!path) return 'No group'
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === '\\' && path[i + 1] === '.') {
      cur += '.'
      i++
    } else if (c === '.') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts.filter(Boolean).join(' › ')
}

/** Whether an entry's group is `path` or inside it. */
export function inGroup(entryGroup: string, path: string | null): boolean {
  return path === null || entryGroup === path || entryGroup.startsWith(`${path}.`)
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
