// Vault behaviour: entries, dirty tracking, save and backups, conflicts, §B3 auto-lock, restore,
// open-time recovery. Uses the in-memory file system and a fast key-stretch stand-in.
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { FieldType, type VaultState } from '../../shared/types'
import { buildXmlExport } from '../export/xmlExport'
import { MemoryFileSystem, MUTATING_OPS } from '../fs/memoryFs'
import { decode } from '../psafe3/codec'
import { StretchCancelledError } from '../psafe3/stretch'
import { encodeLocker } from '../lockfile/encoding'
import { encodeJournal, planJournal } from './rotation'
import { sha256Hex, sidecarsFor } from './sidecars'
import {
  encodeModel,
  fastCodec,
  fastStretch,
  makeVault,
  OTHER_PASSWORD,
  PASSWORD,
  smallModel,
  unwrap,
  uuidHex,
} from './testkit'

const DB = '/v/db.psafe3'
const dir = (fs: MemoryFileSystem) => fs.list('/v')

async function setup(options: { backups?: boolean } = {}) {
  const fs = new MemoryFileSystem()
  const original = await encodeModel(smallModel())
  fs.setFile(DB, original)
  if (options.backups) {
    fs.setFile(`${DB}.bak`, new TextEncoder().encode('backup one'))
    fs.setFile(`${DB}.bak2`, new TextEncoder().encode('backup two'))
    fs.setFile(`${DB}.bak3`, new TextEncoder().encode('backup three'))
  }
  const vault = makeVault(fs)
  unwrap(await vault.open(DB))
  unwrap(await vault.unlock(PASSWORD))
  return { fs, vault, original }
}

async function decodeFile(fs: MemoryFileSystem, path = DB, password = PASSWORD) {
  return unwrap(await decode(fs.peek(path)!, password, fastCodec()))
}

describe('open and read', () => {
  it('lists entries without passwords; reveal and copy resolve aliases', async () => {
    const { vault } = await setup()
    const entries = unwrap(vault.listEntries())
    expect(entries.map((e) => e.title)).toEqual(['Bank', 'Card', 'Mail', 'Bank alias', 'Protected'])
    expect(entries.every((e) => e.password === '')).toBe(true)
    expect(unwrap(vault.getEntry(uuidHex(1))).password).toBe('')
    expect(unwrap(vault.revealPassword(uuidHex(1)))).toBe('bank-secret')
    expect(unwrap(vault.revealPassword(uuidHex(4)))).toBe('bank-secret')
    expect(unwrap(vault.getFieldForCopy(uuidHex(4), 'password'))).toBe('bank-secret')
    expect(unwrap(vault.getFieldForCopy(uuidHex(3), 'email'))).toBe('me@example.com')
    expect(unwrap(vault.getFieldForCopy(uuidHex(2), 'url'))).toBe('https://card.example')
    expect(vault.getEntry('nope').ok).toBe(false)
  })

  it('builds the group tree including empty groups from the header', async () => {
    const { vault } = await setup()
    const groups = unwrap(vault.listGroups())
    expect(groups.map((g) => [g.path, g.entryCount])).toEqual([
      ['Archive', 0],
      ['Banking', 2],
    ])
    expect(groups[1]!.children.map((g) => [g.path, g.name, g.entryCount])).toEqual([
      ['Banking.Cards', 'Cards', 1],
    ])
  })

  it('reports state changes to listeners and holds the .plk while open', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const vault = makeVault(fs)
    const seen: VaultState['status'][] = []
    const off = vault.onStateChanged((s) => seen.push(s.status))
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3'])
    expect(fs.peek('/v/db.plk')).toEqual(encodeLocker('alex@studio:00004312', 'linux'))
    unwrap(await vault.close())
    off()
    expect(seen).toEqual(['locked', 'unlocking', 'open', 'no-file'])
    expect(dir(fs)).toEqual(['db.psafe3'])
    expect(vault.getState()).toEqual({ status: 'no-file', dirtyCount: 0, banners: [] })
  })

  it('wrong password: WRONG_PASSWORD, stays locked, no lock file created', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    const r = await vault.unlock(OTHER_PASSWORD)
    expect(r.ok || r.error.code).toBe(ErrorCode.WRONG_PASSWORD)
    expect(vault.getState().status).toBe('locked')
    expect(dir(fs)).toEqual(['db.psafe3'])
  })

  it('an unsupported file is rejected: no lock, no write of any kind', async () => {
    const fs = new MemoryFileSystem()
    const v4 = new Uint8Array(400).fill(7)
    v4.set(new TextEncoder().encode('PWS4'), 0)
    fs.setFile(DB, v4)
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    const r = await vault.unlock(PASSWORD)
    expect(r.ok || r.error.code).toBe(ErrorCode.UNSUPPORTED_FORMAT)
    expect(fs.ops.filter((o) => MUTATING_OPS.has(o.name))).toEqual([])
    expect(fs.peek(DB)).toEqual(v4)
    expect((await vault.save()).ok).toBe(false)
  })

  it('open() of a missing file is an IO_ERROR', async () => {
    const vault = makeVault(new MemoryFileSystem())
    const r = await vault.open('/v/none.psafe3')
    expect(r.ok || r.error.code).toBe(ErrorCode.IO_ERROR)
  })
})

