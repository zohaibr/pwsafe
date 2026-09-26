// §A6 lock file rules, one block per platform value. The platform is injected, so every row runs on
// every CI OS; the last block also runs against the real file system of the OS running the tests.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFileSystem, MUTATING_OPS } from '../fs/memoryFs'
import { createNodeFileSystem } from '../fs/nodeFs'
import {
  decodeLocker,
  encodeLocker,
  encodeUtf16le,
  encodeUtf32le,
  formatLocker,
  type LockHolder,
  type LockPlatform,
  parseLocker,
} from './encoding'
import {
  acquireLock,
  classifyHolder,
  holderDetail,
  type LockEnv,
  lockPathFor,
  probeLock,
  releaseLock,
} from './lockfile'

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'))

// Byte-exact fixtures: "a@b:00000042" as Password Safe writes it on each platform.
const SHORT = 'a@b:00000042'
const SHORT_UTF32LE = hex(`
  61000000 40000000 62000000 3a000000 30000000 30000000
  30000000 30000000 30000000 30000000 34000000 32000000`)
const SHORT_UTF16LE = hex('6100 4000 6200 3a00 3000 3000 3000 3000 3000 3000 3400 3200')
const SHORT_ASCII = hex('61 40 62 3a 30 30 30 30 30 30 34 32')

const ME: LockHolder = { user: 'alex', host: 'studio', pid: 4312 }
const DB = '/vaults/personal.psafe3'
const PLK = '/vaults/personal.plk'

function env(
  fs: MemoryFileSystem,
  platform: LockPlatform,
  over: Partial<Omit<LockEnv, 'fs' | 'platform'>> = {},
): LockEnv {
  return { fs, platform, identity: ME, processExists: () => true, network: false, ...over }
}

function diskWith(lock?: string | Uint8Array, platform: LockPlatform = 'darwin'): MemoryFileSystem {
  const fs = new MemoryFileSystem()
  fs.setFile(DB, new Uint8Array([1, 2, 3]))
  if (lock !== undefined) {
    fs.setFile(PLK, typeof lock === 'string' ? encodeLocker(lock, platform) : lock)
  }
  return fs
}

describe('lock file name (same derivation as Password Safe GetLockFileName)', () => {
  it.each([
    ['/v/foo.psafe3', '/v/foo.plk'],
    ['/v/foo.dat', '/v/foo.plk'],
    ['/v/foo', '/v/foo.plk'],
    ['/v/foo.cfg', '/v/foo.cfg.plk'],
    ['/v/foo.bar.psafe3', '/v/foo.bar.plk'],
    // Like Password Safe, the last '.' of the whole path counts, even in a folder name.
    ['/v/my.docs/vault', '/v/my.plk'],
  ])('%s → %s', (db, plk) => expect(lockPathFor(db)).toBe(plk))
})

