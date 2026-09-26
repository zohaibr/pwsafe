// Helpers for the §A5 end-to-end suite on the real file system (docs/execution-plan.md §A5, WP8):
// a Vault wired to the real file-system layer, temp copies of the committed fixtures, directory
// snapshots by content hash, and a crash-injecting wrapper around the real file system, so a
// "process death" can be simulated at any single operation of the real save pipeline.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { expect } from 'vitest'
import { createNodeFileSystem, type FileSystem, type WritableFile } from '../../src/main/fs'
import { SimulatedCrash } from '../../src/main/fs/memoryFs'
import type { LockPlatform } from '../../src/main/lockfile'
import { decode } from '../../src/main/psafe3/codec'
import { Vault, type VaultDeps } from '../../src/main/vault'
import type { RawField, RawRecord } from '../../src/shared/types'
import { type Fixture, deps, loadFixture, unwrap } from './support'

export const PLATFORM: LockPlatform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
export const WINDOWS = PLATFORM === 'win32'

export const IDENTITY = { user: userInfo().username, host: hostname(), pid: process.pid }

function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const c = (e as { code?: string }).code
    return c === 'ESRCH' ? false : c === 'EPERM' ? true : undefined
  }
}

/**
 * A Vault on the given file system (the real one by default) with real Twofish. Key stretching is
 * the reference loop memoised by (password, salt, iterations): the fixtures use 327,680
 * iterations and the vault keeps a file's iteration count, so each save still pays for one real
 * stretch (its fresh salt), but re-opening or decoding a file we already stretched is free.
 */
export function newVault(
  fs: FileSystem = createNodeFileSystem(),
  extra: Pick<VaultDeps, 'onSaveStep'> = {},
): Vault {
  return new Vault({
    fs,
    platform: PLATFORM,
    identity: IDENTITY,
    processExists,
    codec: deps,
    appName: 'psafe3 Opener A5 test',
    ...extra,
  })
}

export interface TempDb {
  dir: string
  /** Path of the copied database. */
  db: string
  /** Its `.plk` (Password Safe's rule: the suffix is replaced). */
  plk: string
  name: string
  fixture: Fixture
  original: Uint8Array
}

const temps: string[] = []

/** Copies a committed fixture into a fresh temp directory. */
export function tempCopy(fixtureName: string, prefix = 'wp8-a5-'): TempDb {
  const fixture = loadFixture(fixtureName)
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  const name = `${fixtureName}.psafe3`
  const db = join(dir, name)
  copyFileSync(fixture.path, db)
  return {
    dir,
    db,
    plk: join(dir, `${fixtureName}.plk`),
    name,
    fixture,
    original: new Uint8Array(readFileSync(db)),
  }
}

export function removeTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
}

export const ls = (dir: string): string[] => readdirSync(dir).sort()
export const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))
export const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** Files a save may only leave behind while it runs (§A5): `.new`, `.bak-staged`, the journal. */
export const SIDECAR_RE = /\.new$|\.bak-staged$|\.rotation\.json$/
export const leftovers = (dir: string): string[] => ls(dir).filter((f) => SIDECAR_RE.test(f))

/** Every file of a directory with its content. */
export function snapshotDir(dir: string): Map<string, Uint8Array> {
  return new Map(ls(dir).map((f) => [f, read(join(dir, f))]))
}

/** Puts a directory back exactly as a snapshot had it. */
export function restoreDir(dir: string, snap: Map<string, Uint8Array>): void {
  for (const f of ls(dir)) rmSync(join(dir, f))
  for (const [f, data] of snap) writeFileSync(join(dir, f), data)
}

/** Name → content hash, for comparing a directory before and after. */
export function hashesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [f, data] of snapshotDir(dir)) out[f] = sha(data)
  return out
}

/** Random save tags vary per run; `.x.psafe3.0123456789ab.new` → `.x.psafe3.<tag>.new`. */
export const normName = (f: string): string =>
  f.replace(/\.[0-9a-f]{12}\.(new|bak-staged)$/, '.<tag>.$1')

/**
 * The directory as { normalised name: label }, labelling each file by the first entry of
 * `labels` (label → content) with the same content, or '?' when none matches.
 */
export function labelDir(dir: string, labels: Record<string, Uint8Array>): Record<string, string> {
  const byHash = new Map<string, string>()
  for (const [label, data] of Object.entries(labels)) {
    if (!byHash.has(sha(data))) byHash.set(sha(data), label)
  }
  const out: Record<string, string> = {}
  for (const [f, data] of snapshotDir(dir)) out[normName(f)] = byHash.get(sha(data)) ?? '?'
  return out
}

/** A deep copy of records (the vault zeroes replaced field buffers, so keep our own). */
export function copyRecords(records: readonly RawRecord[]): RawRecord[] {
  return records.map((r) => ({
    fields: r.fields.map((f: RawField) => ({ type: f.type, data: f.data.slice() })),
  }))
}

/** Decodes a file on disk with the given password (throws on any decode error). */
export async function decodeFile(path: string, password: Uint8Array) {
  return unwrap(await decode(read(path), password, deps))
}