describe('edits and dirty tracking (pending deletes count)', () => {
  it('counts each changed entry once, including deletes', async () => {
    const { vault } = await setup()
    unwrap(await vault.saveEntry({ uuid: uuidHex(2), title: 'Card 2' }))
    unwrap(await vault.saveEntry({ uuid: uuidHex(2), username: 'j2' }))
    expect(vault.getState().dirtyCount).toBe(1)
    // An edit that changes nothing is not a change.
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Mail' }))
    expect(vault.getState().dirtyCount).toBe(1)
    const { uuid } = unwrap(await vault.saveEntry({ title: 'New', password: 'pw' }))
    expect(vault.getState().dirtyCount).toBe(2)
    unwrap(await vault.deleteEntry(uuidHex(3)))
    expect(vault.getState().dirtyCount).toBe(3)
    // Deleting an added entry cancels it; deleting an edited one stays one change.
    unwrap(await vault.deleteEntry(uuid))
    expect(vault.getState().dirtyCount).toBe(2)
    unwrap(await vault.deleteEntry(uuidHex(2)))
    expect(vault.getState().dirtyCount).toBe(2)
    expect(unwrap(vault.listEntries()).map((e) => e.title)).toEqual([
      'Bank',
      'Bank alias',
      'Protected',
    ])
  })

  it('refuses read-only records and bases with dependants', async () => {
    const { vault } = await setup()
    const alias = await vault.saveEntry({ uuid: uuidHex(4), title: 'x' })
    expect(alias.ok || alias.error.code).toBe(ErrorCode.RECORD_READ_ONLY)
    const prot = await vault.deleteEntry(uuidHex(5))
    expect(prot.ok || prot.error.code).toBe(ErrorCode.RECORD_READ_ONLY)
    const base = await vault.deleteEntry(uuidHex(1))
    expect(base.ok ? '' : `${base.error.code} ${base.error.detail}`).toBe(
      'RECORD_READ_ONLY Other entries depend on this one.',
    )
    expect(vault.getState().dirtyCount).toBe(0)
  })

  it('export data carries unsaved edits and feeds buildXmlExport', async () => {
    const { vault } = await setup()
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Mail (edited)' }))
    const data = unwrap(vault.getExportData())
    const out = buildXmlExport({ ...data, scope: { kind: 'all' }, exportedAt: new Date(0) })
    expect(out.entryCount).toBe(5)
    expect(out.xml).toContain('Mail (edited)')
  })
})

