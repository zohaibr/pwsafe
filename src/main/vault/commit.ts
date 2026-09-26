// The save pipeline, steps 1–10 of docs/execution-plan.md §A5, on the injectable file system.
// The database replace (step 7) is the single commit point: before it, any failure leaves the
// database and every backup generation exactly as they were and removes our staged files; after
// it, the save has happened and only the backup rotation or the directory fsync can be incomplete.
import { basename, dirname } from 'node:path'
import type { Result } from '../../shared/errors'
import type { FileSystem } from '../fs/types'
import { describeIoError, errnoOf, isNotFound } from '../fs/types'
import type { LockPlatform } from '../lockfile/encoding'
import {
  encodeJournal,
  planJournal,
  recoverSidecars,
  runRotation,
  type RotationResult,
} from './rotation'
import { existsNoFollow, hashOrNone, sha256Hex, sidecarsFor } from './sidecars'

/** What we know about the database file as read at open or written by our last save. */
export interface DiskState {
  dev: string
  ino: string
  size: number
  mtimeMs: number
  sha256: string
  /** Permission bits (for the new file). */
  mode: number
}

export interface CommitDeps {
  fs: FileSystem
  platform: LockPlatform
  /** 12 lowercase hex characters, fresh for every save. */
  randomTag: () => string
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
  /** Called as each step starts (diagnostics and the fault-injection tests). */
  onStep?: (step: number) => void
}

/** Step 2: serialise the model and check it re-parses to the same model. Error detail = reason. */
export type Produce = () => Promise<Result<Uint8Array>>
/** Step 4: verify the bytes read back from disk. Error detail = reason. */
export type Verify = (readBack: Uint8Array) => Promise<Result<void>>

export type CommitOutcome =
  | {
      kind: 'failed'
      code: 'SAVE_FAILED' | 'FILE_CHANGED_ON_DISK'
      step: number
      /** "Step N: reason." for SAVE_FAILED. */
      detail?: string
    }
  | {
      kind: 'saved'
      disk: DiskState
      rotation: RotationResult
      /** false: the directory fsync failed (SAVED_DURABILITY_UNCONFIRMED). */
      durable: boolean
    }

class StepFailure extends Error {
  constructor(
    readonly code: 'SAVE_FAILED' | 'FILE_CHANGED_ON_DISK',
    readonly reason?: string,
  ) {
    super(reason ?? code)
  }
}

const changed = (reason?: string) => new StepFailure('FILE_CHANGED_ON_DISK', reason)

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Reads the current state of a regular file (lstat + content hash). Throws on I/O errors. */
export async function readDiskState(
  fs: FileSystem,
  path: string,
): Promise<{ state: DiskState; bytes: Uint8Array }> {
  const st = await fs.lstat(path)
  if (!st.isFile) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' })
  const bytes = await fs.readFile(path)
  return {
    bytes,
    state: {
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: sha256Hex(bytes),
      mode: st.mode & 0o777,
    },
  }
}

async function writeNewFile(
  fs: FileSystem,
  path: string,
  mode: number,
  bytes: Uint8Array,
  created: string[],
): Promise<void> {
  const f = await fs.createExclusive(path, mode)
  // Registered only once we created it: an EEXIST must never make us delete someone else's file.
  created.push(path)
  try {
    await f.write(bytes)
    await f.sync()
  } catch (e) {
    await f.close().catch(() => {})
    throw e
  }
  await f.close()
}

async function cleanup(fs: FileSystem, created: string[], log: (m: string) => void): Promise<void> {
  for (const p of created.reverse()) {
    try {
      await fs.unlink(p)
    } catch (e) {
      if (!isNotFound(e)) log(`save: could not remove ${basename(p)}; it is removed on next open`)
    }
  }
}

/** Step 7 rename; on Windows MoveFileEx(REPLACE_EXISTING) is retried 3 times on EPERM/EBUSY. */
async function commitRename(deps: CommitDeps, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.fs.rename(from, to)
      return
    } catch (e) {
      const code = errnoOf(e)
      const retry =
        deps.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
      if (!retry || attempt >= 3) throw e
      await deps.sleep(100 * (attempt + 1))
    }
  }
}

export interface ReplaceTarget {
  /** Real path of the database (symlinks resolved at open). */
  dbPath: string
  /** The path the user opened; its realpath must still be `dbPath` at step 6. */
  openedPath: string
  /** State as read at open or at our last save. */
  expected: DiskState
}

/**
 * Replaces an existing database through §A5 steps 1–10. Never throws.
 */
