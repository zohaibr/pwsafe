// §A5 crash recovery on a real disk (docs/execution-plan.md §A5 "Recovery on open"). Leftover
// states are made the way a crash makes them: the real save pipeline runs on the real file system
// through a wrapper that kills the "process" before one chosen operation, so the disk is exactly
// what a process killed there leaves. Then a new Vault opens the file: recovery must give the §A5
// result, give it again when run a second time, and give it when recovery itself is killed at
// any of its own steps and rerun. Stray files (.new, .bak-staged with no journal) are planted
// directly. (WP6's unit suite runs the full per-operation matrix on the in-memory file system;
// this file proves the same on real disk for the states that matter.) Not on Windows, where v1
// opens read-only and never recovers or writes (see vault-saves.test.ts).
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodeFileSystem } from '../../src/main/fs'
import { buildEntries } from '../../src/main/psafe3/views'
import { ErrorCode } from '../../src/shared/errors'
import type { Banner } from '../../src/shared/types'
import { expectEntries, unwrap } from './support'
import {
  type FsCall,
  PLATFORM,
  type TempDb,
  WINDOWS,
  crashingFs,
  decodeFile,
  labelDir,
  leftovers,
  ls,
  newVault,
  read,
  removeTemps,
  restoreDir,
  sha,
  snapshotDir,
  tempCopy,
} from './vaultSupport'

afterAll(removeTemps)

const FIXTURE = 'cli-links'
const EDITED = 'Edited before the crash'
const enc = (s: string) => new TextEncoder().encode(s)
/** Stand-ins for older backup generations (rotation only compares hashes). */
const GEN = {
  B1: enc('backup generation one'),
  B2: enc('backup generation two'),
  B3: enc('backup generation three'),
}
const bannerIds = (bs: Banner[]) => bs.map((b) => b.id)

function plant(t: TempDb): void {
  writeFileSync(`${t.db}.bak`, GEN.B1)
  writeFileSync(`${t.db}.bak2`, GEN.B2)
  writeFileSync(`${t.db}.bak3`, GEN.B3)
}

/** Opens the file in a new Vault (running open-time recovery) and returns the vault and state. */
async function openVault(t: TempDb, fs = createNodeFileSystem()) {
  const v = newVault(fs)
  unwrap(await v.open(t.db))
  return { v, state: unwrap(await v.unlock(t.fixture.password)) }
}

interface CrashCase {
  crashBefore: (op: FsCall, t: TempDb) => boolean
  /** What save() returns in the dying process. */
  result: string
  /** Files on disk right after the crash (names with the random tag normalised). */
  crashed: Record<string, string>
  /** After open-time recovery, with the new vault's lock. */
  recovered: Record<string, string>
}

const n = `${FIXTURE}.psafe3`
const NEW = `.${n}.<tag>.new`
const STAGED = `.${n}.<tag>.bak-staged`
const JOURNAL = `.${n}.rotation.json`
const PLK = `${FIXTURE}.plk`
const BAK = `${n}.bak`
const BAK2 = `${n}.bak2`
const BAK3 = `${n}.bak3`
const COMMITTED = { [n]: 'NEW', [BAK]: 'OLD', [BAK2]: 'B1', [BAK3]: 'B2', [PLK]: 'LOCK' }

const isRenameTo = (op: FsCall, name: string) =>
  op.name === 'rename' && op.path2 !== undefined && basename(op.path2) === name

