// §A5 Save As table, one test per row, plus the success and failure rules under the table.
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { MemoryFileSystem, MUTATING_OPS } from '../fs/memoryFs'
import { decode } from '../psafe3/codec'
import { encodeLocker } from '../lockfile/encoding'
import {
  encodeModel,
  fastCodec,
  makeVault,
  PASSWORD,
  PID,
  smallModel,
  unwrap,
  uuidHex,
} from './testkit'
import { LOCKED_DESTINATION_TEXT } from './vault'

const DB = '/v/db.psafe3'
const OUR_LOCK = encodeLocker(`alex@studio:0000${PID}`, 'linux')
const enc = (s: string) => new TextEncoder().encode(s)

async function setup() {
  const fs = new MemoryFileSystem()
  const original = await encodeModel(smallModel())
  fs.setFile(DB, original)
  fs.mkdirp('/w')
  const vault = makeVault(fs)
  unwrap(await vault.open(DB))
  unwrap(await vault.unlock(PASSWORD))
  unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Edited' }))
  return { fs, vault, original }
}

async function titleIn(fs: MemoryFileSystem, path: string): Promise<string[]> {
  const d = unwrap(await decode(fs.peek(path)!, PASSWORD, fastCodec()))
  return d.records.map((r) => new TextDecoder().decode(r.fields.find((f) => f.type === 3)!.data))
}

const code = (r: { ok: boolean; error?: { code: string; message: string } }) =>
  r.ok ? 'ok' : r.error!.code