describe('save and backups (§A5)', () => {
  it('writes a file that decodes to the model, stamps the header and keeps field order', async () => {
    const { fs, vault, original } = await setup()
    unwrap(await vault.saveEntry({ uuid: uuidHex(2), notes: 'added notes' }))
    const state = unwrap(await vault.save())
    expect(state.dirtyCount).toBe(0)
    const saved = await decodeFile(fs)
    const before = unwrap(await decode(original, PASSWORD, fastCodec()))
    // Records: only the edited record changed; its new field is appended before END.
    expect(saved.records.length).toBe(before.records.length)
    expect(saved.records[0]).toEqual(before.records[0])
    expect(saved.records[1]!.fields.slice(0, 5)).toEqual(before.records[1]!.fields)
    expect(saved.records[1]!.fields.map((f) => f.type)).toContain(FieldType.NOTES)
    // Header: every field kept in place; last-saved user (already present) updated; 0x04/0x06 added.
    expect(saved.header.slice(0, 2)).toEqual(before.header.slice(0, 2))
    expect(new TextDecoder().decode(saved.header[2]!.data)).toBe('alex')
    expect(saved.header.map((f) => f.type)).toEqual([0x00, 0x01, 0x07, 0x11, 0xe7, 0x04, 0x06])
    // The previous file is now .bak, byte for byte; no staged or journal files are left.
    expect(fs.peek(`${DB}.bak`)).toEqual(original)
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3', 'db.psafe3.bak'])
  })

  it('keeps exactly 3 generations, rotating oldest out', async () => {
    const { fs, vault, original } = await setup()
    const versions = [original]
    for (let i = 0; i < 4; i++) {
      unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: `Mail ${i}` }))
      unwrap(await vault.save())
      versions.push(fs.peek(DB)!)
    }
    expect(fs.peek(`${DB}.bak`)).toEqual(versions[3])
    expect(fs.peek(`${DB}.bak2`)).toEqual(versions[2])
    expect(fs.peek(`${DB}.bak3`)).toEqual(versions[1])
    expect(dir(fs)).toEqual([
      'db.plk',
      'db.psafe3',
      'db.psafe3.bak',
      'db.psafe3.bak2',
      'db.psafe3.bak3',
    ])
  })

  it('FILE_CHANGED_ON_DISK at step 1 when another app changed the file; nothing written', async () => {
    const { fs, vault } = await setup({ backups: true })
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Mine' }))
    const theirs = await encodeModel(smallModel(), PASSWORD, { seed: 'theirs' })
    fs.setFile(DB, theirs)
    const before = fs.snapshot()
    const r = await vault.save()
    expect(r.ok || r.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
    expect(fs.snapshot()).toEqual(before)
    expect(vault.getState().dirtyCount).toBe(1)
    // Reload (discard my changes) picks up their version.
    unwrap(await vault.reloadFromDisk())
    expect(vault.getState().dirtyCount).toBe(0)
    unwrap(await vault.save())
    expect(fs.peek(`${DB}.bak`)).toEqual(theirs)
  })

  it('FILE_CHANGED_ON_DISK at step 6 (changed during the save); staged files removed', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    const theirs = new TextEncoder().encode('someone else wrote this')
    const vault = makeVault(fs, {
      onSaveStep: (s) => {
        if (s === 6) fs.setFile(DB, theirs)
      },
    })
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Mine' }))
    const r = await vault.save()
    expect(r.ok || r.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
    expect(fs.peek(DB)).toEqual(theirs)
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3'])
  })

  it('FILE_CHANGED_ON_DISK at step 6 when the opened symlink now points elsewhere', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    fs.setFile('/v/other.psafe3', new TextEncoder().encode('other'))
    fs.setSymlink('/v/link.psafe3', 'db.psafe3')
    const vault = makeVault(fs, {
      onSaveStep: (s) => {
        if (s === 6) fs.setSymlink('/v/link.psafe3', 'other.psafe3')
      },
    })
    unwrap(await vault.open('/v/link.psafe3'))
    expect(vault.getState().fileName).toBe('link.psafe3')
    unwrap(await vault.unlock(PASSWORD))
    const original = fs.peek(DB)
    const r = await vault.save()
    expect(r.ok || r.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
    expect(fs.peek(DB)).toEqual(original)
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3', 'link.psafe3', 'other.psafe3'])
  })

  it('a save of a symlinked file replaces the target, not the link', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    fs.setSymlink('/v/link.psafe3', 'db.psafe3')
    const vault = makeVault(fs)
    unwrap(await vault.open('/v/link.psafe3'))
    unwrap(await vault.unlock(PASSWORD))
    unwrap(await vault.save())
    expect((await fs.lstat('/v/link.psafe3')).isSymbolicLink).toBe(true)
    expect(dir(fs)).toContain('db.psafe3.bak')
  })

  it('refuses to save while locked', async () => {
    const { vault } = await setup()
    unwrap(await vault.lock())
    const r = await vault.save()
    expect(r.ok || r.error.code).toBe(ErrorCode.VAULT_LOCKED)
  })
})