/** Decoded records equal `expected` field for field, byte for byte, in order. */
export function expectSameRecords(actual: readonly RawRecord[], expected: readonly RawRecord[]) {
  const view = (rs: readonly RawRecord[]) =>
    rs.map((r) => r.fields.map((f) => `${f.type}:${Buffer.from(f.data).toString('hex')}`))
  expect(view(actual)).toEqual(view(expected))
}

// ── Crash injection on the real file system ────────────────────────────────

export interface FsCall {
  name: string
  path: string
  path2?: string
}

export interface CrashingFs {
  fs: FileSystem
  /** Every operation attempted, in order (base names only). */
  calls: string[]
  /** The crash has happened. */
  readonly crashed: boolean
}

/**
 * Wraps a real FileSystem so that the first operation for which `crashBefore` returns true does
 * not happen and the "process" dies: that and every later operation throw SimulatedCrash, so the
 * disk stays exactly as a process killed at that point would leave it. Open handles are still
 * closed for real (without writing) so the OS does not keep them.
 */
export function crashingFs(base: FileSystem, crashBefore: (op: FsCall) => boolean): CrashingFs {
  let dead = false
  const calls: string[] = []
  const gate = (op: FsCall) => {
    calls.push(`${op.name}:${basename(op.path)}${op.path2 ? `->${basename(op.path2)}` : ''}`)
    if (dead) throw new SimulatedCrash('process is dead')
    if (crashBefore(op)) {
      dead = true
      throw new SimulatedCrash(`crash before ${op.name} ${basename(op.path)}`)
    }
  }
  const fs: FileSystem = {
    async readFile(p) {
      gate({ name: 'readFile', path: p })
      return base.readFile(p)
    },
    async createExclusive(p, mode): Promise<WritableFile> {
      gate({ name: 'createExclusive', path: p })
      const f = await base.createExclusive(p, mode)
      return {
        async write(data) {
          gate({ name: 'write', path: p })
          return f.write(data)
        },
        async sync() {
          gate({ name: 'sync', path: p })
          return f.sync()
        },
        async close() {
          try {
            gate({ name: 'close', path: p })
          } catch (e) {
            await f.close().catch(() => {})
            throw e
          }
          return f.close()
        },
      }
    },
    async fsyncFile(p) {
      gate({ name: 'fsyncFile', path: p })
      return base.fsyncFile(p)
    },
    async fsyncDir(p) {
      gate({ name: 'fsyncDir', path: p })
      return base.fsyncDir(p)
    },
    async rename(from, to) {
      gate({ name: 'rename', path: from, path2: to })
      return base.rename(from, to)
    },
    async link(existing, newPath) {
      gate({ name: 'link', path: existing, path2: newPath })
      return base.link(existing, newPath)
    },
    async unlink(p) {
      gate({ name: 'unlink', path: p })
      return base.unlink(p)
    },
    async lstat(p) {
      gate({ name: 'lstat', path: p })
      return base.lstat(p)
    },
    async realpath(p) {
      gate({ name: 'realpath', path: p })
      return base.realpath(p)
    },
    async copyFile(src, dest) {
      gate({ name: 'copyFile', path: src, path2: dest })
      return base.copyFile(src, dest)
    },
    async readdir(p) {
      gate({ name: 'readdir', path: p })
      return base.readdir(p)
    },
    async fsType(p) {
      gate({ name: 'fsType', path: p })
      return base.fsType(p)
    },
  }
  return {
    fs,
    calls,
    get crashed() {
      return dead
    },
  }
}

// ── Edits through the Vault ─────────────────────────────────────────────────

export interface EditState {
  /** The entry edited in every round. */
  target?: string
  /** The entry added by the previous round (deleted by the next). */
  lastAdded?: string
}

/**
 * One round of edits: delete one entry (in the first round the first original entry the vault
 * allows, after that the previous round's addition), retitle the same editable entry every round
 * (the first editable one left; in cli-links that is the alias base) and add a new one.
 */
export async function editRound(v: Vault, round: number, state: EditState) {
  let deleted: string | undefined
  if (state.lastAdded !== undefined) {
    unwrap(await v.deleteEntry(state.lastAdded))
    deleted = state.lastAdded
  } else {
    // Read-only records and bases with dependants are refused (RECORD_READ_ONLY), in memory.
    for (const e of unwrap(v.listEntries())) {
      if (e.editable && (await v.deleteEntry(e.uuid)).ok) {
        deleted = e.uuid
        break
      }
    }
  }
  expect(deleted, 'an entry the vault lets us delete').toBeDefined()
  state.target ??= unwrap(v.listEntries()).find((e) => e.editable)!.uuid
  const title = `Edited in save ${round}`
  unwrap(await v.saveEntry({ uuid: state.target, title }))
  const added = unwrap(
    await v.saveEntry({
      title: `Added in save ${round}`,
      password: `pw ${round}`,
      group: 'A5.Round',
    }),
  ).uuid
  state.lastAdded = added
  expect(v.getState().dirtyCount).toBe(3)
  return { title, deleted: deleted!, added }
}
