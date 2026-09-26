// §A5 conflict handling end to end on a real disk (docs/execution-plan.md §A5 steps 1 and 6, Save
// As): the database is changed behind the vault's back, save returns FILE_CHANGED_ON_DISK and
// nothing on disk changes (no staged, journal or .new file left, the changed file untouched); Save
// As to a new path then works, and the new path becomes the active file (its lock, its backups).
// Not on Windows, where v1 never writes (see vault-saves.test.ts).
import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEntries } from '../../src/main/psafe3/views'
import { ErrorCode } from '../../src/shared/errors'
import { unwrap } from './support'
import {
  PLATFORM,
  WINDOWS,
  type TempDb,
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

const bigStat = (p: string) => statSync(p, { bigint: true })
/** Whole seconds, so a copy can be given exactly the same mtime on every file system. */
const MTIME = 1_750_000_000

/** Ways another app can change the file while we have it open, and the step that notices. */
const TAMPER: Record<string, { step: number; apply: (t: TempDb) => void }> = {
  'content rewritten in place (same inode)': {
    step: 1,
    apply: (t) => {
      const ino = bigStat(t.db).ino
      const b = read(t.db)
      b[b.length - 1]! ^= 0x01
      writeFileSync(t.db, b)
      expect(bigStat(t.db).ino).toBe(ino)
    },
  },
  'only the modification time changed': {
    step: 1,
    apply: (t) => {
      utimesSync(t.db, MTIME, MTIME + 5)
    },
  },
  // Same bytes and the same mtime, so only step 6's device + inode comparison can catch it.
  'replaced by rename with identical bytes and mtime (different inode)': {
    step: 6,
    apply: (t) => {
      const before = bigStat(t.db)
      const tmp = join(t.dir, 'replacement.tmp')
      writeFileSync(tmp, read(t.db))
      utimesSync(tmp, MTIME, MTIME)
      renameSync(tmp, t.db)
      const after = bigStat(t.db)
      expect(after.ino).not.toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.size).toBe(before.size)
    },
  },
}

describe.runIf(!WINDOWS)(`§A5 file changed on disk (${PLATFORM})`, () => {
  it.each(Object.keys(TAMPER))(
    '%s: save refuses with FILE_CHANGED_ON_DISK, then Save As to a new path takes over',
    async (how) => {
      const t = tempCopy('cli-add')
      utimesSync(t.db, MTIME, MTIME)
      const pw = t.fixture.password
      const steps: number[] = []
      const v = newVault(undefined, { onSaveStep: (n) => steps.push(n) })
      unwrap(await v.open(t.db))
      unwrap(await v.unlock(pw))
      const state: EditState = {}
      const { title } = await editRound(v, 1, state)
      const intended = copyRecords(unwrap(v.getExportData()).records)

      TAMPER[how]!.apply(t)
      const before = hashesOf(t.dir)
      const statBefore = bigStat(t.db)

      const r = await v.save()
      expect(r.ok ? 'ok' : r.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
      expect(steps.at(-1), 'the step that noticed').toBe(TAMPER[how]!.step)
      // Nothing on disk changed: same files, same content, same inode and times.
      expect(hashesOf(t.dir)).toEqual(before)
      const statAfter = bigStat(t.db)
      expect([statAfter.ino, statAfter.mtimeMs, statAfter.size]).toEqual([
        statBefore.ino,
        statBefore.mtimeMs,
        statBefore.size,
      ])
      expect(leftovers(t.dir)).toEqual([])
      // The changes are still in memory, unsaved.
      expect(v.getState().dirtyCount).toBe(3)
      // Saving again does not suddenly succeed.
      const again = await v.save()
      expect(again.ok ? 'ok' : again.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
      expect(hashesOf(t.dir)).toEqual(before)

      // Save As to a new path: written, verified, and it becomes the active file.
      const dest = join(t.dir, 'saved-as.psafe3')
      const s = unwrap(await v.saveAs(dest))
      expect(s.fileName).toBe('saved-as.psafe3')
      expect(s.dirtyCount).toBe(0)
      expect(existsSync(join(t.dir, 'saved-as.plk'))).toBe(true)
      expect(existsSync(t.plk)).toBe(false)
      const firstSaveAs = read(dest)
      expectSameRecords((await decodeFile(dest, pw)).records, intended)
      // The changed file is left exactly as the other app wrote it; no backups for a new path.
      expect(sha(read(t.db))).toBe(before[t.name])
      expect(ls(t.dir)).toEqual(['saved-as.plk', 'saved-as.psafe3', t.name].sort())

      // The next save goes to the new path and rotates its own backup.
      const round2 = await editRound(v, 2, state)
      const intended2 = copyRecords(unwrap(v.getExportData()).records)
      unwrap(await v.save())
      const dec = await decodeFile(dest, pw)
      expectSameRecords(dec.records, intended2)
      expect(buildEntries(dec.records).find((e) => e.uuid === state.target)?.title).toBe(
        round2.title,
      )
      expect(sha(read(`${dest}.bak`))).toBe(sha(firstSaveAs))
      expect(
        buildEntries((await decodeFile(`${dest}.bak`, pw)).records).find(
          (e) => e.uuid === state.target,
        )?.title,
      ).toBe(title)
      expect(sha(read(t.db))).toBe(before[t.name])
      expect(leftovers(t.dir)).toEqual([])

      unwrap(await v.close())
      expect(ls(t.dir)).toEqual(['saved-as.psafe3', 'saved-as.psafe3.bak', t.name].sort())
    },
    60_000,
  )

  it('opened through a symlink that is then pointed elsewhere: step 6 refuses, nothing written', async () => {
    const t = tempCopy('cli-add')
    const pw = t.fixture.password
    const other = join(t.dir, 'other.psafe3')
    copyFileSync(t.db, other)
    const link = join(t.dir, 'link.psafe3')
    symlinkSync(t.db, link)
    const steps: number[] = []
    const v = newVault(undefined, { onSaveStep: (n) => steps.push(n) })
    unwrap(await v.open(link))
    unwrap(await v.unlock(pw))
    // The lock is taken next to the real file (the symlink is resolved at open).
    expect(existsSync(t.plk)).toBe(true)
    await editRound(v, 1, {})

    rmSync(link)
    symlinkSync(other, link)
    const before = hashesOf(t.dir)
    const r = await v.save()
    expect(r.ok ? 'ok' : r.error.code).toBe(ErrorCode.FILE_CHANGED_ON_DISK)
    expect(steps.at(-1)).toBe(6)
    expect(hashesOf(t.dir)).toEqual(before)
    expect(leftovers(t.dir)).toEqual([])
    expect(v.getState().dirtyCount).toBe(3)
    unwrap(await v.close())
    expect(existsSync(t.plk)).toBe(false)
  })
})
