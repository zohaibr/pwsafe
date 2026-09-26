// §A6 through the Vault, for every platform value (injected), including the Windows v1 read-only
// proof that no write path is reachable: save, delete, edit, restore and Save As are all refused
// and the file system sees no mutating operation at all.
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { MemoryFileSystem, MUTATING_OPS } from '../fs/memoryFs'
import { encodeLocker, type LockPlatform } from '../lockfile/encoding'
import {
  assembleModel,
  encodeModel,
  makeVault,
  PASSWORD,
  PID,
  smallModel,
  unwrap,
  uuidHex,
} from './testkit'
import { READ_ONLY_TEXT } from './vault'

const DB = '/v/db.psafe3'
const PLK = '/v/db.plk'
const OTHER_LOCK = 'bob@other-mac:00000077'

async function disk(lock?: { text: string; platform: LockPlatform }) {
  const fs = new MemoryFileSystem()
  fs.setFile(DB, await encodeModel(smallModel()))
  fs.setFile(`${DB}.bak`, await encodeModel(smallModel(), PASSWORD, { seed: 'bak' }))
  if (lock) fs.setFile(PLK, encodeLocker(lock.text, lock.platform))
  return fs
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error!.code)

async function expectNoWritePath(vault: ReturnType<typeof makeVault>, fs: MemoryFileSystem) {
  const before = fs.snapshot()
  const opsBefore = fs.ops.length
  expect(code(await vault.saveEntry({ uuid: uuidHex(3), title: 'x' }))).toBe(ErrorCode.READ_ONLY)
  expect(code(await vault.saveEntry({ title: 'new' }))).toBe(ErrorCode.READ_ONLY)
  expect(code(await vault.deleteEntry(uuidHex(3)))).toBe(ErrorCode.READ_ONLY)
  expect(code(await vault.save())).toBe(ErrorCode.READ_ONLY)
  expect(code(await vault.saveAs('/v/copy.psafe3'))).toBe(ErrorCode.READ_ONLY)
  const backups = unwrap(await vault.listBackups())
  expect(backups).toHaveLength(1)
  unwrap(await vault.previewBackup(backups[0]!.id, PASSWORD))
  expect(code(await vault.restoreBackup(backups[0]!.id))).toBe(ErrorCode.READ_ONLY)
  // Browse, reveal, copy and export still work.
  expect(unwrap(vault.listEntries())).toHaveLength(5)
  expect(unwrap(vault.revealPassword(uuidHex(1)))).toBe('bank-secret')
  expect(unwrap(vault.getFieldForCopy(uuidHex(3), 'email'))).toBe('me@example.com')
  expect(unwrap(vault.getExportData()).records).toHaveLength(5)
  expect(vault.getState().dirtyCount).toBe(0)
  expect(fs.ops.slice(opsBefore).filter((o) => MUTATING_OPS.has(o.name))).toEqual([])
  expect(fs.snapshot()).toEqual(before)
}

describe('win32: v1 opens every vault read-only; no write path is reachable', () => {
  it.each([
    ['no lock', undefined],
    ['a Windows lock', { text: OTHER_LOCK, platform: 'win32' as const }],
    [
      'our own lock',
      { text: `alex@studio:${String(PID).padStart(8, '0')}`, platform: 'win32' as const },
    ],
  ])('with %s', async (_n, lock) => {
    const fs = await disk(lock)
    const vault = makeVault(fs, { platform: 'win32' })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD))
    expect(state.readOnly).toEqual({ reason: 'windows-v1', text: READ_ONLY_TEXT['windows-v1'] })
    await expectNoWritePath(vault, fs)
    unwrap(await vault.lock())
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.close())
    // The whole session never changed the disk.
    expect(fs.ops.filter((o) => MUTATING_OPS.has(o.name))).toEqual([])
  })
})

