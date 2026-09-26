// §A5 end to end on the real file system, through the Vault service (docs/execution-plan.md §A5,
// WP8): every committed fixture is copied to a temp folder, edited and saved four times; after
// each save the database decodes to exactly what the vault held, `.bak`, `.bak2` and `.bak3` hold
// the previous three versions in order (each decoded and compared), no `.new`, `.bak-staged` or
// journal file is left, and the `.plk` exists while open and is gone after close. Restore from
// backup goes through the same pipeline. On Windows, v1 opens every vault read-only (§A6), so the
// same files prove that every write path is refused and nothing on disk changes.
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEntries } from '../../src/main/psafe3/views'
import { ErrorCode } from '../../src/shared/errors'
import type { RawRecord } from '../../src/shared/types'
import { FIXTURE_NAMES, expectEntries, unwrap } from './support'
import {
  PLATFORM,
  WINDOWS,
  copyRecords,
  decodeFile,
  editRound,
  type EditState,
  expectSameRecords,
  hashesOf,
  leftovers,
  ls,
  newVault,
  read,
  removeTemps,
  sha,
  tempCopy,
} from './vaultSupport'

afterAll(removeTemps)

const SAVES = 4
const backupName = (name: string, gen: number) => (gen === 1 ? `${name}.bak` : `${name}.bak${gen}`)

describe.runIf(!WINDOWS)(`§A5 saves and backup rotation on a real disk (${PLATFORM})`, () => {
  it.each(FIXTURE_NAMES)(
    '%s: four saves keep the previous three versions as .bak, .bak2, .bak3',
    async (name) => {
      const t = tempCopy(name)
      const pw = t.fixture.password
      const plkName = `${name}.plk`
      const v = newVault()
      unwrap(await v.open(t.db))
      const opened = unwrap(await v.unlock(pw))
      expect(opened.readOnly).toBeUndefined()
      expect(opened.banners).toEqual([])
      expect(existsSync(t.plk)).toBe(true)
      expect(ls(t.dir)).toEqual([plkName, t.name].sort())

      const versions: { bytes: Uint8Array; records: RawRecord[] }[] = [
        { bytes: t.original, records: copyRecords(unwrap(v.getExportData()).records) },
      ]
      const state: EditState = {}
      for (let round = 1; round <= SAVES; round++) {
        const { title, deleted, added } = await editRound(v, round, state)
        const intended = copyRecords(unwrap(v.getExportData()).records)
        const saved = unwrap(await v.save())
        expect(saved.dirtyCount).toBe(0)
        expect(saved.banners).toEqual([])

        // The database decodes to exactly the records the vault held, with this round's edits.
        const bytes = read(t.db)
        const dec = await decodeFile(t.db, pw)
        expectSameRecords(dec.records, intended)
        const entries = buildEntries(dec.records)
        expect(entries.find((e) => e.uuid === state.target)?.title).toBe(title)
        expect(entries.some((e) => e.uuid === deleted)).toBe(false)
        expect(entries.find((e) => e.uuid === added)?.title).toBe(`Added in save ${round}`)
        versions.push({ bytes, records: intended })

        // .bak, .bak2, .bak3 are the three versions before this one, newest first.
        for (let gen = 1; gen <= 3; gen++) {
          const path = join(t.dir, backupName(t.name, gen))
          const want = versions[versions.length - 1 - gen]
          if (!want) {
            expect(existsSync(path), backupName(t.name, gen)).toBe(false)
            continue
          }
          expect(sha(read(path)), `${backupName(t.name, gen)} after save ${round}`).toBe(
            sha(want.bytes),
          )
          const b = await decodeFile(path, pw)
          expectSameRecords(b.records, want.records)
          // The original generation still decodes to the fixture's expected values.
          if (want.bytes === t.original) expectEntries(b.records, t.fixture.expected.entries)
        }
        expect(leftovers(t.dir)).toEqual([])
        const gens = Math.min(round, 3)
        expect(ls(t.dir)).toEqual(
          [
            plkName,
            t.name,
            ...Array.from({ length: gens }, (_, i) => backupName(t.name, i + 1)),
          ].sort(),
        )
      }

      // After four saves the oldest version (the fixture itself) has rotated out.
      expect(Object.values(hashesOf(t.dir))).not.toContain(sha(t.original))
      unwrap(await v.close())
      expect(existsSync(t.plk)).toBe(false)
      expect(ls(t.dir)).toEqual(
        [t.name, `${name}.psafe3.bak`, `${name}.psafe3.bak2`, `${name}.psafe3.bak3`].sort(),
      )

      // A fresh vault opens the last save cleanly: no recovery needed, same records.
      const again = newVault()
      unwrap(await again.open(t.db))
      expect(unwrap(await again.unlock(pw)).banners).toEqual([])
      expectSameRecords(unwrap(again.getExportData()).records, versions[SAVES]!.records)
      unwrap(await again.close())
      expect(existsSync(t.plk)).toBe(false)
    },
    60_000,
  )

  it('cli-add: restore from backup replaces the file through the pipeline; the replaced version becomes .bak', async () => {
    const t = tempCopy('cli-add')
    const pw = t.fixture.password
    const v = newVault()
    unwrap(await v.open(t.db))
    unwrap(await v.unlock(pw))
    const original = copyRecords(unwrap(v.getExportData()).records)
    const state: EditState = {}
    const saved: Uint8Array[] = [t.original]
    for (let round = 1; round <= 2; round++) {
      await editRound(v, round, state)
      unwrap(await v.save())
      saved.push(read(t.db))
    }

    const backups = unwrap(await v.listBackups())
    expect(backups.map((b) => b.generation)).toEqual([1, 2])
    const oldest = backups[1]!
    const preview = unwrap(await v.previewBackup(oldest.id, pw))
    expect(preview).toHaveLength(t.fixture.expected.entryCount)
    expect(preview.every((e) => !e.editable && e.password === '')).toBe(true)
    // Previewing writes nothing.
    expect(leftovers(t.dir)).toEqual([])
    expect(sha(read(t.db))).toBe(sha(saved[2]!))

    const restored = unwrap(await v.restoreBackup(oldest.id))
    expect(restored.dirtyCount).toBe(0)
    expect(restored.banners).toEqual([])
    // The file now holds the original records (header re-stamped by the save) ...
    const dec = await decodeFile(t.db, pw)
    expectSameRecords(dec.records, original)
    expectEntries(dec.records, t.fixture.expected.entries)
    expectSameRecords(unwrap(v.getExportData()).records, original)
    // ... and nothing was lost: the replaced version is .bak, then the older ones.
    expect(sha(read(`${t.db}.bak`))).toBe(sha(saved[2]!))
    expect(sha(read(`${t.db}.bak2`))).toBe(sha(saved[1]!))
    expect(sha(read(`${t.db}.bak3`))).toBe(sha(saved[0]!))
    expect(leftovers(t.dir)).toEqual([])
    unwrap(await v.close())
    expect(existsSync(t.plk)).toBe(false)

    // Reopened in a fresh vault: the restored version, with the edited entry back as it was.
    const again = newVault()
    unwrap(await again.open(t.db))
    unwrap(await again.unlock(pw))
    const target = t.fixture.expected.entries.find((e) => e.uuid === state.target)!
    expect(unwrap(again.getEntry(state.target!)).title).toBe(target.title)
    unwrap(await again.close())
  }, 60_000)
  // BUG (src/main/vault/commit.ts writeNewFile / src/main/fs/nodeFs.ts createExclusive): §A5 step 3
  // creates `.new` "with db's permission bits", but open(2) applies the process umask to the mode,
  // so a 0660 database comes back 0640 after a save under the usual umask 022 (a group-shared
  // vault loses group write). The staged backup keeps 0660 because copyFile keeps the mode.
  it.fails('a save keeps the database permission bits (0660) whatever the umask', async () => {
    const t = tempCopy('cli-links')
    chmodSync(t.db, 0o660)
    const old = process.umask(0o022)
    try {
      const v = newVault()
      unwrap(await v.open(t.db))
      unwrap(await v.unlock(t.fixture.password))
      await editRound(v, 1, {})
      unwrap(await v.save())
      unwrap(await v.close())
      expect((statSync(`${t.db}.bak`).mode & 0o777).toString(8)).toBe('660')
      expect((statSync(t.db).mode & 0o777).toString(8)).toBe('660')
    } finally {
      process.umask(old)
    }
  })
})