describe('§B3 lock with unsaved changes', () => {
  it('auto-lock re-encrypts in memory, drops plaintext, writes nothing; unlock restores', async () => {
    const { fs, vault } = await setup()
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Unsaved title' }))
    unwrap(await vault.deleteEntry(uuidHex(2)))
    const owned = unwrap(vault.getExportData()).records.flatMap((r) => r.fields.map((f) => f.data))
    const opsBefore = fs.ops.length
    const locked = unwrap(await vault.lock())
    expect(locked).toEqual({ status: 'locked', fileName: 'db.psafe3', dirtyCount: 2, banners: [] })
    expect(fs.ops.slice(opsBefore)).toEqual([])
    // Owned decrypted buffers were zeroed.
    expect(owned.every((b) => b.every((x) => x === 0))).toBe(true)
    expect(vault.listEntries().ok).toBe(false)
    // A wrong password keeps the in-memory changes.
    const bad = await vault.unlock(OTHER_PASSWORD)
    expect(bad.ok || bad.error.code).toBe(ErrorCode.WRONG_PASSWORD)
    const state = unwrap(await vault.unlock(PASSWORD))
    expect(state.dirtyCount).toBe(2)
    expect(unwrap(vault.listEntries()).map((e) => e.title)).toEqual([
      'Bank',
      'Unsaved title',
      'Bank alias',
      'Protected',
    ])
    // Still unsaved until saved; the lock file stayed held throughout.
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3'])
    unwrap(await vault.save())
    expect((await decodeFile(fs)).records).toHaveLength(4)
  })

  it('lock with discardChanges drops edits; unlock reads the file again', async () => {
    const { vault } = await setup()
    unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: 'Unsaved' }))
    expect(unwrap(await vault.lock({ discardChanges: true })).dirtyCount).toBe(0)
    unwrap(await vault.unlock(PASSWORD))
    expect(unwrap(vault.getEntry(uuidHex(3))).title).toBe('Mail')
  })

  it('slow file: progress is reported and Cancel stops the unlock', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel(), PASSWORD, { iterations: 2 ** 21 }))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const codec = {
      ...fastCodec(),
      stretch: async (...args: Parameters<typeof fastStretch>) => {
        args[3]?.onProgress?.(0.25)
        const signal = args[3]?.signal
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new StretchCancelledError('x'))),
          ),
        ])
        return fastStretch(...args)
      },
    }
    const vault = makeVault(fs, { codec })
    const progress: (number | undefined)[] = []
    vault.onStateChanged((s) => s.status === 'unlocking' && progress.push(s.unlockProgress))
    unwrap(await vault.open(DB))
    const pending = vault.unlock(PASSWORD)
    await new Promise((r) => setTimeout(r, 10))
    expect(progress).toEqual([0, 0.25])
    vault.cancelUnlock()
    const r = await pending
    expect(r.ok || r.error.code).toBe(ErrorCode.CANCELLED)
    expect(vault.getState().status).toBe('locked')
    release()
    expect(dir(fs)).toEqual(['db.psafe3'])
  })
})