describe('lock content encoding', () => {
  it('pads the pid to 8 digits like pws_os::getprocessid', () => {
    expect(formatLocker({ user: 'a', host: 'b', pid: 42 })).toBe(SHORT)
    expect(formatLocker({ user: 'u', host: 'h', pid: 123456789 })).toBe('u@h:123456789')
  })

  it('writes UTF-32LE on macOS and Linux, UTF-16LE on Windows (byte-exact)', () => {
    expect(encodeLocker(SHORT, 'darwin')).toEqual(SHORT_UTF32LE)
    expect(encodeLocker(SHORT, 'linux')).toEqual(SHORT_UTF32LE)
    expect(encodeLocker(SHORT, 'win32')).toEqual(SHORT_UTF16LE)
  })

  it.each([
    ['UTF-32LE', SHORT_UTF32LE],
    ['UTF-16LE', SHORT_UTF16LE],
    ['ASCII', SHORT_ASCII],
  ])('reads %s', (_name, bytes) => {
    expect(decodeLocker(bytes)).toBe(SHORT)
    expect(parseLocker(decodeLocker(bytes)!)).toEqual({ user: 'a', host: 'b', pid: 42 })
  })

  it('reads non-ASCII names in every encoding', () => {
    const s = 'jürgen@höst-🔑:00000007'
    expect(decodeLocker(encodeUtf32le(s))).toBe(s)
    expect(decodeLocker(encodeUtf16le(s))).toBe(s)
    expect(decodeLocker(new TextEncoder().encode(s))).toBe(s)
  })

  it('tolerates a trailing NUL and a BOM', () => {
    expect(decodeLocker(new Uint8Array([...SHORT_UTF32LE, 0, 0, 0, 0]))).toBe(SHORT)
    expect(decodeLocker(new Uint8Array([...SHORT_UTF16LE, 0, 0]))).toBe(SHORT)
    expect(decodeLocker(new Uint8Array([0xff, 0xfe, ...SHORT_UTF16LE]))).toBe(SHORT)
  })

  it('rejects bytes that are not text', () => {
    expect(decodeLocker(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined()
    expect(decodeLocker(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined()
  })

  it.each([
    ['alex@studio:00004312', { user: 'alex', host: 'studio', pid: 4312 }],
    ['alex@studio.local:1', { user: 'alex', host: 'studio.local', pid: 1 }],
    ['@studio:1', undefined],
    ['alex@:1', undefined],
    ['alex@studio', undefined],
    ['alex@studio:', undefined],
    ['alex@studio:x1', undefined],
    ['garbage', undefined],
  ])('parses %j', (text, expected) => expect(parseLocker(text)).toEqual(expected))
})

// ── Per-platform rows (§A6 table) ─────────────────────────────────────────────
const OTHER = 'bob@other-mac:00000077'
const SAME_USER_HOST_DEAD = 'alex@studio:00009999'
const OWN = 'alex@studio:00004312'

describe.each(['darwin', 'linux'] as const)('%s: common rows', (platform) => {
  it('free: creates the lock with O_EXCL, mode 0600, native encoding, then releases it', async () => {
    const fs = diskWith()
    const r = await acquireLock(DB, env(fs, platform))
    expect(r.kind).toBe('acquired')
    expect(fs.peek(PLK)).toEqual(encodeLocker(OWN, platform))
    expect((await fs.lstat(PLK)).mode & 0o777).toBe(0o600)
    expect(fs.ops.find((o) => o.name === 'createExclusive')?.path).toBe(MemoryFileSystem.norm(PLK))
    if (r.kind !== 'acquired') throw new Error()
    expect(await releaseLock(fs, r.lock)).toBe(true)
    expect(fs.exists(PLK)).toBe(false)
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    "another user's lock (written on %s) is held, with who/where for the dialog",
    async (writer) => {
      const fs = diskWith(OTHER, writer)
      expect(await probeLock(DB, env(fs, platform))).toEqual({
        state: 'held',
        holder: { user: 'bob', host: 'other-mac', pid: 77 },
      })
      const r = await acquireLock(DB, env(fs, platform))
      expect(r).toEqual({ kind: 'held', holder: { user: 'bob', host: 'other-mac', pid: 77 } })
      expect(holderDetail(r.kind === 'held' ? r.holder : undefined)).toBe('bob@other-mac:77')
      expect(fs.peek(PLK)).toEqual(encodeLocker(OTHER, writer))
    },
  )

  it('an unreadable lock is held (never removed automatically)', async () => {
    const fs = diskWith(new Uint8Array([0xff, 0x00, 0x13]))
    expect(await probeLock(DB, env(fs, platform))).toEqual({ state: 'held' })
    expect(await acquireLock(DB, env(fs, platform))).toEqual({ kind: 'held' })
    expect(fs.exists(PLK)).toBe(true)
  })

  it('our own lock (same user, host and current pid) is removed silently', async () => {
    const fs = diskWith(OWN, platform)
    expect((await probeLock(DB, env(fs, platform))).state).toBe('removable')
    const r = await acquireLock(DB, env(fs, platform))
    expect(r).toMatchObject({ kind: 'acquired', removed: 'own' })
    expect(fs.peek(PLK)).toEqual(encodeLocker(OWN, platform))
  })

  it('"Remove lock and open" (explicit choice) replaces another user\'s lock', async () => {
    const fs = diskWith(OTHER)
    const r = await acquireLock(DB, env(fs, platform), { removeExisting: true })
    expect(r).toMatchObject({ kind: 'acquired', removed: 'user-choice' })
    expect(fs.peek(PLK)).toEqual(encodeLocker(OWN, platform))
  })

  it("can't create the lock (read-only folder) → cannot-create, nothing written", async () => {
    const fs = diskWith()
    fs.setReadOnlyDir('/vaults')
    expect(await acquireLock(DB, env(fs, platform))).toEqual({
      kind: 'cannot-create',
      code: 'EACCES',
    })
    expect(fs.list('/vaults')).toEqual(['personal.psafe3'])
  })

  it('a lock whose write fails is removed again (no half-written lock is left)', async () => {
    const fs = diskWith()
    fs.onOp = (op) => (op.name === 'write' ? { kind: 'fail', code: 'ENOSPC' } : undefined)
    expect(await acquireLock(DB, env(fs, platform))).toEqual({
      kind: 'cannot-create',
      code: 'ENOSPC',
    })
    expect(fs.exists(PLK)).toBe(false)
  })

  it('network volume: even our own lock is never removed automatically', async () => {
    const fs = diskWith(OWN, platform)
    expect(await probeLock(DB, env(fs, platform, { network: true }))).toMatchObject({
      state: 'held',
    })
    expect((await acquireLock(DB, env(fs, platform, { network: true }))).kind).toBe('held')
  })

  it('release leaves a lock that is no longer ours', async () => {
    const fs = diskWith()
    const r = await acquireLock(DB, env(fs, platform))
    if (r.kind !== 'acquired') throw new Error()
    fs.setFile(PLK, encodeLocker(OTHER, platform))
    expect(await releaseLock(fs, r.lock)).toBe(false)
    expect(fs.peek(PLK)).toEqual(encodeLocker(OTHER, platform))
  })
})

describe('darwin: never removes a lock automatically (mac/file.cpp has no stale-lock removal)', () => {
  it('same user and host, pid no longer running → still held', async () => {
    const fs = diskWith(SAME_USER_HOST_DEAD)
    const e = env(fs, 'darwin', { processExists: () => false })
    expect((await probeLock(DB, e)).state).toBe('held')
    expect((await acquireLock(DB, e)).kind).toBe('held')
    expect(fs.peek(PLK)).toEqual(encodeLocker(SAME_USER_HOST_DEAD, 'darwin'))
  })
})

describe('linux: orphan rule (unix/file.cpp): same user, same host, pid gone, local volume', () => {
  it('orphan is removed and replaced with ours', async () => {
    const fs = diskWith(SAME_USER_HOST_DEAD, 'linux')
    const e = env(fs, 'linux', { processExists: (pid) => pid !== 9999 })
    expect(await probeLock(DB, e)).toEqual({
      state: 'removable',
      why: 'orphan',
      holder: { user: 'alex', host: 'studio', pid: 9999 },
    })
    expect(await acquireLock(DB, e)).toMatchObject({ kind: 'acquired', removed: 'orphan' })
    expect(fs.peek(PLK)).toEqual(encodeLocker(OWN, 'linux'))
  })

  type Exists = (pid: number) => boolean | undefined
  it.each<[string, string, Exists]>([
    ['pid still running', SAME_USER_HOST_DEAD, () => true],
    ['pid unknown', SAME_USER_HOST_DEAD, () => undefined],
    ['other host', 'alex@elsewhere:00009999', () => false],
    ['other user', 'sam@studio:00009999', () => false],
  ])('%s → held', async (_n, content, exists) => {
    const fs = diskWith(content, 'linux')
    const e = env(fs, 'linux', { processExists: exists })
    expect((await acquireLock(DB, e)).kind).toBe('held')
    expect(fs.peek(PLK)).toEqual(encodeLocker(content, 'linux'))
  })

  it('orphan on a network volume → held (never auto-removed there)', async () => {
    const fs = diskWith(SAME_USER_HOST_DEAD, 'linux')
    const e = env(fs, 'linux', { processExists: () => false, network: true })
    expect((await acquireLock(DB, e)).kind).toBe('held')
  })

  it('the orphan rule is Linux only', () => {
    const holder = { user: 'alex', host: 'studio', pid: 9999 }
    const base = { identity: ME, processExists: () => false, network: false }
    expect(classifyHolder(holder, { ...base, platform: 'linux' }).state).toBe('removable')
    expect(classifyHolder(holder, { ...base, platform: 'darwin' }).state).toBe('held')
  })
})

describe('win32: v1 never takes a lock (vault opens read-only)', () => {
  it('acquire and probe touch nothing on disk, whatever is there', async () => {
    for (const existing of [undefined, OTHER, OWN]) {
      const fs = diskWith(existing, 'win32')
      const before = fs.snapshot()
      expect(await acquireLock(DB, env(fs, 'win32'))).toEqual({ kind: 'unsupported-platform' })
      expect(await acquireLock(DB, env(fs, 'win32'), { removeExisting: true })).toEqual({
        kind: 'unsupported-platform',
      })
      expect(await probeLock(DB, env(fs, 'win32'))).toEqual({ state: 'unsupported-platform' })
      expect(fs.ops.filter((o) => MUTATING_OPS.has(o.name))).toEqual([])
      expect(fs.snapshot()).toEqual(before)
    }
  })
})

// ── Real file system of the OS running the tests ─────────────────────────────
describe(`real file system (${process.platform})`, () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })
  const platform = (
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  ) as LockPlatform

  it('takes, detects and releases a lock with the native encoding', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wp6-lock-'))
    const db = join(dir, 'real.psafe3')
    writeFileSync(db, 'x')
    const fs = createNodeFileSystem()
    const e: LockEnv = { fs, platform, identity: ME, processExists: () => true, network: false }
    const r = await acquireLock(db, e)
    if (platform === 'win32') {
      expect(r).toEqual({ kind: 'unsupported-platform' })
      expect(existsSync(join(dir, 'real.plk'))).toBe(false)
      return
    }
    if (r.kind !== 'acquired') throw new Error(`not acquired: ${r.kind}`)
    const bytes = new Uint8Array(readFileSync(join(dir, 'real.plk')))
    expect(bytes).toEqual(encodeUtf32le(OWN))
    // A second app instance (other pid) sees it as held.
    const other: LockEnv = { ...e, identity: { ...ME, pid: 1 } }
    expect((await acquireLock(db, other)).kind).toBe('held')
    expect(await releaseLock(fs, r.lock)).toBe(true)
    expect(existsSync(join(dir, 'real.plk'))).toBe(false)
  })

  it('reads a lock written by Password Safe for Windows (UTF-16LE)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wp6-lock-'))
    const db = join(dir, 'w.psafe3')
    writeFileSync(db, 'x')
    writeFileSync(join(dir, 'w.plk'), SHORT_UTF16LE)
    const fs = createNodeFileSystem()
    const e: LockEnv = { fs, platform, identity: ME, processExists: () => true, network: false }
    const p = await probeLock(db, e)
    if (platform === 'win32') expect(p.state).toBe('unsupported-platform')
    else expect(p).toEqual({ state: 'held', holder: { user: 'a', host: 'b', pid: 42 } })
  })
})