export async function commitReplace(
  deps: CommitDeps,
  target: ReplaceTarget,
  produce: Produce,
  verify: Verify,
): Promise<CommitOutcome> {
  const { fs, log } = deps
  const sc = sidecarsFor(target.dbPath)
  const exp = target.expected
  const created: string[] = []
  let step = 1
  const enter = (n: number) => {
    step = n
    deps.onStep?.(n)
  }
  let newPath: string | undefined
  let newState: DiskState | undefined
  let journalPlan: ReturnType<typeof planJournal> | undefined
  let produced: Uint8Array | undefined

  try {
    // 1. Conflict check (and finish a rotation left over from an earlier save first).
    enter(1)
    if (await existsNoFollow(fs, sc.journal)) {
      await recoverSidecars(fs, target.dbPath, log)
      if (await existsNoFollow(fs, sc.journal)) {
        throw new StepFailure(
          'SAVE_FAILED',
          'backups from an earlier save are in an unexpected state. Use Save As, or sort out the backup files first',
        )
      }
    }
    let cur
    try {
      cur = await readDiskState(fs, target.dbPath)
    } catch (e) {
      if (isNotFound(e) || errnoOf(e) === 'EISDIR') throw changed()
      throw e
    }
    if (
      cur.state.size !== exp.size ||
      cur.state.mtimeMs !== exp.mtimeMs ||
      cur.state.sha256 !== exp.sha256
    ) {
      throw changed()
    }

    // 2. Serialise in memory with fresh salt/IV/K/L/padding and re-parse.
    enter(2)
    const p = await produce()
    if (!p.ok) throw new StepFailure('SAVE_FAILED', p.error.detail ?? p.error.message)
    produced = p.value

    // 3. Write .new with O_EXCL and the database's permission bits; fsync.
    enter(3)
    const tag = deps.randomTag()
    newPath = sc.newFile(tag)
    await writeNewFile(fs, newPath, cur.state.mode, produced, created)

    // 4. Re-read .new and verify.
    enter(4)
    const back = await fs.readFile(newPath)
    if (!equalBytes(back, produced)) {
      throw new StepFailure('SAVE_FAILED', 'the new file could not be read back correctly')
    }
    const v = await verify(back)
    if (!v.ok) throw new StepFailure('SAVE_FAILED', v.error.detail ?? v.error.message)
    const nst = await fs.lstat(newPath)
    newState = {
      dev: nst.dev,
      ino: nst.ino,
      size: nst.size,
      mtimeMs: nst.mtimeMs,
      sha256: sha256Hex(produced),
      mode: nst.mode & 0o777,
    }

    // 5. Stage the backup: copy the database, fsync, check it is what we read. Existing backups
    //    are only hashed. Then write and fsync the rotation journal.
    enter(5)
    const staged = sc.staged(tag)
    try {
      await fs.copyFile(target.dbPath, staged)
    } catch (e) {
      // A failed copy may leave a partial file behind; never remove a file we did not create.
      if (errnoOf(e) !== 'EEXIST') created.push(staged)
      throw e
    }
    created.push(staged)
    await fs.fsyncFile(staged)
    const hs = sha256Hex(await fs.readFile(staged))
    if (hs !== exp.sha256) throw changed()
    const h1 = await hashOrNone(fs, sc.backup(1))
    const h2 = await hashOrNone(fs, sc.backup(2))
    journalPlan = planJournal(sc, tag, { h1, h2, hOld: hs, hNew: newState.sha256 })
    await writeNewFile(fs, sc.journal, 0o600, encodeJournal(journalPlan), created)
    try {
      // Make the journal's name durable before the commit. Best effort: some volumes cannot fsync
      // a directory, and that must not block saving (step 9 reports durability).
      await fs.fsyncDir(sc.dir)
    } catch {
      log('save: directory fsync before the commit failed; continuing')
    }

    // 6. Final check: same regular file (device + inode), same size/mtime/hash, same realpath.
    enter(6)
    let st
    try {
      st = await fs.lstat(target.dbPath)
    } catch (e) {
      if (isNotFound(e)) throw changed()
      throw e
    }
    if (
      !st.isFile ||
      st.dev !== exp.dev ||
      st.ino !== exp.ino ||
      st.size !== exp.size ||
      st.mtimeMs !== exp.mtimeMs
    ) {
      throw changed()
    }
    if (sha256Hex(await fs.readFile(target.dbPath)) !== exp.sha256) throw changed()
    let real: string
    try {
      real = await fs.realpath(target.openedPath)
    } catch (e) {
      if (isNotFound(e)) throw changed()
      throw e
    }
    if (real !== target.dbPath) throw changed('path now points elsewhere')

    // 7. Commit.
    enter(7)
    await commitRename(deps, newPath, target.dbPath)
  } catch (e) {
    await cleanup(fs, created, log)
    if (e instanceof StepFailure) {
      if (e.code === 'FILE_CHANGED_ON_DISK') {
        log(`save: file changed on disk (step ${step})`)
        return { kind: 'failed', code: 'FILE_CHANGED_ON_DISK', step }
      }
      log(`save failed at step ${step}`)
      return { kind: 'failed', code: 'SAVE_FAILED', step, detail: `Step ${step}: ${e.reason}.` }
    }
    log(`save failed at step ${step} (${errnoOf(e) ?? 'error'})`)
    return {
      kind: 'failed',
      code: 'SAVE_FAILED',
      step,
      detail: `Step ${step}: ${describeIoError(e)}.`,
    }
  }

  // Committed: the new database is in place.
  // 8. Backup rotation from the journal (never throws).
  enter(8)
  const rotation = await runRotation(fs, sc, journalPlan!, log)
  // 9. Directory fsync.
  enter(9)
  let durable = true
  try {
    await fs.fsyncDir(sc.dir)
  } catch {
    durable = false
    log('save: directory fsync failed')
  }
  // 10. The caller updates the stored state and clears the dirty flag. The staged copy was moved
  //     by the rotation, or is kept until its move is confirmed.
  enter(10)
  return { kind: 'saved', disk: newState!, rotation, durable }
}