describe('backups: list, preview (read-only), restore through steps 1–10', () => {
  it('restores a backup made under an older password; the current file becomes .bak', async () => {
    const fs = new MemoryFileSystem()
    const old = smallModel()
    old.records = old.records.slice(0, 2)
    const oldBytes = await encodeModel(old, OTHER_PASSWORD, { seed: 'old' })
    fs.setFile(`${DB}.bak`, oldBytes)
    const current = await encodeModel(smallModel())
    fs.setFile(DB, current)
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    unwrap(await vault.unlock(PASSWORD))
    const list = unwrap(await vault.listBackups())
    expect(list.map((b) => [b.generation, b.sizeBytes])).toEqual([[1, oldBytes.length]])
    const wrong = await vault.previewBackup(list[0]!.id, PASSWORD)
    expect(wrong.ok || wrong.error.code).toBe(ErrorCode.WRONG_PASSWORD)
    const preview = unwrap(await vault.previewBackup(list[0]!.id, OTHER_PASSWORD))
    expect(preview.map((e) => [e.title, e.editable, e.password])).toEqual([
      ['Bank', false, ''],
      ['Card', false, ''],
    ])
    const opsAfterPreview = fs.ops.filter((o) => MUTATING_OPS.has(o.name))
    expect(opsAfterPreview.filter((o) => o.label.includes('db.psafe3'))).toEqual([])
    unwrap(await vault.restoreBackup(list[0]!.id))
    expect(unwrap(vault.listEntries()).map((e) => e.title)).toEqual(['Bank', 'Card'])
    expect(fs.peek(`${DB}.bak`)).toEqual(current)
    expect(fs.peek(`${DB}.bak2`)).toEqual(oldBytes)
    expect((await decodeFile(fs, DB, OTHER_PASSWORD)).records).toHaveLength(2)
    // The vault now uses the restored file's password.
    unwrap(await vault.lock())
    expect((await vault.unlock(PASSWORD)).ok).toBe(false)
    unwrap(await vault.unlock(OTHER_PASSWORD))
  })

  it('restore needs a preview of that backup first', async () => {
    const { vault } = await setup({ backups: true })
    const list = unwrap(await vault.listBackups())
    expect(list).toHaveLength(3)
    const r = await vault.restoreBackup(list[0]!.id)
    expect(r.ok || r.error.code).toBe(ErrorCode.INVALID_ARGUMENT)
    // A non-psafe3 backup (from Save As over another file) cannot be previewed.
    const p = await vault.previewBackup(list[0]!.id, PASSWORD)
    expect(p.ok || p.error.code).toBe(ErrorCode.CORRUPT_FILE)
  })
})