describe.each(['darwin', 'linux'] as const)('%s', (platform) => {
  it("another app's lock → LOCKED_BY_OTHER (who/where), before any key stretching", async () => {
    const fs = await disk({ text: OTHER_LOCK, platform })
    let stretched = false
    const vault = makeVault(fs, { platform })
    const r = await vault.unlock(PASSWORD)
    expect(code(r)).toBe(ErrorCode.IO_ERROR) // no file chosen yet
    unwrap(await vault.open(DB))
    vault.onStateChanged((s) => (stretched ||= s.status === 'unlocking'))
    const locked = await vault.unlock(PASSWORD)
    expect(locked.ok ? '' : `${locked.error.code} ${locked.error.detail}`).toBe(
      'LOCKED_BY_OTHER bob@other-mac:77',
    )
    expect(stretched).toBe(false)
    expect(fs.peek(PLK)).toEqual(encodeLocker(OTHER_LOCK, platform))
  })

  it('"Open read-only": browse works, every write is refused, the lock is untouched', async () => {
    const fs = await disk({ text: OTHER_LOCK, platform })
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD, { lockChoice: 'read-only' }))
    expect(state.readOnly?.reason).toBe('locked-by-other')
    await expectNoWritePath(vault, fs)
    unwrap(await vault.close())
    expect(fs.peek(PLK)).toEqual(encodeLocker(OTHER_LOCK, platform))
  })

  it('"Remove lock and open…": our lock replaces theirs; editing works; close removes it', async () => {
    const fs = await disk({ text: OTHER_LOCK, platform })
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD, { lockChoice: 'remove-lock' }))
    expect(state.readOnly).toBeUndefined()
    expect(fs.peek(PLK)).toEqual(encodeLocker(`alex@studio:0000${PID}`, platform))
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'x' }))
    unwrap(await vault.save())
    unwrap(await vault.close())
    expect(fs.exists(PLK)).toBe(false)
  })

  it('same user and host, dead pid: macOS keeps it (asks), Linux removes the orphan', async () => {
    const fs = await disk({ text: 'alex@studio:00000999', platform })
    const vault = makeVault(fs, { platform, processExists: () => false })
    unwrap(await vault.open(DB))
    const r = await vault.unlock(PASSWORD)
    if (platform === 'darwin') {
      expect(code(r)).toBe(ErrorCode.LOCKED_BY_OTHER)
      expect(fs.peek(PLK)).toEqual(encodeLocker('alex@studio:00000999', platform))
    } else {
      expect(unwrap(r).readOnly).toBeUndefined()
      expect(fs.peek(PLK)).toEqual(encodeLocker(`alex@studio:0000${PID}`, platform))
    }
  })

  it('our own lock (same pid) is removed silently', async () => {
    const fs = await disk({ text: `alex@studio:0000${PID}`, platform })
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    expect(unwrap(await vault.unlock(PASSWORD)).readOnly).toBeUndefined()
  })

  it("can't create the lock (read-only folder) → read-only with the reason; nothing written", async () => {
    const fs = await disk()
    fs.setFile('/v/.db.psafe3.0123456789ab.new', new Uint8Array([1])) // recovery must not run
    fs.setReadOnlyDir('/v')
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD))
    expect(state.readOnly).toEqual({
      reason: 'lock-not-created',
      text: READ_ONLY_TEXT['lock-not-created'],
    })
    expect(fs.list('/v')).toEqual(['.db.psafe3.0123456789ab.new', 'db.psafe3', 'db.psafe3.bak'])
    await expectNoWritePath(vault, fs)
  })

  it('network volume: banner, and even a Linux orphan lock is not removed', async () => {
    const fs = await disk({ text: 'alex@studio:00000999', platform })
    fs.setFsType('/v', platform === 'linux' ? { magic: 0xff534d42 } : { name: 'smbfs' })
    const vault = makeVault(fs, { platform, processExists: () => false })
    unwrap(await vault.open(DB))
    expect(code(await vault.unlock(PASSWORD))).toBe(ErrorCode.LOCKED_BY_OTHER)
    const state = unwrap(await vault.unlock(PASSWORD, { lockChoice: 'remove-lock' }))
    expect(state.banners.map((b) => b.id)).toEqual(['network'])
    expect(state.banners[0]!.text).toBe(
      'File is on a network drive; make sure no one else has it open.',
    )
  })

  it('a newer-format file opens read-only and never gets a lock', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await assembleModel(smallModel(0x0312)))
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD))
    expect(state.readOnly?.reason).toBe('newer-format')
    expect(fs.list('/v')).toEqual(['db.psafe3'])
    expect(code(await vault.save())).toBe(ErrorCode.READ_ONLY)
    expect(fs.ops.filter((o) => MUTATING_OPS.has(o.name))).toEqual([])
  })

  it('the lock is kept while locked and released on close', async () => {
    const fs = await disk()
    const vault = makeVault(fs, { platform })
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.lock())
    expect(fs.exists(PLK)).toBe(true)
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.close())
    expect(fs.exists(PLK)).toBe(false)
  })
})
