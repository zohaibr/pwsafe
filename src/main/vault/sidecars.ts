// Names of the files a save creates next to the database (docs/execution-plan.md §A5).
//   foo.psafe3.bak, .bak2, .bak3         backup generations (newest first)
//   .foo.psafe3.<tag>.new                the new database before the commit rename
//   .foo.psafe3.<tag>.bak-staged         copy of the database, becomes .bak after the commit
//   .foo.psafe3.rotation.json            the backup-rotation journal
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { FileSystem } from '../fs/types'
import { isNotFound } from '../fs/types'
import { MAX_BACKUP_BYTES, readRegularFile } from '../fs/bounded'
import { BACKUP_GENERATIONS } from '../../shared/limits'

export const TAG_RE = /^[0-9a-f]{12}$/

export interface Sidecars {
  dir: string
  /** Base name of the database. */
  name: string
  db: string
  newFile(tag: string): string
  staged(tag: string): string
  journal: string
  /** Path of backup generation 1..3. */
  backup(gen: number): string
  backupName(gen: number): string
  isNewFileName(entry: string): boolean
  /** The tag of a `.bak-staged` entry name, or undefined. */
  stagedTag(entry: string): string | undefined
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sidecarsFor(dbPath: string): Sidecars {
  const dir = dirname(dbPath)
  const name = basename(dbPath)
  const newRe = new RegExp(`^\\.${escapeRe(name)}\\.([0-9a-f]{12})\\.new$`)
  const stagedRe = new RegExp(`^\\.${escapeRe(name)}\\.([0-9a-f]{12})\\.bak-staged$`)
  const backupName = (gen: number) => (gen === 1 ? `${name}.bak` : `${name}.bak${gen}`)
  return {
    dir,
    name,
    db: dbPath,
    newFile: (tag) => join(dir, `.${name}.${tag}.new`),
    staged: (tag) => join(dir, `.${name}.${tag}.bak-staged`),
    journal: join(dir, `.${name}.rotation.json`),
    backup: (gen) => join(dir, backupName(gen)),
    backupName,
    isNewFileName: (entry) => newRe.test(entry),
    stagedTag: (entry) => stagedRe.exec(entry)?.[1],
  }
}

export const GENERATIONS: readonly number[] = Array.from(
  { length: BACKUP_GENERATIONS },
  (_, i) => i + 1,
)

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 of a file, or undefined when it does not exist. Other errors are thrown. */
export async function hashOrNone(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readRegularFile(fs, path, MAX_BACKUP_BYTES))
  } catch (e) {
    if (isNotFound(e)) return undefined
    throw e
  }
}

/** Whether a directory entry exists (lstat, so a dangling symlink counts). Other errors throw. */
export async function existsNoFollow(fs: FileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
}
