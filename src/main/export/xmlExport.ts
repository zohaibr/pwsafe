// Password Safe XML export (docs/execution-plan.md §A7).
// Builds the XML text in memory from the vault's RawRecords. No file writing or dialogs here:
// the caller (WP7) shows the warning, picks the path and writes the file (temp + rename, 0600).
import { FieldType, HeaderFieldType } from '../../shared/types'
import type { ExportOptions, RawField, RawRecord } from '../../shared/types'
import { cdataContent, escapeAttribute, isXmlSafe } from './xmlEscape'

export interface XmlExportInput {
  /** Header fields in file order (Version, UUID, last save time, ...). */
  header: RawField[]
  records: RawRecord[]
  scope: ExportOptions['scope']
  /** Display name for the `Database` attribute, usually the file's basename. */
  databaseName?: string
  /** Export time for the `ExportTimeStamp` attribute. */
  exportedAt: Date
}

export interface XmlExportOutput {
  xml: string
  /** Entries written to the XML. */
  entryCount: number
  /** Exported entries that had at least one field that is not in the XML (§A7). */
  entriesWithOmittedFields: number
}

/** Text fields we export, with their XML element names, in Password Safe's element order. */
const TEXT_FIELDS: { type: number; element: string; required: boolean }[] = [
  { type: FieldType.GROUP, element: 'group', required: false },
  { type: FieldType.TITLE, element: 'title', required: true },
  { type: FieldType.USERNAME, element: 'username', required: false },
  { type: FieldType.PASSWORD, element: 'password', required: true },
  { type: FieldType.URL, element: 'url', required: false },
  { type: FieldType.NOTES, element: 'notes', required: false },
]

const TIME_FIELDS: { type: number; element: string }[] = [
  { type: FieldType.CREATION_TIME, element: 'ctimex' },
  { type: FieldType.LAST_ACCESS_TIME, element: 'atimex' },
  { type: FieldType.PASSWORD_EXPIRY_TIME, element: 'xtimex' },
  { type: FieldType.PASSWORD_MOD_TIME, element: 'pmtimex' },
  { type: FieldType.LAST_MOD_TIME, element: 'rmtimex' },
]

/** Every field type the export writes. Any other type in a record counts as omitted. */
const EXPORTED_TYPES = new Set<number>([
  FieldType.UUID,
  FieldType.EMAIL,
  ...TEXT_FIELDS.map((f) => f.type),
  ...TIME_FIELDS.map((f) => f.type),
])

/**
 * Candidates for the `delimiter` attribute, tried in order. Password Safe's importer turns the
 * delimiter back into a line break in notes and into '.' in titles, so we pick the first one
 * that appears in no exported title or notes. (pwsafe-cli exports with a space, which is why
 * titles with spaces come back with dots after a CLI round trip.)
 */
const DELIMITER_CANDIDATES = ['^', '~', '`', '|', '§', '¤', '¦', '¬']

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

interface PreparedEntry {
  text: Map<string, string>
  uuid?: string
  email?: string
  times: Map<string, string>
  omitted: boolean
}

/**
 * Builds Password Safe XML (validates against pwsafe.xsd from Password Safe 1.25.0) for the
 * records in `scope`. Read-only records are included; alias and shortcut passwords are written
 * in their stored `[[uuid]]` / `[~uuid~]` form.
 *
 * An entry counts toward `entriesWithOmittedFields` when any of its fields is not in the XML:
 * a type the export does not write (history, 2FA, attachments, policy, unknown types, ...),
 * a second copy of an exported type, or a value that cannot be represented (invalid UTF-8,
 * characters XML forbids, a malformed UUID or time). A mandatory title or password that
 * cannot be represented is written empty.
 */
export function buildXmlExport(input: XmlExportInput): XmlExportOutput {
  const selected = input.records.filter((r) => inScope(r, input.scope))
  const prepared = selected.map(prepareEntry)
  const delimiter = chooseDelimiter(prepared)

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<passwordsafe']
  lines.push(`delimiter="${escapeAttribute(delimiter)}"`)
  if (input.databaseName !== undefined && isXmlSafe(input.databaseName)) {
    lines.push(`Database="${escapeAttribute(input.databaseName)}"`)
  }
  lines.push(`ExportTimeStamp="${formatDateTime(input.exportedAt)}"`)
  for (const [name, value] of headerAttributes(input.header)) {
    lines.push(`${name}="${escapeAttribute(value)}"`)
  }
  lines.push('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"')
  lines.push('xsi:noNamespaceSchemaLocation="pwsafe.xsd">')
  lines.push('')

  let entriesWithOmittedFields = 0
  prepared.forEach((entry, i) => {
    if (entry.omitted) entriesWithOmittedFields++
    lines.push(`\t<entry id="${i + 1}">`)
    for (const f of TEXT_FIELDS) {
      let value = entry.text.get(f.element) ?? ''
      if (value === '' && !f.required) continue
      if (f.element === 'notes') value = value.replace(/\r\n|\r|\n/g, delimiter)
      lines.push(`\t\t<${f.element}>${cdataContent(value)}</${f.element}>`)
    }
    if (entry.uuid !== undefined) lines.push(`\t\t<uuid>${cdataContent(entry.uuid)}</uuid>`)
    for (const f of TIME_FIELDS) {
      const t = entry.times.get(f.element)
      if (t !== undefined) lines.push(`\t\t<${f.element}>${t}</${f.element}>`)
    }
    if (entry.email !== undefined && entry.email !== '') {
      lines.push(`\t\t<email>${cdataContent(entry.email)}</email>`)
    }
    lines.push('\t</entry>')
  })
  lines.push('', '</passwordsafe>', '')

  return {
    xml: lines.join('\n'),
    entryCount: prepared.length,
    entriesWithOmittedFields,
  }
}

