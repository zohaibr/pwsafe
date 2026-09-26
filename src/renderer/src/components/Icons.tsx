// Small inline icons. Always decorative (aria-hidden); the control that holds one has a name.
const paths = {
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z',
  unlock: 'M7 10V7a5 5 0 0 1 9.6-2M5 10h14v11H5z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff:
    'M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  folder: 'M3 6h6l2 2h10v11H3z',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  warning: 'M12 3l10 18H2zM12 10v4M12 17v.5',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 11v6M12 7v.5',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  file: 'M6 2h8l5 5v15H6zM14 2v5h5',
  shield: 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z',
} as const

export type IconName = keyof typeof paths

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[props.name]} />
    </svg>
  )
}