const CASES: Record<string, CrashCase> = {
  'before the commit rename (journal written, database not replaced)': {
    crashBefore: (op) => isRenameTo(op, n),
    result: ErrorCode.SAVE_FAILED,
    crashed: {
      [n]: 'OLD',
      [NEW]: 'NEW',
      [STAGED]: 'OLD',
      [JOURNAL]: 'JOURNAL',
      [BAK]: 'B1',
      [BAK2]: 'B2',
      [BAK3]: 'B3',
      [PLK]: 'LOCK',
    },
    recovered: { [n]: 'OLD', [BAK]: 'B1', [BAK2]: 'B2', [BAK3]: 'B3', [PLK]: 'LOCK' },
  },
  'after the commit, before .bak2 -> .bak3': {
    crashBefore: (op) => isRenameTo(op, BAK3),
    result: ErrorCode.SAVED_DURABILITY_UNCONFIRMED,
    crashed: {
      [n]: 'NEW',
      [STAGED]: 'OLD',
      [JOURNAL]: 'JOURNAL',
      [BAK]: 'B1',
      [BAK2]: 'B2',
      [BAK3]: 'B3',
      [PLK]: 'LOCK',
    },
    recovered: COMMITTED,
  },
  'mid-rotation, before .bak -> .bak2': {
    crashBefore: (op) => isRenameTo(op, BAK2),
    result: ErrorCode.SAVED_DURABILITY_UNCONFIRMED,
    crashed: {
      [n]: 'NEW',
      [STAGED]: 'OLD',
      [JOURNAL]: 'JOURNAL',
      [BAK]: 'B1',
      [BAK3]: 'B2',
      [PLK]: 'LOCK',
    },
    recovered: COMMITTED,
  },
  'mid-rotation, before staged -> .bak': {
    crashBefore: (op) => isRenameTo(op, BAK),
    result: ErrorCode.SAVED_DURABILITY_UNCONFIRMED,
    crashed: {
      [n]: 'NEW',
      [STAGED]: 'OLD',
      [JOURNAL]: 'JOURNAL',
      [BAK2]: 'B1',
      [BAK3]: 'B2',
      [PLK]: 'LOCK',
    },
    recovered: COMMITTED,
  },
  'after every move, before the journal is deleted': {
    crashBefore: (op) => op.name === 'unlink' && basename(op.path) === JOURNAL,
    result: ErrorCode.SAVED_DURABILITY_UNCONFIRMED,
    crashed: { ...COMMITTED, [JOURNAL]: 'JOURNAL' },
    recovered: COMMITTED,
  },
}

/** Recovery's own writes: renames and deletions of anything but the lock file. */
const isRecoveryWrite = (op: FsCall) =>
  (op.name === 'rename' || op.name === 'unlink') && !op.path.endsWith('.plk')