function prepareEntry(record: RawRecord): PreparedEntry {
  const entry: PreparedEntry = { text: new Map(), times: new Map(), omitted: false }
  const seen = new Set<number>()
  for (const field of record.fields) {
    if (!EXPORTED_TYPES.has(field.type) || seen.has(field.type)) {
      entry.omitted = true
      continue
    }
    seen.add(field.type)
    if (field.type === FieldType.UUID) {
      if (field.data.length === 16) entry.uuid = toHex(field.data)
      else entry.omitted = true
      continue
    }
    const time = TIME_FIELDS.find((f) => f.type === field.type)
    if (time !== undefined) {
      const seconds = readTime(field.data)
      if (seconds === undefined) entry.omitted = true
      // Password Safe treats a zero time as "not set" and does not export it.
      else if (seconds !== 0)
        entry.times.set(time.element, formatDateTime(new Date(seconds * 1000)))
      continue
    }
    const text = decodeText(field.data)
    if (text === undefined) {
      entry.omitted = true
      continue
    }
    if (field.type === FieldType.EMAIL) {
      entry.email = text
      continue
    }
    const tf = TEXT_FIELDS.find((f) => f.type === field.type)
    if (tf !== undefined) entry.text.set(tf.element, text)
  }
  return entry
}

/** UTF-8 text that XML can carry, or undefined when the bytes can't be exported faithfully. */
function decodeText(data: Uint8Array): string | undefined {
  let text: string
  try {
    text = utf8.decode(data)
  } catch {
    return undefined
  }
  return isXmlSafe(text) ? text : undefined
}

/** Seconds since the epoch from a 4- or 8-byte little-endian time field, else undefined. */
function readTime(data: Uint8Array): number | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let seconds: number
  if (data.length === 4) seconds = view.getUint32(0, true)
  else if (data.length === 8) seconds = Number(view.getBigUint64(0, true))
  else return undefined
  // xs:dateTime as we write it needs a four-digit year.
  return seconds <= MAX_EXPORTABLE_SECONDS ? seconds : undefined
}

/** 9999-12-31T23:59:59Z */
const MAX_EXPORTABLE_SECONDS = 253_402_300_799

/** `YYYY-MM-DDTHH:MM:SSZ` in UTC (Password Safe's importer accepts the `Z` form). */
function formatDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function toHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
}

function chooseDelimiter(entries: PreparedEntry[]): string {
  const used = new Set<string>()
  for (const e of entries) {
    for (const key of ['title', 'notes']) {
      for (const c of e.text.get(key) ?? '') used.add(c)
    }
  }
  for (const c of DELIMITER_CANDIDATES) if (!used.has(c)) return c
  // Fall back to the Private Use Area, which real titles and notes almost never contain.
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
    const c = String.fromCharCode(cp)
    if (!used.has(c)) return c
  }
  // Unreachable in practice: every candidate above is in use. Any choice is then lossy.
  return '^'
}

/** Optional `<passwordsafe>` attributes taken from the header, when present and well-formed. */
function headerAttributes(header: RawField[]): [string, string][] {
  const first = (type: number) => header.find((f) => f.type === type)?.data
  const out: [string, string][] = []

  const version = first(HeaderFieldType.VERSION)
  if (version !== undefined && version.length === 2) {
    // Stored little-endian: minor byte first. 0x0311 is written "3.17", as Password Safe does.
    const minor = version[0] as number
    const major = version[1] as number
    out.push(['FromDatabaseFormat', `${major}.${String(minor).padStart(2, '0')}`])
  }

  const saved = first(HeaderFieldType.LAST_SAVE_TIME)
  if (saved !== undefined) {
    const seconds = readTime(saved)
    if (seconds !== undefined && seconds !== 0) {
      out.push(['WhenLastSaved', formatDateTime(new Date(seconds * 1000))])
    }
  }

  const uuid = first(HeaderFieldType.UUID)
  if (uuid !== undefined && uuid.length === 16) {
    const h = toHex(uuid)
    out.push([
      'Database_uuid',
      `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    ])
  }
  return out
}

/**
 * Scope test. For a group scope, the record's group must equal the path or lie beneath it.
 * Group elements are separated by '.', and a run of dots ends an element with the extra dots
 * kept in it (Password Safe's rule: "a..b" is the element "a." then "b"), so "a..b" is not
 * inside group "a" but is inside group "a.".
 */
export function inScope(record: RawRecord, scope: ExportOptions['scope']): boolean {
  if (scope.kind === 'all') return true
  const field = record.fields.find((f) => f.type === FieldType.GROUP)
  const group = field === undefined ? '' : decodeText(field.data)
  if (group === undefined) return false
  const path = scope.path
  if (path === '') return true
  if (group === path) return true
  return (
    group.startsWith(`${path}.`) && group.length > path.length + 1 && group[path.length + 1] !== '.'
  )
}