describe.runIf(WINDOWS)(
  '§A5 on Windows v1: every vault opens read-only; no write path runs',
  () => {
    it.each(FIXTURE_NAMES)(
      '%s: save, edit, delete, Save As and restore are refused and nothing on disk changes',
      async (name) => {
        const t = tempCopy(name)
        const pw = t.fixture.password
        // A backup to preview and a leftover .new that recovery would delete on a writable open.
        writeFileSync(`${t.db}.bak`, t.original)
        writeFileSync(join(t.dir, `.${t.name}.0123456789ab.new`), 'left over')
        const before = hashesOf(t.dir)

        const v = newVault()
        unwrap(await v.open(t.db))
        const state = unwrap(await v.unlock(pw))
        expect(state.readOnly?.reason).toBe('windows-v1')
        expect(existsSync(t.plk)).toBe(false)

        const refused = (r: { ok: boolean; error?: { code: string } }) =>
          expect(r.ok ? 'ok' : r.error!.code).toBe(ErrorCode.READ_ONLY)
        const entry = unwrap(v.listEntries())[0]!
        refused(await v.saveEntry({ uuid: entry.uuid, title: 'nope' }))
        refused(await v.saveEntry({ title: 'nope', password: 'x' }))
        refused(await v.deleteEntry(entry.uuid))
        refused(await v.save())
        const dest = join(t.dir, 'copy.psafe3')
        refused(await v.saveAs(dest))
        expect(existsSync(dest)).toBe(false)
        const backups = unwrap(await v.listBackups())
        expect(backups.map((b) => b.generation)).toEqual([1])
        unwrap(await v.previewBackup(backups[0]!.id, pw))
        refused(await v.restoreBackup(backups[0]!.id))
        expect(v.getState().dirtyCount).toBe(0)

        unwrap(await v.close())
        expect(hashesOf(t.dir)).toEqual(before)
        expect(sha(read(t.db))).toBe(sha(t.original))
      },
      60_000,
    )
  },
)
