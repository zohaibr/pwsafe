// `.plk` lock file handling per platform (docs/execution-plan.md §A6), matching Password Safe
// 1.25.0 (src/os/mac/file.cpp, src/os/unix/file.cpp) and 3.72.2 (src/os/windows/file.cpp):
//
//   macOS   O_CREAT|O_EXCL; any existing .plk means locked; never removed automatically.
//   Linux   same, but an orphan lock (same user, same host, pid no longer running) is removed,
//           and only on a local file system.
//   Windows v1 never takes a lock: every vault opens read-only (the vault decides this; here
//           acquireLock refuses without touching the disk).
//
// On every platform a lock we wrote ourselves (same user, host and our current pid) may be removed
// silently, except on a network volume, where nothing is ever removed automatically.
import type { FileSystem } from '../fs/types'
import { errnoOf, isNotFound } from '../fs/types'
import {
  decodeLocker,
  encodeLocker,
  formatLocker,
  type LockHolder,
  type LockPlatform,
  parseLocker,
} from './encoding'

export interface LockEnv {
  fs: FileSystem
  platform: LockPlatform
  /** This process: user name, host name and pid, as Password Safe would write them. */
  identity: LockHolder
  /** Whether a process with this pid exists on this machine; undefined when unknown. */
  processExists: (pid: number) => boolean | undefined
  /** The database is on a network volume (see fs/fsType.ts). */
  network: boolean
}

/** A lock this process holds. */
export interface HeldLock {
  path: string
  /** The exact bytes we wrote, to recognise our own lock on release. */
  content: Uint8Array
}

export type LockProbe =
  | { state: 'free' }
  /** A lock that the §A6 rules let us remove without asking. */
  | { state: 'removable'; why: 'own' | 'orphan'; holder: LockHolder }
  /** Someone else's lock (or one we may not remove automatically). */
  | { state: 'held'; holder?: LockHolder }
  /** Windows v1: no locking (the vault opens read-only). */
  | { state: 'unsupported-platform' }

export type AcquireResult =
  | { kind: 'acquired'; lock: HeldLock; removed?: 'own' | 'orphan' | 'user-choice' }
  | { kind: 'held'; holder?: LockHolder }
  /** The lock file could not be created (permissions, read-only volume, ...): open read-only. */
  | { kind: 'cannot-create'; code?: string }
  | { kind: 'unsupported-platform' }

export const LOCK_FILE_MODE = 0o600

/**
 * Lock path for a database, exactly as Password Safe derives it: `foo.psafe3` → `foo.plk` (the
 * text after the last '.' of the whole path is replaced), `foo.cfg` → `foo.cfg.plk`, and a path
 * without any '.' gets `.plk` appended. Like Password Safe, the last '.' may be in a folder name.
 */
export function lockPathFor(dbPath: string): string {
  if (dbPath.length > 4 && dbPath.endsWith('.cfg')) return `${dbPath}.plk`
  const dot = dbPath.lastIndexOf('.')
  return `${dot < 0 ? dbPath : dbPath.slice(0, dot)}.plk`
}

/** "user@host:pid" (pid without padding) for the LOCKED_BY_OTHER detail; undefined if unknown. */
export function holderDetail(holder: LockHolder | undefined): string | undefined {
  return holder ? `${holder.user}@${holder.host}:${holder.pid}` : undefined
}

/** The §A6 decision for an existing lock whose content we could read. */
export function classifyHolder(
  holder: LockHolder | undefined,
  env: Omit<LockEnv, 'fs'>,
): LockProbe {
  if (env.platform === 'win32') return { state: 'unsupported-platform' }
  if (!holder || env.network) return holder ? { state: 'held', holder } : { state: 'held' }
  const sameUserHost = holder.user === env.identity.user && holder.host === env.identity.host
  if (sameUserHost && holder.pid === env.identity.pid) {
    return { state: 'removable', why: 'own', holder }
  }
  if (env.platform === 'linux' && sameUserHost && env.processExists(holder.pid) === false) {
    return { state: 'removable', why: 'orphan', holder }
  }
  return { state: 'held', holder }
}

