// Views over RawRecords (docs/execution-plan.md §A3). The RawRecord stays the source of truth:
// buildEntry() reads it into the shared Entry view, applyDraft() writes an EntryDraft through to
// the editable fields only. Nothing is ever rebuilt from an Entry.
import { ErrorCode, DEFAULT_MESSAGES, fail, ok, type Result } from '../../shared/errors'
import {
  EDITABLE_FIELD_TYPES,
  type Entry,
  type EntryDraft,
  type EntryFlags,
  type EntryKind,
  FieldType,
  type RawField,
  type RawRecord,
} from '../../shared/types'
import {
  bytesEqual,
  decodeText,
  decodeTimeIso,
  decodeUuid,
  encodeText,
  encodeTime,
  historyCount,
  newUuidBytes,
} from './fields'

/** User-facing reasons a record opens read-only (§A3). */
export const RecordReadOnlyReason = {
  protected: 'This entry is protected in Password Safe. Unprotect it there to edit it.',
  alias: 'This entry is an alias of another entry. Aliases are read-only in this version.',
  shortcut: 'This entry is a shortcut to another entry. Shortcuts are read-only in this version.',
  missingField: (names: string) =>
    `This entry is missing a required field (${names}), so it is read-only to avoid losing data.`,
  duplicateField: (names: string) =>
    `This entry has more than one ${names} field, so it is read-only to avoid losing data.`,
  invalidText: (names: string) =>
    `This entry's ${names} is not valid text, so it is read-only to avoid losing data.`,
} as const

/** Types shown in the v1 UI (§A3 rows 1 and 2). Anything else counts as an extra field. */
const SHOWN_TYPES = new Set<number>([
  FieldType.UUID,
  FieldType.GROUP,
  FieldType.TITLE,
  FieldType.USERNAME,
  FieldType.NOTES,
  FieldType.PASSWORD,
  FieldType.URL,
  FieldType.EMAIL,
  FieldType.CREATION_TIME,
  FieldType.PASSWORD_MOD_TIME,
  FieldType.LAST_ACCESS_TIME,
  FieldType.PASSWORD_EXPIRY_TIME,
  FieldType.LAST_MOD_TIME,
])

/** Editable text fields and UUID: a duplicate of any of these makes the record read-only. */
const UNIQUE_TYPES: readonly number[] = [FieldType.UUID, ...EDITABLE_FIELD_TYPES]

const FIELD_NAMES: Record<number, string> = {
  [FieldType.UUID]: 'UUID',
  [FieldType.GROUP]: 'group',
  [FieldType.TITLE]: 'title',
  [FieldType.USERNAME]: 'username',
  [FieldType.NOTES]: 'notes',
  [FieldType.PASSWORD]: 'password',
  [FieldType.URL]: 'URL',
  [FieldType.EMAIL]: 'email',
}

const ALIAS_RE = /^\[\[([0-9a-fA-F]{32})\]\]$/
const SHORTCUT_RE = /^\[~([0-9a-fA-F]{32})~\]$/

function first(record: RawRecord, type: number): RawField | undefined {
  return record.fields.find((f) => f.type === type)
}

function count(record: RawRecord, type: number): number {
  let n = 0
  for (const f of record.fields) if (f.type === type) n++
  return n
}

function hasNonEmpty(record: RawRecord, lo: number, hi = lo): boolean {
  return record.fields.some((f) => f.type >= lo && f.type <= hi && f.data.length > 0)
}

/** The record's UUID as 32 lowercase hex digits, or undefined when absent or malformed. */
export function recordUuid(record: RawRecord): string | undefined {
  const f = first(record, FieldType.UUID)
  return f ? decodeUuid(f.data) : undefined
}

interface Link {
  kind: 'alias' | 'shortcut'
  base: string
}

/** Alias/shortcut target named by the password, before checking that the base exists. */
function linkOf(record: RawRecord): Link | undefined {
  const pw = first(record, FieldType.PASSWORD)
  if (!pw || count(record, FieldType.PASSWORD) !== 1) return undefined
  const text = decodeText(pw.data)
  if (text === undefined) return undefined
  const a = ALIAS_RE.exec(text)
  if (a) return { kind: 'alias', base: a[1]!.toLowerCase() }
  const s = SHORTCUT_RE.exec(text)
  if (s) return { kind: 'shortcut', base: s[1]!.toLowerCase() }
  return undefined
}