describe.runIf(!WINDOWS)(`§A5 crash recovery on a real disk (${PLATFORM})`, () => {
  it.each(Object.keys(CASES))(
    'save killed %s: open-time recovery gives the §A5 result, idempotently',
    async (name) => {
      const c = CASES[name]!
      const t = tempCopy(FIXTURE)
      plant(t)

      // The dying process: the real pipeline on the real disk, killed before one operation.
      const dying = crashingFs(createNodeFileSystem(), (op) => c.crashBefore(op, t))
      const { v } = await openVault(t, dying.fs)
      const target = unwrap(v.listEntries()).find((e) => e.kind === 'normal')!.uuid
      unwrap(await v.saveEntry({ uuid: target, title: EDITED }))
      const r = await v.save()
      expect(dying.crashed, 'the crash point was reached').toBe(true)
      expect(r.ok ? 'ok' : r.error.code).toBe(c.result)
      // The process is dead: nothing more runs in it (its lock stays behind, as after a kill).

      const newName = ls(t.dir).find((f) => f.endsWith('.new'))
      const labels = {
        OLD: t.original,
        NEW: newName ? read(join(t.dir, newName)) : read(t.db),
        ...GEN,
        LOCK: read(t.plk),
        JOURNAL: read(join(t.dir, JOURNAL)),
      }
      expect(labelDir(t.dir, labels)).toEqual(c.crashed)
      const crashState = snapshotDir(t.dir)
      const committed = c.recovered[n] === 'NEW'

      const expectRecovered = async () => {
        expect(labelDir(t.dir, labels)).toEqual(c.recovered)
        const dec = await decodeFile(t.db, t.fixture.password)
        if (committed) {
          expect(buildEntries(dec.records).find((e) => e.uuid === target)?.title).toBe(EDITED)
        } else {
          expectEntries(dec.records, t.fixture.expected.entries)
        }
      }

      // Recovery, first run: finishes the rotation (or discards the uncommitted save).
      const first = await openVault(t)
      expect(bannerIds(first.state.banners)).toEqual(['recovery'])
      await expectRecovered()
      unwrap(await first.v.close())
      expect(existsSync(t.plk)).toBe(false)
      const final = snapshotDir(t.dir)

      // Second run: nothing left to do, same state.
      const second = await openVault(t)
      expect(second.state.banners).toEqual([])
      await expectRecovered()
      unwrap(await second.v.close())
      expect(snapshotDir(t.dir)).toEqual(final)

      // Recovery killed at each of its own writes, then run again (twice): same final state.
      for (let k = 0; ; k++) {
        restoreDir(t.dir, crashState)
        let writes = 0
        const killed = crashingFs(
          createNodeFileSystem(),
          (op) => isRecoveryWrite(op) && writes++ === k,
        )
        await openVault(t, killed.fs)
        if (!killed.crashed) {
          expect(k, 'recovery made at least one write').toBeGreaterThan(0)
          break
        }
        // Whatever the killed run left, the database is one of the two versions and no backup
        // generation is lost: every content is still under some name.
        const mid = labelDir(t.dir, labels)
        expect([labels.OLD, labels.NEW].map(sha)).toContain(sha(read(t.db)))
        for (const want of new Set(Object.values(c.recovered))) {
          expect(Object.values(mid), `after recovery killed at write ${k}`).toContain(want)
        }
        for (let run = 0; run < 2; run++) {
          const rerun = await openVault(t)
          await expectRecovered()
          unwrap(await rerun.v.close())
          expect(snapshotDir(t.dir), `rerun ${run} after a kill at write ${k}`).toEqual(final)
        }
      }
    },
    60_000,
  )

  it('a leftover .new is deleted at open; the database and backups are untouched', async () => {
    const t = tempCopy(FIXTURE)
    plant(t)
    const stray = join(t.dir, `.${t.name}.0123456789ab.new`)
    writeFileSync(stray, enc('never committed'))
    const labels = { OLD: t.original, ...GEN }

    const first = await openVault(t)
    expect(bannerIds(first.state.banners)).toEqual(['recovery'])
    expect(existsSync(stray)).toBe(false)
    unwrap(await first.v.close())
    const expected = { [n]: 'OLD', [BAK]: 'B1', [BAK2]: 'B2', [BAK3]: 'B3' }
    expect(labelDir(t.dir, labels)).toEqual(expected)

    const second = await openVault(t)
    expect(second.state.banners).toEqual([])
    unwrap(await second.v.close())
    expect(labelDir(t.dir, labels)).toEqual(expected)
  })

  it('a stray .bak-staged equal to the database (crash before the journal) is deleted', async () => {
    const t = tempCopy(FIXTURE)
    const stray = join(t.dir, `.${t.name}.0123456789ab.bak-staged`)
    writeFileSync(stray, t.original)

    const first = await openVault(t)
    expect(bannerIds(first.state.banners)).toEqual(['recovery'])
    unwrap(await first.v.close())
    expect(ls(t.dir)).toEqual([t.name])
    expect(sha(read(t.db))).toBe(sha(t.original))

    const second = await openVault(t)
    expect(second.state.banners).toEqual([])
    unwrap(await second.v.close())
    expect(ls(t.dir)).toEqual([t.name])
  })

  it('a stray .bak-staged that differs from the database is kept and reported, every time', async () => {
    const t = tempCopy(FIXTURE)
    const strayName = `.${t.name}.0123456789ab.bak-staged`
    writeFileSync(join(t.dir, strayName), GEN.B1)
    writeFileSync(`${t.db}.bak`, GEN.B2)
    const before = snapshotDir(t.dir)

    for (let run = 0; run < 2; run++) {
      const { v, state } = await openVault(t)
      expect(bannerIds(state.banners)).toEqual(['backup-unknown'])
      const text = state.banners[0]!.text
      expect(text).toContain(strayName)
      expect(text).toContain(`${t.name}.bak`)
      unwrap(await v.close())
      expect(snapshotDir(t.dir), `run ${run}`).toEqual(before)
    }

    // Saving still works and leaves the unknown file alone.
    const { v } = await openVault(t)
    const target = unwrap(v.listEntries()).find((e) => e.kind === 'normal')!.uuid
    unwrap(await v.saveEntry({ uuid: target, title: EDITED }))
    unwrap(await v.save())
    unwrap(await v.close())
    expect(sha(read(join(t.dir, strayName)))).toBe(sha(GEN.B1))
    expect(sha(read(`${t.db}.bak`))).toBe(sha(t.original))
    expect(sha(read(`${t.db}.bak2`))).toBe(sha(GEN.B2))
    expect(leftovers(t.dir)).toEqual([strayName])
  })
})
