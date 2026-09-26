// §A5 fault-injection suite. A baseline save records every file-system operation of steps 1–10.
// Then, for every single operation, the same save is repeated with (a) an injected I/O failure and
// (b) a simulated process death at that operation (and, for writes, (c) a torn write followed by
// death). Each case asserts the exact files on disk and the content of the database and of every
// backup generation, then runs open-time recovery through a new Vault, runs it a second time, and
// also kills recovery at each of its own operations and reruns it: the final database and backup
// generations must be the same every time.
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { type FaultAction, type FsOp, MemoryFileSystem } from '../fs/memoryFs'
import { recoverSidecars } from './rotation'
import { encodeModel, makeVault, PASSWORD, PID, smallModel, unwrap, uuidHex } from './testkit'
import type { Vault } from './vault'

const DB = MemoryFileSystem.norm('/v/db.psafe3')
const enc = (s: string) => new TextEncoder().encode(s)
const OLD = await encodeModel(smallModel())
const GEN: Record<string, Uint8Array> = {
  B1: enc('backup generation one'),
  B2: enc('backup generation two'),
  B3: enc('backup generation three'),
}
const EDITED_TITLE = 'Edited before the save'

type Label = 'OLD' | 'NEW' | 'B1' | 'B2' | 'B3' | 'LOCK' | 'ANY'
type DiskMap = Map<string, Label>

const SETUPS = {
  'three backups': { 'db.psafe3.bak': 'B1', 'db.psafe3.bak2': 'B2', 'db.psafe3.bak3': 'B3' },
  'no backups': {},
  'one backup': { 'db.psafe3.bak': 'B1' },
} as const satisfies Record<string, Record<string, Label>>
type SetupName = keyof typeof SETUPS

function freshDisk(setup: SetupName): MemoryFileSystem {
  const fs = new MemoryFileSystem()
  fs.setFile(DB, OLD)
  for (const [name, label] of Object.entries(SETUPS[setup])) fs.setFile(`/v/${name}`, GEN[label]!)
  return fs
}

let currentStep = 0

async function openEdited(fs: MemoryFileSystem): Promise<Vault> {
  const vault = makeVault(fs, { seed: 'fault-suite', onSaveStep: (s) => (currentStep = s) })
  unwrap(await vault.open(DB))
  unwrap(await vault.unlock(PASSWORD))
  unwrap(await vault.saveEntry({ uuid: uuidHex(3), title: EDITED_TITLE }))
  return vault
}

interface Baseline {
  trace: FsOp[]
  steps: number[]
  newBytes: Uint8Array
  commitIndex: number
}

async function baseline(setup: SetupName): Promise<Baseline> {
  const fs = freshDisk(setup)
  const vault = await openEdited(fs)
  const start = fs.ops.length
  const steps: number[] = []
  currentStep = 0
  fs.onOp = (op) => {
    steps[op.index - start] = currentStep
    return undefined
  }
  unwrap(await vault.save())
  const trace = fs.ops.slice(start)
  const commitIndex = trace.findIndex((o) => o.name === 'rename' && o.path2 === DB)
  return { trace, steps, newBytes: fs.peek(DB)!, commitIndex }
}

// Sequential: the step recorder is shared.
const BASELINES = {} as Record<SetupName, Baseline>
for (const s of Object.keys(SETUPS) as SetupName[]) BASELINES[s] = await baseline(s)

function labelOf(bytes: Uint8Array | undefined, b: Baseline): Label {
  const eq = (x: Uint8Array) => bytes !== undefined && Buffer.compare(bytes, x) === 0
  if (eq(OLD)) return 'OLD'
  if (eq(b.newBytes)) return 'NEW'
  for (const k of ['B1', 'B2', 'B3'] as const) if (eq(GEN[k]!)) return k
  return 'ANY'
}

function actualDisk(fs: MemoryFileSystem, b: Baseline): DiskMap {
  const m: DiskMap = new Map()
  for (const name of fs.list('/v')) {
    m.set(name, name === 'db.plk' ? 'LOCK' : labelOf(fs.peek(`/v/${name}`), b))
  }
  return m
}