/** Lookup tables over all records of a file, needed to classify aliases and shortcuts. */
export interface RecordIndex {
  /** First record with each UUID. */
  byUuid: Map<string, RawRecord>
  /** Position of each record in the file. */
  position: Map<RawRecord, number>
  /** Resolved links: dependant record -> base UUID and kind (only when the base exists). */
  links: Map<RawRecord, Link>
  /** Base UUID -> dependant kinds present. */
  dependants: Map<string, { aliases: number; shortcuts: number }>
}

export function indexRecords(records: readonly RawRecord[]): RecordIndex {
  const byUuid = new Map<string, RawRecord>()
  const position = new Map<RawRecord, number>()
  records.forEach((r, i) => {
    position.set(r, i)
    const u = recordUuid(r)
    if (u !== undefined && !byUuid.has(u)) byUuid.set(u, r)
  })
  const links = new Map<RawRecord, Link>()
  const dependants = new Map<string, { aliases: number; shortcuts: number }>()
  for (const r of records) {
    const link = linkOf(r)
    // Spec §3.3 [3], [4]: if the base is not in the file this is just an unusual password.
    if (!link || !byUuid.has(link.base) || link.base === recordUuid(r)) continue
    links.set(r, link)
    const d = dependants.get(link.base) ?? { aliases: 0, shortcuts: 0 }
    if (link.kind === 'alias') d.aliases++
    else d.shortcuts++
    dependants.set(link.base, d)
  }
  return { byUuid, position, links, dependants }
}

function kindOf(record: RawRecord, index: RecordIndex): EntryKind {
  const link = index.links.get(record)
  if (link) return link.kind
  const u = recordUuid(record)
  const d = u === undefined ? undefined : index.dependants.get(u)
  if (d && d.aliases > 0) return 'aliasBase'
  if (d && d.shortcuts > 0) return 'shortcutBase'
  return 'normal'
}

/** Why the record must stay read-only, or undefined when it may be edited (§A3). */
export function readOnlyReasonOf(record: RawRecord, index: RecordIndex): string | undefined {
  if (record.fields.some((f) => f.type === FieldType.PROTECTED && f.data.some((b) => b !== 0))) {
    return RecordReadOnlyReason.protected
  }
  const missing: string[] = []
  if (recordUuid(record) === undefined) missing.push('UUID')
  if (!first(record, FieldType.TITLE)) missing.push('title')
  if (!first(record, FieldType.PASSWORD)) missing.push('password')
  if (missing.length > 0) return RecordReadOnlyReason.missingField(missing.join(', '))
  const dups = UNIQUE_TYPES.filter((t) => count(record, t) > 1).map((t) => FIELD_NAMES[t]!)
  if (dups.length > 0) return RecordReadOnlyReason.duplicateField(dups.join(', '))
  const bad = EDITABLE_FIELD_TYPES.filter((t) =>
    record.fields.some((f) => f.type === t && decodeText(f.data) === undefined),
  ).map((t) => FIELD_NAMES[t]!)
  if (bad.length > 0) return RecordReadOnlyReason.invalidText(bad.join(', '))
  const link = index.links.get(record)
  if (link?.kind === 'alias') return RecordReadOnlyReason.alias
  if (link?.kind === 'shortcut') return RecordReadOnlyReason.shortcut
  return undefined
}

function textOf(record: RawRecord, type: number): string {
  const f = first(record, type)
  if (!f) return ''
  // Invalid UTF-8 is shown with replacement characters; such a record is read-only.
  return decodeText(f.data) ?? new TextDecoder('utf-8').decode(f.data)
}

function timeOf(record: RawRecord, type: number): string | undefined {
  const f = first(record, type)
  return f ? decodeTimeIso(f.data) : undefined
}

