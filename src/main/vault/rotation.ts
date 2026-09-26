// Journaled, idempotent backup rotation and open-time recovery (docs/execution-plan.md §A5 step 8
// and "Recovery on open").
//
// Before the commit rename a save writes `.name.rotation.json` with the hash of every file it will
// move. Each move is "check, then act": if the destination already holds the expected content the
// move is done (a leftover source with that content is deleted); else if the source holds it, it is
// renamed; else we stop and keep every file ("unknown state"). So running the rotation once, twice,
// or again after a crash in the middle of a previous run always ends in the same state.
import { basename, join as joinPath } from 'node:path'
import type { Banner } from '../../shared/types'
import type { FileSystem } from '../fs/types'
import { isNotFound } from '../fs/types'
import { GENERATIONS, hashOrNone, sha256Hex, type Sidecars, sidecarsFor, TAG_RE } from './sidecars'

export interface JournalMove {
  /** Base names in the database's directory. */
  from: string
  to: string
  /** SHA-256 (hex) of the content being moved. */
  expect: string
}

export interface Journal {
  version: 1
  /** Base name of the database. */
  db: string
  tag: string
  /** Hash of the database before the save (equals the staged copy). */
  hOld: string
  /** Hash of the database the save commits. */
  hNew: string
  moves: JournalMove[]
}

const HASH_RE = /^[0-9a-f]{64}$/

/** Plans the rotation for a save: .bak2 → .bak3, .bak → .bak2, staged → .bak (missing ones skipped). */
export function planJournal(
  sc: Sidecars,
  tag: string,
  hashes: { h1?: string; h2?: string; hOld: string; hNew: string },
): Journal {
  const moves: JournalMove[] = []
  if (hashes.h2 !== undefined) {
    moves.push({ from: sc.backupName(2), to: sc.backupName(3), expect: hashes.h2 })
  }
  if (hashes.h1 !== undefined) {
    moves.push({ from: sc.backupName(1), to: sc.backupName(2), expect: hashes.h1 })
  }
  moves.push({ from: basename(sc.staged(tag)), to: sc.backupName(1), expect: hashes.hOld })
  return { version: 1, db: sc.name, tag, hOld: hashes.hOld, hNew: hashes.hNew, moves }
}

export function encodeJournal(j: Journal): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(j))
}

/**
 * Parses a journal and checks that it only names this database's own backup and staged files
 * (a journal can never make us touch any other path). Undefined when invalid.
 */
export function parseJournal(bytes: Uint8Array, sc: Sidecars): Journal | undefined {
  let v: unknown
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null) return undefined
  const j = v as Partial<Journal>
  if (j.version !== 1 || j.db !== sc.name || typeof j.tag !== 'string' || !TAG_RE.test(j.tag)) {
    return undefined
  }
  if (typeof j.hOld !== 'string' || !HASH_RE.test(j.hOld)) return undefined
  if (typeof j.hNew !== 'string' || !HASH_RE.test(j.hNew)) return undefined
  if (!Array.isArray(j.moves) || j.moves.length < 1 || j.moves.length > GENERATIONS.length) {
    return undefined
  }
  const allowed = new Set([...GENERATIONS.map((g) => sc.backupName(g)), basename(sc.staged(j.tag))])
  for (const m of j.moves as unknown[]) {
    if (typeof m !== 'object' || m === null) return undefined
    const mv = m as Partial<JournalMove>
    if (typeof mv.from !== 'string' || typeof mv.to !== 'string' || typeof mv.expect !== 'string') {
      return undefined
    }
    if (!allowed.has(mv.from) || !allowed.has(mv.to) || !HASH_RE.test(mv.expect)) return undefined
  }
  return j as Journal
}

export type RotationResult =
  | { kind: 'done' }
  /** A file held content the journal did not expect: nothing more was moved or deleted. */
  | { kind: 'unknown-state' }
  /** An operation failed; the journal is kept and the rotation can be re-run. */
  | { kind: 'io-error'; error: unknown }