function initialDisk(setup: SetupName): DiskMap {
  return new Map<string, Label>([['db.psafe3', 'OLD'], ...Object.entries(SETUPS[setup])])
}

/** Reference model of the protocol: the disk after the first `k` operations of the trace. */
function diskBefore(setup: SetupName, b: Baseline, k: number): DiskMap {
  const m = initialDisk(setup)
  m.set('db.plk', 'LOCK')
  for (const op of b.trace.slice(0, k)) {
    const name = basename(op.path)
    const to = op.path2 === undefined ? undefined : basename(op.path2)
    switch (op.name) {
      case 'createExclusive':
        m.set(name, 'ANY')
        break
      case 'copyFile':
        m.set(to!, m.get(name)!)
        break
      case 'rename':
        m.set(to!, to === 'db.psafe3' ? 'NEW' : m.get(name)!)
        m.delete(name)
        break
      case 'unlink':
        m.delete(name)
        break
    }
  }
  return m
}

/** Where every generation ends up: unchanged before the commit, rotated after it. */
function finalDisk(setup: SetupName, committed: boolean): DiskMap {
  if (!committed) return initialDisk(setup)
  const init = initialDisk(setup)
  const m = new Map<string, Label>([
    ['db.psafe3', 'NEW'],
    ['db.psafe3.bak', 'OLD'],
  ])
  const b1 = init.get('db.psafe3.bak')
  const b2 = init.get('db.psafe3.bak2')
  const b3 = init.get('db.psafe3.bak3')
  if (b1) m.set('db.psafe3.bak2', b1)
  else if (b2) m.set('db.psafe3.bak2', b2) // .bak2 is only moved when it exists
  if (b2 && b1) m.set('db.psafe3.bak3', b2)
  else if (b3) m.set('db.psafe3.bak3', b3)
  return m
}

function expectDisk(actual: DiskMap, expected: DiskMap, ignoreLock = false): void {
  const strip = (m: DiskMap) => {
    const c = new Map(m)
    if (ignoreLock) c.delete('db.plk')
    return c
  }
  const a = strip(actual)
  const e = strip(expected)
  expect([...a.keys()].sort()).toEqual([...e.keys()].sort())
  for (const [name, label] of e)
    if (label !== 'ANY') expect([name, a.get(name)]).toEqual([name, label])
}

/** §A5 row 8: after the commit every generation still exists somewhere (B3 drops once .bak2 moved). */
function expectGenerationsSomewhere(actual: DiskMap, setup: SetupName): void {
  const labels = new Set(actual.values())
  expect(labels.has('OLD')).toBe(true)
  for (const g of Object.values(SETUPS[setup]) as Label[]) {
    if (g !== 'B3') expect([g, labels.has(g)]).toEqual([g, true])
  }
}

async function recoverAndCheck(
  fs: MemoryFileSystem,
  setup: SetupName,
  b: Baseline,
  committed: boolean,
): Promise<void> {
  const expected = finalDisk(setup, committed)
  const crashedDisk = fs.clone()

  // Recovery through a new Vault (new process: the dead one's lock is a Linux orphan).
  fs.revive()
  const v2 = makeVault(fs, { pid: PID + 1, processExists: (pid) => pid !== PID })
  unwrap(await v2.open(DB))
  const state = unwrap(await v2.unlock(PASSWORD))
  expect(state.banners.filter((x) => x.kind === 'warning')).toEqual([])
  expect(unwrap(v2.getEntry(uuidHex(3))).title).toBe(committed ? EDITED_TITLE : 'Mail')
  unwrap(await v2.close())
  expectDisk(actualDisk(fs, b), expected)

  // A second run changes nothing.
  const again = await recoverSidecars(fs, DB)
  expect(again.actions).toEqual([])
  expectDisk(actualDisk(fs, b), expected)

  // Kill recovery at each of its own operations, then rerun it: same final state.
  const probe = crashedDisk.clone()
  await recoverSidecars(probe, DB)
  const recoveryOps = probe.ops.length
  for (let j = 0; j < recoveryOps; j++) {
    const d = crashedDisk.clone()
    d.onOp = (op) => (op.index === j ? { kind: 'crash' } : undefined)
    await recoverSidecars(d, DB)
    expect(d.crashed).toBe(true)
    d.revive()
    await recoverSidecars(d, DB)
    d.revive()
    await recoverSidecars(d, DB)
    expectDisk(actualDisk(d, b), expected, true)
  }
}