function flagsOf(record: RawRecord): EntryFlags {
  const seen = new Set<number>()
  let extra = 0
  for (const f of record.fields) {
    if (!SHOWN_TYPES.has(f.type) || seen.has(f.type)) extra++
    seen.add(f.type)
  }
  const hist = first(record, FieldType.PASSWORD_HISTORY)
  const histN = hist ? historyCount(hist.data) : undefined
  return {
    hasHistory: hist !== undefined && hist.data.length > 0 && (histN === undefined || histN > 0),
    hasTotp: hasNonEmpty(record, FieldType.TWO_FACTOR_KEY),
    hasAttachment: hasNonEmpty(record, FieldType.ATT_TITLE, FieldType.ATT_CONTENT),
    hasPasskey: hasNonEmpty(record, FieldType.PASSKEY_CREDENTIAL_ID, FieldType.PASSKEY_SIGN_COUNT),
    hasCreditCard: hasNonEmpty(record, FieldType.CREDIT_CARD_NUMBER, FieldType.CREDIT_CARD_PIN),
    hasCustomFields: hasNonEmpty(record, FieldType.CUSTOM_TEXT),
    extraFieldCount: extra,
  }
}

export interface BuildEntryOptions {
  /**
   * Fill `password` with the record's own password. Off by default: lists sent to the renderer
   * carry '' (§A4.8). For aliases use `resolvePassword` to get the base's password.
   */
  includePassword?: boolean
}

/**
 * Builds the Entry view for one record. `uuid` is the record's UUID as 32 lowercase hex digits; a
 * record without a valid UUID gets the placeholder `#<position>` (it is read-only anyway).
 */
export function buildEntry(
  record: RawRecord,
  index: RecordIndex,
  options: BuildEntryOptions = {},
): Entry {
  const uuid = recordUuid(record) ?? `#${index.position.get(record) ?? -1}`
  const reason = readOnlyReasonOf(record, index)
  const link = index.links.get(record)
  const entry: Entry = {
    uuid,
    title: textOf(record, FieldType.TITLE),
    group: textOf(record, FieldType.GROUP),
    username: textOf(record, FieldType.USERNAME),
    password: options.includePassword ? textOf(record, FieldType.PASSWORD) : '',
    url: textOf(record, FieldType.URL),
    email: textOf(record, FieldType.EMAIL),
    notes: textOf(record, FieldType.NOTES),
    kind: kindOf(record, index),
    flags: flagsOf(record),
    editable: reason === undefined,
  }
  const created = timeOf(record, FieldType.CREATION_TIME)
  const modified = timeOf(record, FieldType.LAST_MOD_TIME)
  const pwModified = timeOf(record, FieldType.PASSWORD_MOD_TIME)
  const expires = timeOf(record, FieldType.PASSWORD_EXPIRY_TIME)
  if (created) entry.created = created
  if (modified) entry.modified = modified
  if (pwModified) entry.passwordModified = pwModified
  if (expires) entry.expires = expires
  if (link) entry.baseUuid = link.base
  if (reason !== undefined) entry.readOnlyReason = reason
  return entry
}

/** Entry views for every record, in file order. */
export function buildEntries(
  records: readonly RawRecord[],
  options: BuildEntryOptions = {},
): Entry[] {
  const index = indexRecords(records)
  return records.map((r) => buildEntry(r, index, options))
}

/**
 * The password a copy or reveal should use: the base entry's password for aliases and shortcuts
 * (§A3), otherwise the record's own. Undefined when the value is not valid text.
 */
export function resolvePassword(record: RawRecord, index: RecordIndex): string | undefined {
  const link = index.links.get(record)
  const source = link ? index.byUuid.get(link.base)! : record
  const f = first(source, FieldType.PASSWORD)
  return f ? decodeText(f.data) : ''
}

/** Deleting this record would orphan aliases or shortcuts (§A3: delete is blocked). */
export function hasDependants(record: RawRecord, index: RecordIndex): boolean {
  const u = recordUuid(record)
  return u !== undefined && index.dependants.has(u) && index.byUuid.get(u) === record
}

