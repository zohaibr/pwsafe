// A7 export test data (docs/execution-plan.md §A7 "Tests"). Test-only; not used by the app.
// Every expected value is written out literally here; the RawRecords are built from it by
// straightforward encoding, independent of the export code.
import { FieldType, HeaderFieldType } from '../../shared/types'
import type { RawField, RawRecord } from '../../shared/types'

export interface ExpectedEntry {
  uuid: string
  group?: string
  title: string
  username?: string
  password: string
  url?: string
  email?: string
  notes?: string
  /** Seconds since the epoch. */
  ctime?: number
  pmtime?: number
  atime?: number
  xtime?: number
  rmtime?: number
  /** Extra raw fields with no XML equivalent (count toward entriesWithOmittedFields). */
  extra?: RawField[]
  /** Write these text fields even when empty (a present-but-empty field). */
  keepEmpty?: boolean
}

const enc = new TextEncoder()

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
}

function time32(seconds: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, seconds, true)
  return b
}

export function toRecord(e: ExpectedEntry): RawRecord {
  const fields: RawField[] = [{ type: FieldType.UUID, data: hexToBytes(e.uuid) }]
  const text = (type: number, v: string | undefined) => {
    if (v !== undefined && (v !== '' || e.keepEmpty)) fields.push({ type, data: enc.encode(v) })
  }
  text(FieldType.GROUP, e.group)
  fields.push({ type: FieldType.TITLE, data: enc.encode(e.title) })
  text(FieldType.USERNAME, e.username)
  text(FieldType.NOTES, e.notes)
  fields.push({ type: FieldType.PASSWORD, data: enc.encode(e.password) })
  const time = (type: number, v: number | undefined) => {
    if (v !== undefined) fields.push({ type, data: time32(v) })
  }
  time(FieldType.CREATION_TIME, e.ctime)
  time(FieldType.PASSWORD_MOD_TIME, e.pmtime)
  time(FieldType.LAST_ACCESS_TIME, e.atime)
  time(FieldType.PASSWORD_EXPIRY_TIME, e.xtime)
  time(FieldType.LAST_MOD_TIME, e.rmtime)
  text(FieldType.URL, e.url)
  text(FieldType.EMAIL, e.email)
  fields.push(...(e.extra ?? []))
  return { fields }
}

export const HEADER: RawField[] = [
  { type: HeaderFieldType.VERSION, data: Uint8Array.of(0x11, 0x03) },
  { type: HeaderFieldType.UUID, data: hexToBytes('0123456789abcdef0123456789abcdef') },
  { type: HeaderFieldType.LAST_SAVE_TIME, data: time32(1_750_000_000) },
]

const LONG_PASSWORD = 'Lp0!'.repeat(2_500) // 10,000 chars
const LONG_NOTES = Array.from({ length: 2_000 }, (_, i) => `note line ${i} ${'x'.repeat(40)}`).join(
  '\r\n',
)
const LONG_URL = `https://example.com/${'path/'.repeat(1_000)}`