describe.each(Object.keys(SETUPS) as SetupName[])('fault injection with %s', (setup) => {
  const b = BASELINES[setup]
  const cases = b.trace.map((op, k) => ({ k, label: op.label, step: b.steps[k]!, op }))

  it('baseline: the save covers steps 1–10 with the expected operations', () => {
    expect(new Set(b.steps)).toEqual(new Set([1, 3, 4, 5, 6, 7, 8, 9]))
    expect(b.trace[b.commitIndex]!.label).toMatch(
      /^rename:\.db\.psafe3\.[0-9a-f]{12}\.new->db\.psafe3$/,
    )
    expect(b.trace.at(-1)!.label).toBe('fsyncDir:v')
    const names = b.trace.map((o) => o.name)
    for (const n of ['createExclusive', 'write', 'fsync', 'close', 'copyFile', 'fsyncFile']) {
      expect(names).toContain(n)
    }
  })

  async function runWith(k: number, action: FaultAction) {
    const fs = freshDisk(setup)
    const vault = await openEdited(fs)
    const start = fs.ops.length
    fs.onOp = (op) => (op.index === start + k ? action : undefined)
    const result = await vault.save()
    expect(fs.ops[start + k]!.label).toBe(b.trace[k]!.label)
    return { fs, vault, result }
  }

  it.each(cases)('injected failure at op $k ($label, step $step)', async ({ k, step }) => {
    const { fs, vault, result } = await runWith(k, { kind: 'fail', code: 'EIO' })
    // The directory fsync right after the journal write is best effort (step 9 reports
    // durability), so a failure there must not stop the save.
    const tolerated = b.trace[k]!.name === 'fsyncDir' && step === 5
    const committed = k > b.commitIndex || tolerated
    if (tolerated) {
      expect(unwrap(result).dirtyCount).toBe(0)
      expectDisk(actualDisk(fs, b), new Map([...finalDisk(setup, true), ['db.plk', 'LOCK']]))
    } else if (!committed) {
      // Rows 1–7: nothing changed, staged files deleted, edits still unsaved.
      expect(result.ok ? 'ok' : result.error.code).toBe(ErrorCode.SAVE_FAILED)
      if (!result.ok) expect(result.error.detail).toMatch(new RegExp(`^Step ${step}: `))
      expectDisk(actualDisk(fs, b), new Map([...initialDisk(setup), ['db.plk', 'LOCK']]))
      expect(vault.getState().dirtyCount).toBe(1)
    } else if (step === 8) {
      // Row 8: saved; rotation stopped where it failed; journal and staged copy kept.
      const state = unwrap(result)
      expect(state.dirtyCount).toBe(0)
      expect(state.banners.map((x) => x.id)).toEqual(['rotation'])
      const disk = actualDisk(fs, b)
      expectDisk(disk, diskBefore(setup, b, k))
      expect(disk.has('.db.psafe3.rotation.json')).toBe(true)
      expectGenerationsSomewhere(disk, setup)
    } else {
      // Row 9: directory fsync failed; the save stands.
      expect(step).toBe(9)
      expect(result.ok ? 'ok' : result.error.code).toBe(ErrorCode.SAVED_DURABILITY_UNCONFIRMED)
      expect(vault.getState().dirtyCount).toBe(0)
      expectDisk(actualDisk(fs, b), new Map([...finalDisk(setup, true), ['db.plk', 'LOCK']]))
    }
    unwrap(await vault.close())
    await recoverAndCheck(fs, setup, b, committed)
  })

  it.each(cases)('process death at op $k ($label, step $step)', async ({ k }) => {
    const { fs } = await runWith(k, { kind: 'crash' })
    expect(fs.crashed).toBe(true)
    const disk = actualDisk(fs, b)
    expectDisk(disk, diskBefore(setup, b, k))
    const committed = k > b.commitIndex
    if (!committed) {
      expect(disk.get('db.psafe3')).toBe('OLD')
      for (const [n, l] of initialDisk(setup)) expect([n, disk.get(n)]).toEqual([n, l])
    } else {
      expect(disk.get('db.psafe3')).toBe('NEW')
      expectGenerationsSomewhere(disk, setup)
    }
    await recoverAndCheck(fs, setup, b, committed)
  })

  const writes = cases.filter((c) => c.op.name === 'write')
  it.each(writes)('torn write then death at op $k ($label)', async ({ k }) => {
    const { fs } = await runWith(k, { kind: 'torn-crash' })
    expect(fs.crashed).toBe(true)
    expectDisk(actualDisk(fs, b), diskBefore(setup, b, k + 1))
    await recoverAndCheck(fs, setup, b, false)
  })
})

