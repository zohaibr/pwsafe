// Network-volume detection (docs/execution-plan.md §A6): O_EXCL is not reliable on network file
// systems, so there we show a banner and never remove a lock automatically.
import type { FsTypeInfo } from './types'

/** Linux `statfs.f_type` values of network or remote-backed file systems (linux/magic.h). */
export const LINUX_NETWORK_MAGICS: ReadonlyMap<number, string> = new Map([
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
  [0x564c, 'ncp'],
  [0x73757245, 'coda'],
  [0x5346414f, 'afs'],
  [0x6b414653, 'kafs'],
  [0x00c36400, 'ceph'],
  [0x01021997, 'v9fs'],
  [0x01161970, 'gfs2'],
  [0x7461636f, 'ocfs2'],
  [0x0bd00bd0, 'lustre'],
  // FUSE: gvfs (smb://, sftp://), sshfs and similar are mounted through FUSE, so treat it as remote.
  [0x65735546, 'fuse'],
])

/** macOS file system type names (from the mount table) of network or remote-backed volumes. */
export const MAC_NETWORK_TYPES: ReadonlySet<string> = new Set([
  'smbfs',
  'afpfs',
  'nfs',
  'webdav',
  'cifs',
  'ftp',
  'macfuse',
  'osxfuse',
  'fusefs',
])

/** True when the volume is known to be a network file system. Unknown counts as local. */
export function isNetworkFs(info: FsTypeInfo): boolean {
  if (info.magic !== undefined && LINUX_NETWORK_MAGICS.has(info.magic >>> 0)) return true
  if (info.name !== undefined) {
    const n = info.name.toLowerCase()
    if (MAC_NETWORK_TYPES.has(n) || n.startsWith('fuse') || n.includes('fuse')) return true
  }
  return false
}

/**
 * Finds the type of the mount holding `realPath` in macOS `/sbin/mount` output, whose lines look
 * like `//user@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)`.
 * The longest matching mount point wins.
 */
export function mountTypeFor(mountTable: string, realPath: string): string | undefined {
  let best: { point: string; type: string } | undefined
  for (const line of mountTable.split('\n')) {
    const m = / on (.+) \(([^,()]+)[,)]/.exec(line)
    if (!m) continue
    const point = m[1]!
    const type = m[2]!.trim()
    const inside =
      point === '/' ||
      realPath === point ||
      realPath.startsWith(point.endsWith('/') ? point : `${point}/`)
    if (inside && (!best || point.length > best.point.length)) best = { point, type }
  }
  return best?.type
}