/**
 * Save As to a path that does not exist (§A5 Save As "New path"): steps 2–4 write and verify
 * `.new` next to the destination, then `link(.new, dest)` commits without ever clobbering a file
 * that appeared meanwhile (EEXIST → FILE_CHANGED_ON_DISK), and `.new` is removed. Never throws.
 */
export async function commitNew(
  deps: CommitDeps,
  destPath: string,
  mode: number,
  produce: Produce,
  verify: Verify,
): Promise<CommitOutcome> {
  const { fs, log } = deps
  const sc = sidecarsFor(destPath)
  const created: string[] = []
  let step = 1
  const enter = (n: number) => {
    step = n
    deps.onStep?.(n)
  }
  let newPath: string | undefined
  let newState: DiskState | undefined
  try {
    enter(1)
    if (await existsNoFollow(fs, destPath)) throw changed('a file appeared at that path')
    enter(2)
    const p = await produce()
    if (!p.ok) throw new StepFailure('SAVE_FAILED', p.error.detail ?? p.error.message)
    enter(3)
    newPath = sc.newFile(deps.randomTag())
    await writeNewFile(fs, newPath, mode, p.value, created)
    enter(4)
    const back = await fs.readFile(newPath)
    if (!equalBytes(back, p.value)) {
      throw new StepFailure('SAVE_FAILED', 'the new file could not be read back correctly')
    }
    const v = await verify(back)
    if (!v.ok) throw new StepFailure('SAVE_FAILED', v.error.detail ?? v.error.message)
    const nst = await fs.lstat(newPath)
    newState = {
      dev: nst.dev,
      ino: nst.ino,
      size: nst.size,
      mtimeMs: nst.mtimeMs,
      sha256: sha256Hex(p.value),
      mode: nst.mode & 0o777,
    }
    enter(7)
    try {
      await fs.link(newPath, destPath)
    } catch (e) {
      const code = errnoOf(e)
      if (code === 'EEXIST') throw changed('a file appeared at that path')
      // File systems without hard links (FAT, exFAT, some network shares): check and rename.
      if (code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EPERM') {
        throw e
      }
      if (await existsNoFollow(fs, destPath)) throw changed('a file appeared at that path')
      await commitRename(deps, newPath, destPath)
      created.splice(created.indexOf(newPath), 1)
    }
  } catch (e) {
    await cleanup(fs, created, log)
    if (e instanceof StepFailure) {
      if (e.code === 'FILE_CHANGED_ON_DISK') return { kind: 'failed', code: e.code, step }
      return { kind: 'failed', code: 'SAVE_FAILED', step, detail: `Step ${step}: ${e.reason}.` }
    }
    return {
      kind: 'failed',
      code: 'SAVE_FAILED',
      step,
      detail: `Step ${step}: ${describeIoError(e)}.`,
    }
  }
  // Committed. Drop the second name (a leftover is removed by the next open's recovery).
  try {
    await fs.unlink(newPath!)
  } catch (e) {
    if (!isNotFound(e)) log('save as: could not remove the temporary file; removed on next open')
  }
  enter(9)
  let durable = true
  try {
    await fs.fsyncDir(dirname(destPath))
  } catch {
    durable = false
  }
  enter(10)
  return { kind: 'saved', disk: newState!, rotation: { kind: 'done' }, durable }
}