describe('after a failed save', () => {
  it('the next save succeeds and rotates normally', async () => {
    const fs = freshDisk('three backups')
    const vault = await openEdited(fs)
    const b = BASELINES['three backups']
    const start = fs.ops.length
    fs.onOp = (op) =>
      op.index === start + b.commitIndex ? { kind: 'fail', code: 'EBUSY' } : undefined
    expect((await vault.save()).ok).toBe(false)
    fs.onOp = undefined
    unwrap(await vault.save())
    const disk = actualDisk(fs, b)
    expect(disk.get('db.psafe3.bak')).toBe('OLD')
    expect(disk.get('db.psafe3.bak2')).toBe('B1')
    expect(disk.get('db.psafe3.bak3')).toBe('B2')
    expect([...disk.keys()].filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('an unfinished rotation is completed by the next save in the same session', async () => {
    const fs = freshDisk('three backups')
    const vault = await openEdited(fs)
    const b = BASELINES['three backups']
    const start = fs.ops.length
    const m2 = b.trace.findIndex((o) => o.label === 'rename:db.psafe3.bak->db.psafe3.bak2')
    fs.onOp = (op) => (op.index === start + m2 ? { kind: 'fail', code: 'EIO' } : undefined)
    const first = unwrap(await vault.save())
    expect(first.banners.map((x) => x.id)).toEqual(['rotation'])
    fs.onOp = undefined
    const firstSaved = fs.peek(DB)!
    unwrap(await vault.saveEntry({ uuid: uuidHex(2), title: 'Second edit' }))
    const second = unwrap(await vault.save())
    expect(second.banners).toEqual([])
    expect(fs.peek(`${DB}.bak`)).toEqual(firstSaved)
    expect(fs.peek(`${DB}.bak2`)).toEqual(OLD)
    expect(fs.peek(`${DB}.bak3`)).toEqual(GEN.B1)
    expect(fs.list('/v').filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('Windows-style rename retries: EBUSY on the commit is retried (win32 platform)', async () => {
    // v1 never saves on Windows (read-only), but the commit helper implements MoveFileEx retries.
    const { commitReplace, readDiskState } = await import('./commit')
    const fs = freshDisk('no backups')
    const { state } = await readDiskState(fs, DB)
    let busy = 2
    fs.onOp = (op) =>
      op.name === 'rename' && op.path2 === DB && busy-- > 0
        ? { kind: 'fail', code: 'EBUSY' }
        : undefined
    const out = await commitReplace(
      {
        fs,
        platform: 'win32',
        randomTag: () => 'abcdefabcdef',
        sleep: async () => {},
        log: () => {},
      },
      { dbPath: DB, openedPath: DB, expected: state },
      async () => ({ ok: true, value: enc('new content') }),
      async () => ({ ok: true, value: undefined }),
    )
    expect(out.kind).toBe('saved')
    expect(fs.peek(DB)).toEqual(enc('new content'))
    expect(fs.peek(`${DB}.bak`)).toEqual(OLD)
  })
})