const DRAFT_FIELDS: readonly [keyof EntryDraft, number][] = [
  ['group', FieldType.GROUP],
  ['title', FieldType.TITLE],
  ['username', FieldType.USERNAME],
  ['notes', FieldType.NOTES],
  ['password', FieldType.PASSWORD],
  ['url', FieldType.URL],
  ['email', FieldType.EMAIL],
]

export interface ApplyDraftOptions {
  /** Edit time in seconds since the epoch, written to 0x0c (and 0x08 when the password changes). */
  now: number
}

function setOrAppend(fields: RawField[], type: number, data: Uint8Array): void {
  const i = fields.findIndex((f) => f.type === type)
  if (i >= 0) fields[i] = { type, data }
  else fields.push({ type, data })
}

/**
 * Applies an edit to an existing record and returns the new record; the input is not modified.
 * Only the draft's editable fields change: an edited field is replaced in place, a newly set field
 * is appended (before the implicit END), and an unchanged value keeps its original bytes. When
 * anything changed, last-modified 0x0c is set (and password-modified 0x08 if the password changed).
 * Every other field keeps its bytes and position. Returns the same object when nothing changed.
 */
export function applyDraft(
  record: RawRecord,
  draft: EntryDraft,
  index: RecordIndex,
  options: ApplyDraftOptions,
): Result<RawRecord> {
  const uuid = recordUuid(record)
  if (draft.uuid !== undefined && draft.uuid.toLowerCase() !== uuid) {
    return fail(ErrorCode.INVALID_ARGUMENT, DEFAULT_MESSAGES.INVALID_ARGUMENT, 'uuid mismatch')
  }
  const reason = readOnlyReasonOf(record, index)
  if (reason !== undefined) {
    return fail(ErrorCode.RECORD_READ_ONLY, DEFAULT_MESSAGES.RECORD_READ_ONLY, reason)
  }
  const fields = record.fields.slice()
  let changed = false
  let passwordChanged = false
  for (const [key, type] of DRAFT_FIELDS) {
    const value = draft[key]
    if (value === undefined) continue
    const data = encodeText(value)
    const i = fields.findIndex((f) => f.type === type)
    if (i >= 0) {
      if (bytesEqual(fields[i]!.data, data)) continue
      fields[i] = { type, data }
    } else {
      // An absent field already means "empty" (spec §2.9.2); do not add an empty one.
      if (data.length === 0) continue
      fields.push({ type, data })
    }
    changed = true
    if (type === FieldType.PASSWORD) passwordChanged = true
  }
  if (!changed) return ok(record)
  if (passwordChanged) setOrAppend(fields, FieldType.PASSWORD_MOD_TIME, encodeTime(options.now))
  setOrAppend(fields, FieldType.LAST_MOD_TIME, encodeTime(options.now))
  return ok({ fields })
}

export interface CreateRecordOptions extends ApplyDraftOptions {
  randomBytes: (n: number) => Uint8Array
}

/**
 * Builds a new record from a draft without a uuid: UUID, Title and Password (mandatory, written
 * even when empty), then the other non-empty fields, creation and modification times.
 */
export function createRecord(draft: EntryDraft, options: CreateRecordOptions): Result<RawRecord> {
  if (draft.uuid !== undefined) {
    return fail(
      ErrorCode.INVALID_ARGUMENT,
      DEFAULT_MESSAGES.INVALID_ARGUMENT,
      'new entry has a uuid',
    )
  }
  const now = encodeTime(options.now)
  const fields: RawField[] = [
    { type: FieldType.UUID, data: newUuidBytes(options.randomBytes) },
    { type: FieldType.TITLE, data: encodeText(draft.title ?? '') },
    { type: FieldType.PASSWORD, data: encodeText(draft.password ?? '') },
  ]
  for (const [key, type] of DRAFT_FIELDS) {
    if (type === FieldType.TITLE || type === FieldType.PASSWORD) continue
    const value = draft[key]
    if (value) fields.push({ type, data: encodeText(value) })
  }
  fields.push({ type: FieldType.CREATION_TIME, data: now })
  fields.push({ type: FieldType.PASSWORD_MOD_TIME, data: now.slice() })
  fields.push({ type: FieldType.LAST_MOD_TIME, data: now.slice() })
  return ok({ fields })
}