describe('§A5 Save As', () => {
  it('same as the active file → a normal Save (steps 1–10, backups rotate)', async () => {
    const { fs, vault, original } = await setup()
    unwrap(await vault.saveAs('/v/./db.psafe3'))
    expect(fs.peek(`${DB}.bak`)).toEqual(original)
    expect(vault.getState().fileName).toBe('db.psafe3')
    expect(vault.getState().dirtyCount).toBe(0)
  })

  it('same file through a symlink → a normal Save', async () => {
    const { fs, vault, original } = await setup()
    fs.setSymlink('/w/alias.psafe3', '../v/db.psafe3')
    unwrap(await vault.saveAs('/w/alias.psafe3'))
    expect(fs.peek(`${DB}.bak`)).toEqual(original)
    expect(vault.getState().fileName).toBe('db.psafe3')
  })

  it('new path → lock taken first, written via .new + link; destination becomes active', async () => {
    const { fs, vault, original } = await setup()
    const state = unwrap(await vault.saveAs('/w/copy.psafe3'))
    expect(state.fileName).toBe('copy.psafe3')
    expect(state.dirtyCount).toBe(0)
    expect(await titleIn(fs, '/w/copy.psafe3')).toContain('Edited')
    // No backups yet at the destination; the old file is untouched and its lock released.
    expect(fs.list('/w')).toEqual(['copy.plk', 'copy.psafe3'])
    expect(fs.peek('/w/copy.plk')).toEqual(OUR_LOCK)
    expect(fs.list('/v')).toEqual(['db.psafe3'])
    expect(fs.peek(DB)).toEqual(original)
    // The lock was created before anything else was written at the destination.
    const firstWrite = fs.ops.find(
      (o) => MUTATING_OPS.has(o.name) && o.path.startsWith(MemoryFileSystem.norm('/w')),
    )
    expect(firstWrite?.label).toBe('createExclusive:copy.plk')
    // The first later Save creates .bak.
    const copied = fs.peek('/w/copy.psafe3')
    unwrap(await vault.saveEntry({ uuid: uuidHex(2), title: 'Later' }))
    unwrap(await vault.save())
    expect(fs.peek('/w/copy.psafe3.bak')).toEqual(copied)
    unwrap(await vault.close())
    expect(fs.list('/w')).toEqual(['copy.psafe3', 'copy.psafe3.bak'])
  })

  it('new path: a file appearing before the link is never clobbered (FILE_CHANGED_ON_DISK)', async () => {
    const { fs, vault } = await setup()
    const theirs = enc('created by someone else meanwhile')
    fs.onOp = (op) => {
      if (op.name === 'link') fs.setFile('/w/copy.psafe3', theirs)
      return undefined
    }
    const r = await vault.saveAs('/w/copy.psafe3')
    expect(code(r)).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
    expect(fs.peek('/w/copy.psafe3')).toEqual(theirs)
    expect(fs.list('/w')).toEqual(['copy.psafe3']) // .new and our lock removed
    expect(vault.getState().fileName).toBe('db.psafe3')
    expect(vault.getState().dirtyCount).toBe(1)
    expect(fs.peek('/v/db.plk')).toEqual(OUR_LOCK)
  })

  it('new path on a volume without hard links: falls back to check + rename', async () => {
    const { fs, vault } = await setup()
    fs.onOp = (op) => (op.name === 'link' ? { kind: 'fail', code: 'EPERM' } : undefined)
    unwrap(await vault.saveAs('/w/copy.psafe3'))
    expect(fs.list('/w')).toEqual(['copy.plk', 'copy.psafe3'])
    expect(await titleIn(fs, '/w/copy.psafe3')).toContain('Edited')
  })

  it('existing file, not locked → full steps 1–10: it becomes its own .bak, its backups rotate', async () => {
    const { fs, vault, original } = await setup()
    const notPsafe = enc('this is not a psafe3 file, but the backup keeps it')
    const oldBak = enc('the destination had a backup already')
    fs.setFile('/w/existing.dat', notPsafe)
    fs.setFile('/w/existing.dat.bak', oldBak)
    const state = unwrap(await vault.saveAs('/w/existing.dat'))
    expect(state.fileName).toBe('existing.dat')
    expect(await titleIn(fs, '/w/existing.dat')).toContain('Edited')
    expect(fs.peek('/w/existing.dat.bak')).toEqual(notPsafe)
    expect(fs.peek('/w/existing.dat.bak2')).toEqual(oldBak)
    expect(fs.list('/w')).toEqual([
      'existing.dat',
      'existing.dat.bak',
      'existing.dat.bak2',
      'existing.plk',
    ])
    expect(fs.list('/v')).toEqual(['db.psafe3'])
    expect(fs.peek(DB)).toEqual(original)
  })

  it('existing file with a .plk (open in another app) → refused, nothing written', async () => {
    const { fs, vault } = await setup()
    fs.setFile('/w/theirs.psafe3', enc('theirs'))
    fs.setFile('/w/theirs.plk', encodeLocker('bob@other:00000077', 'darwin'))
    const before = fs.snapshot()
    const opsBefore = fs.ops.length
    const r = await vault.saveAs('/w/theirs.psafe3')
    expect(r.ok ? '' : `${r.error.code} ${r.error.message}`).toBe(
      `LOCKED_BY_OTHER ${LOCKED_DESTINATION_TEXT}`,
    )
    expect(fs.snapshot()).toEqual(before)
    const writes = fs.ops.slice(opsBefore).filter((o) => MUTATING_OPS.has(o.name))
    expect(writes.map((o) => o.label)).toEqual(['createExclusive:theirs.plk'])
    expect(vault.getState().fileName).toBe('db.psafe3')
  })

  it('a destination lock that looks like a Linux orphan is still refused (never auto-removed)', async () => {
    const { fs, vault } = await setup()
    fs.setFile('/w/x.psafe3', enc('x'))
    fs.setFile('/w/x.plk', encodeLocker('alex@studio:00000001', 'linux'))
    expect(code(await vault.saveAs('/w/x.psafe3'))).toBe(ErrorCode.LOCKED_BY_OTHER)
    expect(fs.peek('/w/x.plk')).toEqual(encodeLocker('alex@studio:00000001', 'linux'))
  })

  it('another file open in this app (shares our .plk) → refused the same way', async () => {
    const { fs, vault } = await setup()
    fs.setFile('/v/db.dat', enc('a different file with the same lock name'))
    const before = fs.snapshot()
    const r = await vault.saveAs('/v/db.dat')
    expect(code(r)).toBe(ErrorCode.LOCKED_BY_OTHER)
    expect(fs.snapshot()).toEqual(before)
  })

  it('failure → the destination lock is released and the active file stays the old one', async () => {
    const { fs, vault } = await setup()
    fs.onOp = (op) =>
      op.name === 'write' && op.path.endsWith('.new') ? { kind: 'fail', code: 'ENOSPC' } : undefined
    const r = await vault.saveAs('/w/copy.psafe3')
    expect(r.ok ? '' : `${r.error.code} ${r.error.detail}`).toBe(
      'SAVE_FAILED Step 3: the disk is full.',
    )
    expect(fs.list('/w')).toEqual([])
    expect(vault.getState()).toMatchObject({ fileName: 'db.psafe3', dirtyCount: 1 })
    expect(fs.peek('/v/db.plk')).toEqual(OUR_LOCK)
    // Saving to the old file still works.
    fs.onOp = undefined
    unwrap(await vault.save())
  })

  it("the destination folder doesn't allow a lock → SAVE_FAILED, nothing written", async () => {
    const { fs, vault } = await setup()
    fs.setReadOnlyDir('/w')
    const r = await vault.saveAs('/w/copy.psafe3')
    expect(code(r)).toBe(ErrorCode.SAVE_FAILED)
    expect(fs.list('/w')).toEqual([])
  })
})