async function readHolder(fs: FileSystem, path: string): Promise<LockHolder | undefined | null> {
  try {
    const text = decodeLocker(await fs.readFile(path))
    return text === undefined ? undefined : parseLocker(text)
  } catch (e) {
    if (isNotFound(e)) return null
    return undefined
  }
}

/** Looks at the lock without changing anything. */
export async function probeLock(dbPath: string, env: LockEnv): Promise<LockProbe> {
  if (env.platform === 'win32') return { state: 'unsupported-platform' }
  const holder = await readHolder(env.fs, lockPathFor(dbPath))
  if (holder === null) return { state: 'free' }
  return classifyHolder(holder, env)
}

async function tryCreate(
  env: LockEnv,
  path: string,
  content: Uint8Array,
): Promise<'created' | 'exists' | { code?: string }> {
  let file
  try {
    file = await env.fs.createExclusive(path, LOCK_FILE_MODE)
  } catch (e) {
    if (errnoOf(e) === 'EEXIST') return 'exists'
    const code = errnoOf(e)
    return code === undefined ? {} : { code }
  }
  try {
    await file.write(content)
    await file.close()
    return 'created'
  } catch (e) {
    // A half-written lock would block everyone; remove it and open read-only instead.
    await file.close().catch(() => {})
    await env.fs.unlink(path).catch(() => {})
    const code = errnoOf(e)
    return code === undefined ? {} : { code }
  }
}

/**
 * Takes the lock for editing. An existing lock is removed only when §A6 allows it (our own, or a
 * Linux orphan on a local volume) or when the user explicitly chose "Remove lock and open"
 * (`removeExisting`, after the second confirmation). Never throws.
 */
export async function acquireLock(
  dbPath: string,
  env: LockEnv,
  options: { removeExisting?: boolean } = {},
): Promise<AcquireResult> {
  if (env.platform === 'win32') return { kind: 'unsupported-platform' }
  const path = lockPathFor(dbPath)
  const content = encodeLocker(formatLocker(env.identity), env.platform)
  let removed: 'own' | 'orphan' | 'user-choice' | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await tryCreate(env, path, content)
    if (r === 'created') {
      return removed
        ? { kind: 'acquired', lock: { path, content }, removed }
        : {
            kind: 'acquired',
            lock: { path, content },
          }
    }
    if (r !== 'exists')
      return r.code === undefined
        ? { kind: 'cannot-create' }
        : { kind: 'cannot-create', code: r.code }
    if (attempt === 1) break
    const holder = await readHolder(env.fs, path)
    if (holder === null) continue // vanished meanwhile: try again
    const probe = classifyHolder(holder, env)
    if (probe.state === 'removable') removed = probe.why
    else if (options.removeExisting) removed = 'user-choice'
    else
      return probe.state === 'held' && probe.holder
        ? { kind: 'held', holder: probe.holder }
        : { kind: 'held' }
    try {
      await env.fs.unlink(path)
    } catch (e) {
      if (!isNotFound(e)) {
        const code = errnoOf(e)
        return code === undefined ? { kind: 'cannot-create' } : { kind: 'cannot-create', code }
      }
    }
  }
  const holder = await readHolder(env.fs, path)
  return holder ? { kind: 'held', holder } : { kind: 'held' }
}

/**
 * Releases a lock we hold. The file is removed only if it still has exactly the content we wrote
 * (someone may have removed ours and taken the file). Returns whether it was removed. Never throws.
 */
export async function releaseLock(fs: FileSystem, lock: HeldLock): Promise<boolean> {
  try {
    const now = await fs.readFile(lock.path)
    if (now.length !== lock.content.length || !now.every((b, i) => b === lock.content[i])) {
      return false
    }
    await fs.unlink(lock.path)
    return true
  } catch {
    return false
  }
}