/** Runs (or re-runs) the moves of a journal, then deletes it. Never throws. */
export async function runRotation(
  fs: FileSystem,
  sc: Sidecars,
  journal: Journal,
  log: (msg: string) => void = () => {},
): Promise<RotationResult> {
  const pathOf = (name: string) => join(sc, name)
  try {
    for (let i = 0; i < journal.moves.length; i++) {
      const m = journal.moves[i]!
      const src = pathOf(m.from)
      const dest = pathOf(m.to)
      if ((await hashOrNone(fs, dest)) === m.expect) {
        // Already moved. A leftover source with the same content is a duplicate name we can
        // drop, unless a later move still expects that same content at the source's name.
        const later = journal.moves
          .slice(i + 1)
          .some((n) => n.to === m.from && n.expect === m.expect)
        if (!later && (await hashOrNone(fs, src)) === m.expect) {
          await fs.unlink(src)
          log(`backup rotation: removed duplicate ${m.from}`)
        }
        continue
      }
      if ((await hashOrNone(fs, src)) === m.expect) {
        await fs.rename(src, dest)
        log(`backup rotation: ${m.from} -> ${m.to}`)
        continue
      }
      log(`backup rotation: unexpected content for ${m.from} -> ${m.to}; nothing moved`)
      return { kind: 'unknown-state' }
    }
    try {
      await fs.unlink(sc.journal)
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    return { kind: 'done' }
  } catch (error) {
    return { kind: 'io-error', error }
  }
}

/** Every journal and sidecar name is a sibling of the database. */
function join(sc: Sidecars, name: string): string {
  return joinPath(sc.dir, name)
}

export const ROTATION_UNFINISHED_TEXT =
  "Saved. Backup rotation didn't finish; it will complete next time you open this file."

export function rotationUnfinishedBanner(): Banner {
  return { kind: 'info', id: 'rotation', text: ROTATION_UNFINISHED_TEXT }
}

export function unknownStateBanner(files: string[]): Banner {
  return {
    kind: 'warning',
    id: 'backup-unknown',
    text:
      'Backups are in an unexpected state, so nothing was moved or deleted. ' +
      `Files: ${files.join(', ')}. Restore by hand if you need one.`,
  }
}

/** Names of every backup, staged and journal file of this database that exist now. */
export async function listBackupFiles(fs: FileSystem, sc: Sidecars): Promise<string[]> {
  try {
    const entries = await fs.readdir(sc.dir)
    const names = new Set([...GENERATIONS.map((g) => sc.backupName(g)), basename(sc.journal)])
    return entries.filter((e) => names.has(e) || sc.stagedTag(e) !== undefined).sort()
  } catch {
    return []
  }
}

export interface RecoveryReport {
  /** Human-readable actions taken (logged; no secrets). */
  actions: string[]
  banners: Banner[]
  /** A journal is still present (rotation unfinished or unknown state). */
  journalRemaining: boolean
}

/**
 * Open-time recovery (§A5), run only for a vault opened for editing (we hold its lock):
 * 1. delete leftover `.new` files (never committed);
 * 2. if a journal exists: when the database is the one the journal committed, re-run the rotation;
 *    when it is still the old one (crash before the commit), drop the journal; otherwise keep
 *    everything and report an unknown state;
 * 3. a `.bak-staged` file not named by a remaining journal is deleted only if its content equals
 *    the current database, otherwise kept and reported.
 * Safe to run any number of times, including after a crash part-way through. Never throws.
 */
export async function recoverSidecars(
  fs: FileSystem,
  dbPath: string,
  log: (msg: string) => void = () => {},
): Promise<RecoveryReport> {
  const sc = sidecarsFor(dbPath)
  const actions: string[] = []
  const banners: Banner[] = []
  let rotationFinished = false
  let unknown = false
  let ioProblem = false
  let journalRemaining = false
  const act = (msg: string) => {
    actions.push(msg)
    log(`recovery: ${msg}`)
  }
  let dbHash: string | undefined | null = null
  const currentDbHash = async () => {
    if (dbHash === null) dbHash = await hashOrNone(fs, sc.db)
    return dbHash
  }

  try {
    const entries = await fs.readdir(sc.dir)
    for (const e of entries) {
      if (!sc.isNewFileName(e)) continue
      await fs.unlink(join(sc, e))
      act(`removed unfinished save file ${e}`)
    }

    let journal: Journal | undefined
    if (entries.includes(basename(sc.journal))) {
      let raw: Uint8Array | undefined
      try {
        raw = await fs.readFile(sc.journal)
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
      if (raw !== undefined) {
        journal = parseJournal(raw, sc)
        if (!journal) {
          // The journal is fsynced before the commit, so an incomplete one means no commit happened.
          await fs.unlink(sc.journal)
          act('removed an incomplete backup journal')
        } else {
          const h = await currentDbHash()
          if (h === journal.hNew) {
            const r = await runRotation(fs, sc, journal, log)
            if (r.kind === 'done') {
              rotationFinished = true
              act('finished an interrupted backup rotation')
              journal = undefined
            } else if (r.kind === 'unknown-state') {
              unknown = true
              journalRemaining = true
            } else {
              ioProblem = true
              journalRemaining = true
            }
          } else if (h === journal.hOld) {
            await fs.unlink(sc.journal)
            act('discarded the plan of a save that never committed')
            journal = undefined
          } else {
            unknown = true
            journalRemaining = true
            log('recovery: database matches neither side of the backup journal; nothing moved')
          }
        }
      }
    }

    const after = await fs.readdir(sc.dir)
    for (const e of after) {
      const tag = sc.stagedTag(e)
      if (tag === undefined) continue
      if (journal && journal.tag === tag) continue // still needed by the kept journal
      const path = join(sc, e)
      const h = await hashOrNone(fs, path)
      if (h === undefined) continue
      if (h === (await currentDbHash())) {
        await fs.unlink(path)
        act(`removed staged copy ${e} (same as the database)`)
      } else {
        unknown = true
        log(`recovery: kept staged copy ${e}; it differs from the database`)
      }
    }
  } catch (e) {
    ioProblem = true
    log(`recovery: stopped after an I/O error (${(e as { code?: string }).code ?? 'unknown'})`)
  }

  if (unknown) banners.push(unknownStateBanner(await listBackupFiles(fs, sc)))
  else if (ioProblem) {
    banners.push({
      kind: 'warning',
      id: 'recovery-failed',
      text:
        "Couldn't finish tidying up after an interrupted save. Nothing was deleted; " +
        'it will be tried again next time you open this file.',
    })
  }
  if (rotationFinished) {
    banners.push({
      kind: 'info',
      id: 'recovery',
      text: 'Finished an interrupted backup rotation from the last save. Your file and backups are in place.',
    })
  } else if (actions.length > 0) {
    banners.push({
      kind: 'info',
      id: 'recovery',
      text: 'Cleaned up files left by an interrupted save. Your file and backups were not changed.',
    })
  }
  return { actions, banners, journalRemaining }
}

/** SHA-256 hex of bytes (re-exported for callers building journals). */
export { sha256Hex }
