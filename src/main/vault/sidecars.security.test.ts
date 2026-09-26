// docs/security-review.md F6: files next to the vault (`.plk`, backup journal, backups) are read
// only when they are regular files under a size cap, so a FIFO or a huge file planted under one of
// those names can neither hang the app nor be loaded whole. Nothing is deleted because of them.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_JOURNAL_BYTES, MAX_LOCK_FILE_BYTES, readRegularFile } from '../fs/bounded'
import { MemoryFileSystem } from '../fs/memoryFs'
import { createNodeFileSystem } from '../fs/nodeFs'
import type { FileStat, FileSystem } from '../fs/types'
import { errnoOf } from '../fs/types'
import {
  acquireLock,
  lockPathFor,
  probeLock,
  releaseLock,
  type LockEnv,
} from '../lockfile/lockfile'
import { recoverSidecars } from './rotation'
import { hashOrNone, sidecarsFor } from './sidecars'

const DB = '/v/db.psafe3'
const sc = sidecarsFor(resolve(DB))
const PLK = lockPathFor(resolve(DB))
const ME = { user: 'alex', host: 'studio', pid: 4312 }

const env = (fs: FileSystem): LockEnv => ({
  fs,
  platform: 'darwin',
  identity: ME,
  processExists: () => true,
  network: false,
})

/** Rejects if `p` has not settled within `ms` (a read of a FIFO would never settle). */
function settlesWithin<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('did not settle')), ms)),
  ])
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await settlesWithin(p)
    return 'ok'
  } catch (e) {
    return errnoOf(e) ?? (e as Error).message
  }
}

/**
 * Memory file system where the paths in `fifos` look like FIFOs: lstat says "not a regular file"
 * and readFile never returns, like a read of a FIFO nobody writes to.
 */
class FifoFs extends MemoryFileSystem {
  readonly reads: string[] = []
  constructor(private readonly fifos: string[]) {
    super()
    for (const f of fifos) this.setFile(f, new Uint8Array(0))
  }
  private isFifo(path: string): boolean {
    return this.fifos.some((f) => resolve(f) === resolve(path))
  }
  override async lstat(path: string): Promise<FileStat> {
    const st = await super.lstat(path)
    return this.isFifo(path) ? { ...st, isFile: false } : st
  }
  override readFile(path: string): Promise<Uint8Array> {
    this.reads.push(resolve(path))
    return this.isFifo(path) ? new Promise(() => {}) : super.readFile(path)
  }
}

describe('readRegularFile', () => {
  it('reads a regular file within the cap and refuses everything else', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile('/d/ok', Uint8Array.from([1, 2, 3]))
    fs.setFile('/d/big', new Uint8Array(101))
    fs.setSymlink('/d/link', 'ok')
    fs.mkdirp('/d/sub')
    expect(await readRegularFile(fs, '/d/ok', 100)).toEqual(Uint8Array.from([1, 2, 3]))
    expect(await codeOf(readRegularFile(fs, '/d/big', 100))).toBe('EFBIG')
    expect(await codeOf(readRegularFile(fs, '/d/link', 100))).toBe('EINVAL')
    expect(await codeOf(readRegularFile(fs, '/d/sub', 100))).toBe('EINVAL')
    expect(await codeOf(readRegularFile(fs, '/d/missing', 100))).toBe('ENOENT')
  })

  it('never calls readFile on a FIFO', async () => {
    const fs = new FifoFs(['/d/fifo'])
    expect(await codeOf(readRegularFile(fs, '/d/fifo', 100))).toBe('EINVAL')
    expect(fs.reads).toEqual([])
  })
})

describe('.plk that is not a small regular file', () => {
  it('a FIFO .plk reads as held (no holder) at once, is not removed, and is not released', async () => {
    const fs = new FifoFs([PLK])
    fs.setFile(DB, Uint8Array.from([1]))
    expect(await settlesWithin(probeLock(DB, env(fs)))).toEqual({ state: 'held' })
    expect(await settlesWithin(acquireLock(DB, env(fs)))).toEqual({ kind: 'held' })
    expect(await settlesWithin(releaseLock(fs, { path: PLK, content: new Uint8Array(0) }))).toBe(
      false,
    )
    expect(fs.peek(PLK)).toBeDefined()
    expect(fs.reads).not.toContain(resolve(PLK))
  })

  it('an oversized .plk reads as held without being loaded', async () => {
    const fs = new FifoFs([])
    fs.setFile(DB, Uint8Array.from([1]))
    fs.setFile(PLK, new Uint8Array(MAX_LOCK_FILE_BYTES + 1).fill(0x61))
    expect(await probeLock(DB, env(fs))).toEqual({ state: 'held' })
    expect(fs.reads).not.toContain(resolve(PLK))
  })
})

describe('backup journal and backups that are not small regular files', () => {
  it('a FIFO journal stops recovery at once and keeps every file', async () => {
    const fs = new FifoFs([sc.journal])
    fs.setFile(DB, Uint8Array.from([1, 2, 3]))
    fs.setFile(sc.backup(1), Uint8Array.from([4]))
    const report = await settlesWithin(recoverSidecars(fs, DB))
    expect(report.banners.map((b) => b.id)).toContain('recovery-failed')
    expect(fs.peek(sc.journal)).toBeDefined()
    expect(fs.peek(sc.backup(1))).toBeDefined()
  })

  it('an oversized journal is kept, not parsed and not deleted', async () => {
    const fs = new FifoFs([])
    fs.setFile(DB, Uint8Array.from([1, 2, 3]))
    fs.setFile(sc.journal, new Uint8Array(MAX_JOURNAL_BYTES + 1).fill(0x20))
    const report = await recoverSidecars(fs, DB)
    expect(report.banners.map((b) => b.id)).toContain('recovery-failed')
    expect(fs.peek(sc.journal)).toBeDefined()
    expect(fs.reads).not.toContain(resolve(sc.journal))
  })

  it('hashing a FIFO backup fails at once instead of hanging', async () => {
    const fs = new FifoFs([sc.backup(2)])
    expect(await codeOf(hashOrNone(fs, sc.backup(2)))).toBe('EINVAL')
    expect(await hashOrNone(fs, sc.backup(3))).toBeUndefined()
  })
})

// The same against a real FIFO on disk. Windows has no FIFOs (mkfifo), so this part is POSIX only;
// the memory-backed tests above cover the logic on every platform.
describe.skipIf(process.platform === 'win32')('real FIFOs on disk (POSIX)', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('.plk, journal and backup FIFOs are refused without blocking', async () => {
    dir = mkdtempSync(join(tmpdir(), 'psafe-fifo-'))
    const db = join(dir, 'db.psafe3')
    writeFileSync(db, Uint8Array.from([1, 2, 3]))
    const real = sidecarsFor(db)
    for (const p of [lockPathFor(db), real.journal, real.backup(1)]) execFileSync('mkfifo', [p])
    const fs = createNodeFileSystem()
    expect(await settlesWithin(probeLock(db, env(fs)))).toEqual({ state: 'held' })
    expect(await codeOf(hashOrNone(fs, real.backup(1)))).toBe('EINVAL')
    const report = await settlesWithin(recoverSidecars(fs, db))
    expect(report.banners.map((b) => b.id)).toContain('recovery-failed')
    for (const p of [lockPathFor(db), real.journal, real.backup(1)])
      expect(existsSync(p)).toBe(true)
  })
})
