// Shape and size checks for every argument that arrives over IPC (docs/execution-plan.md WP7).
// The renderer is treated as untrusted: anything that is not exactly the documented shape is
// refused with INVALID_ARGUMENT before it reaches the vault, a dialog or the disk.
import type { LockOptions, UnlockOptions } from '../../shared/ipc'
import {
  GENERATOR_MAX_LENGTH,
  GENERATOR_MIN_LENGTH,
  IDLE_LOCK_MAX_MIN,
  IDLE_LOCK_MIN_MIN,
  MAX_FIELD_BYTES,
} from '../../shared/limits'
import type {
  CopyableField,
  EntryDraft,
  ExportOptions,
  GeneratorOptions,
  Settings,
} from '../../shared/types'

/** Thrown by the checks below; the IPC layer turns it into an INVALID_ARGUMENT result. */
export class InvalidArgument extends Error {
  constructor(what: string) {
    super(what)
    this.name = 'InvalidArgument'
  }
}

/** Longest id we hand out or accept (entry uuids are 32 hex chars, `#n` for uuid-less records). */
export const MAX_ID_CHARS = 128
/** Longest master password accepted from the unlock field, in UTF-8 bytes. */
export const MAX_PASSWORD_BYTES = 64 * 1024
/** Longest file path accepted from the renderer (only revealInFolder takes one). */
export const MAX_PATH_CHARS = 4096

type Plain = Record<string, unknown>

function isPlainObject(v: unknown): v is Plain {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function onlyKeys(o: Plain, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new InvalidArgument(`${what}: unexpected key`)
  }
}

/** Checks the number of arguments: no more than `max`. Missing optional ones are undefined. */
export function argCount(args: readonly unknown[], max: number): void {
  if (args.length > max) throw new InvalidArgument('too many arguments')
}

export function text(v: unknown, what: string, maxBytes = MAX_FIELD_BYTES): string {
  if (typeof v !== 'string') throw new InvalidArgument(`${what}: not a string`)
  // Cheap bound first (a UTF-16 unit is at most 3 UTF-8 bytes), exact count only near the limit.
  if (v.length * 3 > maxBytes && Buffer.byteLength(v, 'utf8') > maxBytes) {
    throw new InvalidArgument(`${what}: too long`)
  }
  return v
}

export function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID_CHARS) {
    throw new InvalidArgument(`${what}: bad id`)
  }
  return v
}

export function password(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new InvalidArgument('password: empty')
  return text(v, 'password', MAX_PASSWORD_BYTES)
}

export function filePath(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATH_CHARS || v.includes('\0')) {
    throw new InvalidArgument('path: bad path')
  }
  return v
}

export function unlockOptions(v: unknown): UnlockOptions {
  if (v === undefined) return {}
  if (!isPlainObject(v)) throw new InvalidArgument('unlock options: not an object')
  onlyKeys(v, ['lockChoice'], 'unlock options')
  const c = v['lockChoice']
  if (c === undefined) return {}
  if (c !== 'read-only' && c !== 'remove-lock') throw new InvalidArgument('lockChoice')
  return { lockChoice: c }
}

export function lockOptions(v: unknown): LockOptions {
  if (v === undefined) return {}
  if (!isPlainObject(v)) throw new InvalidArgument('lock options: not an object')
  onlyKeys(v, ['discardChanges'], 'lock options')
  const d = v['discardChanges']
  if (d === undefined) return {}
  if (typeof d !== 'boolean') throw new InvalidArgument('discardChanges')
  return { discardChanges: d }
}

const COPYABLE: readonly CopyableField[] = ['username', 'password', 'url', 'email']

export function copyableField(v: unknown): CopyableField {
  if (!COPYABLE.includes(v as CopyableField)) throw new InvalidArgument('field')
  return v as CopyableField
}

const DRAFT_TEXT_KEYS = ['title', 'group', 'username', 'password', 'url', 'email', 'notes'] as const

export function entryDraft(v: unknown): EntryDraft {
  if (!isPlainObject(v)) throw new InvalidArgument('draft: not an object')
  onlyKeys(v, ['uuid', ...DRAFT_TEXT_KEYS], 'draft')
  const draft: EntryDraft = {}
  if (v['uuid'] !== undefined) draft.uuid = id(v['uuid'], 'draft uuid')
  for (const key of DRAFT_TEXT_KEYS) {
    if (v[key] !== undefined) draft[key] = text(v[key], `draft ${key}`)
  }
  return draft
}

export function exportOptions(v: unknown): ExportOptions {
  if (!isPlainObject(v)) throw new InvalidArgument('export options: not an object')
  onlyKeys(v, ['scope'], 'export options')
  const scope = v['scope']
  if (!isPlainObject(scope)) throw new InvalidArgument('scope')
  if (scope['kind'] === 'all') {
    onlyKeys(scope, ['kind'], 'scope')
    return { scope: { kind: 'all' } }
  }
  if (scope['kind'] === 'group') {
    onlyKeys(scope, ['kind', 'path'], 'scope')
    const path = text(scope['path'], 'scope path', 64 * 1024)
    if (path === '') throw new InvalidArgument('scope path: empty')
    return { scope: { kind: 'group', path } }
  }
  throw new InvalidArgument('scope kind')
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new InvalidArgument(what)
  return v
}

function intInRange(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new InvalidArgument(what)
  }
  return v
}

export function generatorOptions(v: unknown): GeneratorOptions {
  if (!isPlainObject(v)) throw new InvalidArgument('generator: not an object')
  const keys = [
    'length',
    'upper',
    'lower',
    'digits',
    'symbols',
    'avoidLookAlikes',
    'requireEachSelected',
  ] as const
  onlyKeys(v, keys, 'generator')
  const g: GeneratorOptions = {
    length: intInRange(v['length'], GENERATOR_MIN_LENGTH, GENERATOR_MAX_LENGTH, 'length'),
    upper: bool(v['upper'], 'upper'),
    lower: bool(v['lower'], 'lower'),
    digits: bool(v['digits'], 'digits'),
    symbols: bool(v['symbols'], 'symbols'),
    avoidLookAlikes: bool(v['avoidLookAlikes'], 'avoidLookAlikes'),
    requireEachSelected: bool(v['requireEachSelected'], 'requireEachSelected'),
  }
  // §B1: at least one character set must stay on.
  if (!g.upper && !g.lower && !g.digits && !g.symbols) throw new InvalidArgument('no sets')
  return g
}

export function settings(v: unknown): Settings {
  if (!isPlainObject(v)) throw new InvalidArgument('settings: not an object')
  onlyKeys(v, ['idleLockMinutes', 'lockOnMinimize', 'generator'], 'settings')
  return {
    idleLockMinutes: intInRange(
      v['idleLockMinutes'],
      IDLE_LOCK_MIN_MIN,
      IDLE_LOCK_MAX_MIN,
      'idleLockMinutes',
    ),
    lockOnMinimize: bool(v['lockOnMinimize'], 'lockOnMinimize'),
    generator: generatorOptions(v['generator']),
  }
}

export function closeChoice(v: unknown): 'save' | 'discard' | 'cancel' {
  if (v !== 'save' && v !== 'discard' && v !== 'cancel') throw new InvalidArgument('close choice')
  return v
}