describe('open-time recovery (§A5)', () => {
  async function openWith(prepare: (fs: MemoryFileSystem, bytes: Uint8Array) => void) {
    const fs = new MemoryFileSystem()
    const bytes = await encodeModel(smallModel())
    fs.setFile(DB, bytes)
    prepare(fs, bytes)
    const log: string[] = []
    const vault = makeVault(fs, { log: (m) => log.push(m) })
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD))
    return { fs, vault, state, log, bytes }
  }

  it('deletes leftover .new files and a staged copy equal to the database', async () => {
    const { fs, state, log } = await openWith((fs, bytes) => {
      fs.setFile('/v/.db.psafe3.0123456789ab.new', new Uint8Array([1, 2]))
      fs.setFile('/v/.db.psafe3.aaaaaaaaaaaa.bak-staged', bytes)
      fs.setFile('/v/.other.psafe3.0123456789ab.new', new Uint8Array([3]))
    })
    expect(dir(fs)).toEqual(['.other.psafe3.0123456789ab.new', 'db.plk', 'db.psafe3'])
    expect(state.banners.map((b) => b.id)).toEqual(['recovery'])
    expect(log.some((l) => l.startsWith('recovery: removed unfinished save file'))).toBe(true)
  })

  it('keeps and reports a staged copy that differs from the database', async () => {
    const { fs, state } = await openWith((fs) => {
      fs.setFile('/v/.db.psafe3.aaaaaaaaaaaa.bak-staged', new Uint8Array([9]))
    })
    expect(dir(fs)).toContain('.db.psafe3.aaaaaaaaaaaa.bak-staged')
    const b = state.banners.find((x) => x.id === 'backup-unknown')!
    expect(b.kind).toBe('warning')
    expect(b.text).toContain('.db.psafe3.aaaaaaaaaaaa.bak-staged')
  })

  it('unknown state: the database matches neither side of the journal → nothing moved', async () => {
    const sc = sidecarsFor(MemoryFileSystem.norm(DB))
    const b1 = new TextEncoder().encode('b1')
    const { fs, state, vault } = await openWith((fs) => {
      fs.setFile(`${DB}.bak`, b1)
      fs.setFile('/v/.db.psafe3.aaaaaaaaaaaa.bak-staged', new Uint8Array([5]))
      const j = planJournal(sc, 'aaaaaaaaaaaa', {
        h1: sha256Hex(b1),
        hOld: sha256Hex(new Uint8Array([5])),
        hNew: sha256Hex(new Uint8Array([6])),
      })
      fs.setFile(sc.journal, encodeJournal(j))
    })
    expect(dir(fs)).toEqual([
      '.db.psafe3.aaaaaaaaaaaa.bak-staged',
      '.db.psafe3.rotation.json',
      'db.plk',
      'db.psafe3',
      'db.psafe3.bak',
    ])
    expect(fs.peek(`${DB}.bak`)).toEqual(b1)
    expect(state.banners.find((x) => x.id === 'backup-unknown')!.text).toContain(
      'Files: .db.psafe3.aaaaaaaaaaaa.bak-staged, .db.psafe3.rotation.json, db.psafe3.bak.',
    )
    // A save is refused while the earlier rotation is unresolved, and changes nothing.
    const before = fs.snapshot()
    const r = await vault.save()
    expect(r.ok ? '' : `${r.error.code} ${r.error.detail}`).toMatch(/^SAVE_FAILED Step 1: backups/)
    expect(fs.snapshot()).toEqual(before)
  })

  it('a journal naming files outside this database is ignored and removed', async () => {
    const { fs } = await openWith((fs) => {
      fs.setFile(
        '/v/.db.psafe3.rotation.json',
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            db: 'db.psafe3',
            tag: 'aaaaaaaaaaaa',
            hOld: 'a'.repeat(64),
            hNew: 'b'.repeat(64),
            moves: [{ from: '../../etc/passwd', to: 'db.psafe3.bak', expect: 'c'.repeat(64) }],
          }),
        ),
      )
    })
    expect(dir(fs)).toEqual(['db.plk', 'db.psafe3'])
  })

  it('no recovery for a vault opened read-only (it never writes)', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile(DB, await encodeModel(smallModel()))
    fs.setFile('/v/.db.psafe3.0123456789ab.new', new Uint8Array([1]))
    fs.setFile('/v/db.plk', encodeLocker('bob@else:00000001', 'linux'))
    const vault = makeVault(fs)
    unwrap(await vault.open(DB))
    const state = unwrap(await vault.unlock(PASSWORD, { lockChoice: 'read-only' }))
    expect(state.readOnly?.reason).toBe('locked-by-other')
    expect(dir(fs)).toEqual(['.db.psafe3.0123456789ab.new', 'db.plk', 'db.psafe3'])
  })
})