export const ENTRIES: ExpectedEntry[] = [
  {
    uuid: '00000000000000000000000000000001',
    group: 'Specials',
    title: `Specials & <tags> "quoted" 'single'`,
    username: 'a&b<c>d"e\'f',
    password: `p&<>"'q`,
    url: 'https://example.com/?a=1&b=<2>',
    email: 'x&y@example.com',
    notes: `& < > " ' &amp; &#13; <![CDATA[ not markup ]]>`,
  },
  {
    uuid: '00000000000000000000000000000002',
    group: 'Specials',
    title: 'CDATA ]]> inside',
    username: ']]',
    password: ']]>',
    url: 'https://example.com/x]]>y',
    notes: 'start]]>mid]]]]>>end]]',
  },
  {
    uuid: '00000000000000000000000000000003',
    group: 'Notes',
    title: 'Multiline CRLF',
    password: 'pw-multiline-1',
    notes: 'line one\r\nline two\r\n\r\nline four',
  },
  {
    uuid: '00000000000000000000000000000004',
    group: 'Notes',
    title: 'Multiline LF',
    password: 'pw-multiline-2',
    notes: 'first\nsecond',
  },
  {
    uuid: '00000000000000000000000000000005',
    group: 'Empty',
    title: 'Empty fields present',
    username: '',
    password: '',
    url: '',
    email: '',
    notes: '',
    keepEmpty: true,
  },
  {
    uuid: '00000000000000000000000000000006',
    title: 'No optional fields',
    password: 'only-a-password',
  },
  {
    uuid: '00000000000000000000000000000007',
    group: 'a.b.c',
    title: 'Nested group',
    username: 'nested',
    password: 'pw-nested',
  },
  {
    uuid: '00000000000000000000000000000008',
    group: 'a.b',
    title: 'Parent group',
    password: 'pw-parent',
  },
  {
    // Password Safe's group rule: a run of dots ends an element and the extra dots stay in it,
    // so this is element "Home." with child "Office".
    uuid: '00000000000000000000000000000009',
    group: 'Home..Office',
    title: 'Literal dot in group',
    password: 'pw-dot',
  },
  {
    uuid: '0000000000000000000000000000000a',
    group: 'Intl',
    title: 'Café Zürich 東京 🔐',
    username: 'jürgen',
    password: 'pässwörd🔑',
    url: 'https://例え.jp/パス',
    email: 'jörg@exämple.de',
    notes: 'Ünïcödé 😀 and ÅÄÖ',
  },
  {
    uuid: '0000000000000000000000000000000b',
    group: 'Long',
    title: 'Very long values',
    username: 'u'.repeat(1_000),
    password: LONG_PASSWORD,
    url: LONG_URL,
    notes: LONG_NOTES,
  },
  {
    uuid: '0000000000000000000000000000000c',
    group: 'Banking',
    title: 'Example Bank',
    username: 'jordan smith',
    password: 'with spaces  and\ttab',
    url: 'https://bank.example.com',
    email: 'jordan@example.com',
    notes: 'Branch: Main St',
    ctime: 1_600_000_000,
    pmtime: 1_650_000_000,
    atime: 1_700_000_000,
    xtime: 1_900_000_000,
    rmtime: 1_710_000_000,
  },
  {
    // Alias of entry 7: exported in its stored [[uuid]] form (§A7).
    uuid: '0000000000000000000000000000000d',
    group: 'a.b.c',
    title: 'Alias of nested',
    password: '[[00000000000000000000000000000007]]',
  },
  {
    // Fields with no XML equivalent: an unknown 0xdf field and an attachment title.
    uuid: '0000000000000000000000000000000e',
    group: 'Omitted',
    title: 'Has unknown and attachment fields',
    password: 'pw-omitted',
    extra: [
      { type: 0xdf, data: Uint8Array.of(1, 2, 3) },
      { type: FieldType.ATT_TITLE, data: enc.encode('scan.pdf') },
    ],
  },
  {
    // Protected entry (read-only in the app) is still exported; the flag itself is not.
    uuid: '0000000000000000000000000000000f',
    group: 'Omitted',
    title: 'Protected entry',
    password: 'pw-protected',
    extra: [{ type: FieldType.PROTECTED, data: Uint8Array.of(1) }],
  },
]

/** Entries whose records carry fields the export leaves out. */
export const ENTRIES_WITH_OMITTED = 2

export function a7Records(): RawRecord[] {
  return ENTRIES.map(toRecord)
}

/** `count` simple entries for the 1,000-entry test. */
export function manyEntries(count: number): ExpectedEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    uuid: (0x1000 + i).toString(16).padStart(32, '0'),
    group: `Bulk.G${i % 10}`,
    title: `Bulk entry ${i}`,
    username: `user${i}`,
    password: `pw-${i}-<&>`,
    url: `https://example.com/${i}`,
    notes: `notes for ${i}\r\nsecond line`,
    ctime: 1_600_000_000 + i,
  }))
}
