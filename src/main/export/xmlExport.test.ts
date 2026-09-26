// Tests for the Password Safe XML export (docs/execution-plan.md §A7, §D WP4).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FieldType } from '../../shared/types'
import type { RawRecord } from '../../shared/types'
import { buildXmlExport, inScope, type XmlExportInput } from './xmlExport'
import {
  a7Records,
  ENTRIES,
  ENTRIES_WITH_OMITTED,
  HEADER,
  manyEntries,
  toRecord,
  type ExpectedEntry,
} from './xmlExport.fixture'
import { cdataContent, escapeAttribute, isXmlSafe } from './xmlEscape'
import { parseExport } from './xmlExport.testutil'

const EXPORTED_AT = new Date(Date.UTC(2026, 8, 26, 12, 0, 0))
const enc = new TextEncoder()

function run(records: RawRecord[], extra: Partial<XmlExportInput> = {}) {
  return buildXmlExport({
    header: HEADER,
    records,
    scope: { kind: 'all' },
    databaseName: 'test.psafe3',
    exportedAt: EXPORTED_AT,
    ...extra,
  })
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z')

/** What an exported entry must contain, per ExpectedEntry, with notes line breaks as `delim`. */
function expectedElements(e: ExpectedEntry, delim: string): Record<string, string> {
  const out: Record<string, string> = { title: e.title, password: e.password, uuid: e.uuid }
  if (e.group) out['group'] = e.group
  if (e.username) out['username'] = e.username
  if (e.url) out['url'] = e.url
  if (e.email) out['email'] = e.email
  if (e.notes) out['notes'] = e.notes.replace(/\r\n|\r|\n/g, delim)
  if (e.ctime) out['ctimex'] = iso(e.ctime)
  if (e.pmtime) out['pmtimex'] = iso(e.pmtime)
  if (e.atime) out['atimex'] = iso(e.atime)
  if (e.xtime) out['xtimex'] = iso(e.xtime)
  if (e.rmtime) out['rmtimex'] = iso(e.rmtime)
  return out
}

// ---------------------------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------------------------

describe('xml escaping', () => {
  it('splits every ]]> across two CDATA sections', () => {
    expect(cdataContent('p]]>q')).toBe('<![CDATA[p]]]]><![CDATA[>q]]>')
    expect(cdataContent(']]>')).toBe('<![CDATA[]]]]><![CDATA[>]]>')
    expect(cdataContent('a]]>b]]>c')).toBe('<![CDATA[a]]]]><![CDATA[>b]]]]><![CDATA[>c]]>')
    expect(cdataContent(']]]]>>')).toBe('<![CDATA[]]]]]]><![CDATA[>>]]>')
    expect(cdataContent('')).toBe('<![CDATA[]]>')
  })

  it('writes CR as a character reference outside CDATA', () => {
    expect(cdataContent('a\rb')).toBe('<![CDATA[a]]>&#13;<![CDATA[b]]>')
    expect(cdataContent('a\r\nb')).toBe('<![CDATA[a]]>&#13;<![CDATA[\nb]]>')
  })

  it('escapes attribute values', () => {
    expect(escapeAttribute(`a&b<c>d"e'f\tg\nh\ri`)).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;f&#9;g&#10;h&#13;i',
    )
  })

  it('knows which characters XML 1.0 allows', () => {
    expect(isXmlSafe('tab\t lf\n cr\r é 東 😀 � ')).toBe(true)
    for (const bad of ['\u0000', '\u0001', '\u001f', '￾', '￿', '\uD800', '\uDC00']) {
      expect(isXmlSafe(`a${bad}b`), JSON.stringify(bad)).toBe(false)
    }
  })

  it('round-trips random strings built from dangerous pieces', () => {
    const pieces = [']]>', ']]', ']', '>', '<', '&', '\r', '\n', '\r\n', '"', "'", 'x', 'é', '😀']
    for (let i = 0; i < 2_000; i++) {
      let s = ''
      const n = Math.floor(Math.random() * 12)
      for (let j = 0; j < n; j++) s += pieces[Math.floor(Math.random() * pieces.length)]
      const xml = `<passwordsafe delimiter="^"><entry><password>${cdataContent(s)}</password></entry></passwordsafe>`
      expect(parseExport(xml).entries[0]!['password']).toBe(s)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// A7 test data
// ---------------------------------------------------------------------------------------------

describe('buildXmlExport with the A7 test data', () => {
  const out = run(a7Records())
  const parsed = parseExport(out.xml)
  const delim = parsed.attributes['delimiter']!

  it('counts entries and entries with omitted fields', () => {
    expect(out.entryCount).toBe(ENTRIES.length)
    expect(out.entriesWithOmittedFields).toBe(ENTRIES_WITH_OMITTED)
    expect(parsed.entries).toHaveLength(ENTRIES.length)
  })

  it('writes the root attributes', () => {
    expect(parsed.attributes).toMatchObject({
      delimiter: '^',
      Database: 'test.psafe3',
      ExportTimeStamp: '2026-09-26T12:00:00Z',
      FromDatabaseFormat: '3.17',
      WhenLastSaved: iso(1_750_000_000),
      Database_uuid: '01234567-89ab-cdef-0123-456789abcdef',
    })
    expect(out.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<passwordsafe\n')).toBe(true)
  })

  it.each(ENTRIES.map((e, i) => ({ i, title: e.title.slice(0, 40), e })))(
    'entry $i ($title) has exactly the expected values',
    ({ i, e }) => {
      expect(parsed.entries[i]).toEqual(expectedElements(e, delim))
    },
  )

  it('writes title and password even when empty, and skips other empty fields', () => {
    const empty = parsed.entries[4]!
    expect(empty).toEqual({
      group: 'Empty',
      title: 'Empty fields present',
      password: '',
      uuid: '00000000000000000000000000000005',
    })
  })

  it('never lets a value end a CDATA section early', () => {
    // Every "]]>" in the document is either a section end followed by a new section, a closing
    // tag or a reference; none is followed by stray text.
    for (const m of out.xml.matchAll(/]]>/g)) {
      const after = out.xml.slice(m.index + 3, m.index + 12)
      expect(/^(<!\[CDATA\[|<\/|&#13;)/.test(after), after).toBe(true)
    }
  })

  it('exports alias passwords in stored [[uuid]] form', () => {
    expect(parsed.entries[12]!['password']).toBe('[[00000000000000000000000000000007]]')
  })

  it('writes the literal-dot group exactly as stored', () => {
    expect(parsed.entries[8]!['group']).toBe('Home..Office')
  })
})

// ---------------------------------------------------------------------------------------------
// Delimiter, scope, omitted fields, header
// ---------------------------------------------------------------------------------------------

const base = (over: Partial<ExpectedEntry> = {}): ExpectedEntry => ({
  uuid: 'ffffffffffffffffffffffffffffff01',
  title: 'T',
  password: 'P',
  ...over,
})

describe('delimiter choice', () => {
  it('picks a character that appears in no exported title or notes', () => {
    const recs = [
      base({ title: 'a^b', notes: 'x~y\nz' }),
      base({ uuid: 'ffffffffffffffffffffffffffffff02', title: 'c`d', notes: '|' }),
    ].map(toRecord)
    const parsed = parseExport(run(recs).xml)
    expect(parsed.attributes['delimiter']).toBe('§')
    expect(parsed.entries[0]!['notes']).toBe('x~y§z')
  })

  it('ignores characters that only appear in other fields', () => {
    const recs = [base({ password: '^', username: '^', url: '^' })].map(toRecord)
    expect(parseExport(run(recs).xml).attributes['delimiter']).toBe('^')
  })

  it('falls back to the Private Use Area when every candidate is used', () => {
    const recs = [base({ title: '^~`|§¤¦¬' })].map(toRecord)
    expect(parseExport(run(recs).xml).attributes['delimiter']).toBe('')
  })

  it('turns CRLF, LF and lone CR in notes into the delimiter', () => {
    const recs = [base({ notes: 'a\r\nb\nc\rd' })].map(toRecord)
    expect(parseExport(run(recs).xml).entries[0]!['notes']).toBe('a^b^c^d')
  })
})

describe('scope', () => {
  const records = a7Records()
  const titlesIn = (path: string) =>
    run(records, { scope: { kind: 'group', path } }).entryCount === 0
      ? []
      : parseExport(run(records, { scope: { kind: 'group', path } }).xml).entries.map(
          (e) => e['title'],
        )

  it('exports a group with its subgroups', () => {
    expect(titlesIn('a.b')).toEqual(['Nested group', 'Parent group', 'Alias of nested'])
    expect(titlesIn('a')).toEqual(['Nested group', 'Parent group', 'Alias of nested'])
    expect(titlesIn('a.b.c')).toEqual(['Nested group', 'Alias of nested'])
    expect(titlesIn('Specials')).toEqual([ENTRIES[0]!.title, ENTRIES[1]!.title])
  })

  it('does not treat a name prefix as a parent group', () => {
    expect(titlesIn('a.b.c.d')).toEqual([])
    expect(titlesIn('Spec')).toEqual([])
  })

  it('follows the run-of-dots rule for literal dots', () => {
    expect(titlesIn('Home.')).toEqual(['Literal dot in group'])
    expect(titlesIn('Home..Office')).toEqual(['Literal dot in group'])
    expect(titlesIn('Home')).toEqual([])
  })

  it('includes read-only records and counts only the scope', () => {
    const out = run(records, { scope: { kind: 'group', path: 'Omitted' } })
    expect(out.entryCount).toBe(2)
    expect(out.entriesWithOmittedFields).toBe(2)
    expect(run(records, { scope: { kind: 'group', path: 'Nope' } })).toMatchObject({
      entryCount: 0,
      entriesWithOmittedFields: 0,
    })
  })

  it('treats an empty group path as everything and a missing group as the root', () => {
    expect(run(records, { scope: { kind: 'group', path: '' } }).entryCount).toBe(ENTRIES.length)
    const noGroup = toRecord(base())
    expect(inScope(noGroup, { kind: 'group', path: 'a' })).toBe(false)
  })

  it('an undecodable group is outside every group scope', () => {
    const r: RawRecord = { fields: [{ type: FieldType.GROUP, data: Uint8Array.of(0xff) }] }
    expect(inScope(r, { kind: 'group', path: 'a' })).toBe(false)
    expect(inScope(r, { kind: 'all' })).toBe(true)
  })
})

describe('fields that cannot be exported', () => {
  const withFields = (fields: { type: number; data: Uint8Array }[]) => {
    const r = toRecord(base())
    r.fields.push(...fields)
    return r
  }

  it('invalid UTF-8 in an optional field: field left out, entry counted', () => {
    const r = toRecord(base())
    r.fields.push({ type: FieldType.USERNAME, data: Uint8Array.of(0x61, 0xc3, 0x28) })
    const out = run([r])
    expect(out.entriesWithOmittedFields).toBe(1)
    expect(parseExport(out.xml).entries[0]!['username']).toBeUndefined()
  })

  it('a character XML forbids in a mandatory field: written empty, entry counted', () => {
    const r: RawRecord = {
      fields: [
        { type: FieldType.TITLE, data: enc.encode('ok') },
        { type: FieldType.PASSWORD, data: enc.encode('bad\u0001pw') },
      ],
    }
    const out = run([r])
    expect(out.entriesWithOmittedFields).toBe(1)
    expect(parseExport(out.xml).entries[0]).toEqual({ title: 'ok', password: '' })
    expect(out.xml).not.toContain('\u0001')
  })

  it('a record with no title or password still gets both elements', () => {
    const out = run([{ fields: [] }])
    expect(out.entriesWithOmittedFields).toBe(0)
    expect(parseExport(out.xml).entries[0]).toEqual({ title: '', password: '' })
  })

  it('a duplicate exported field: first one written, entry counted', () => {
    const out = run([withFields([{ type: FieldType.TITLE, data: enc.encode('second') }])])
    expect(out.entriesWithOmittedFields).toBe(1)
    expect(parseExport(out.xml).entries[0]!['title']).toBe('T')
  })

  it('fields without an XML equivalent are counted once per entry', () => {
    const out = run([
      withFields([
        { type: FieldType.PASSWORD_HISTORY, data: enc.encode('1ff00') },
        { type: FieldType.TWO_FACTOR_KEY, data: Uint8Array.of(1) },
        { type: 0xc0, data: new Uint8Array(0) },
      ]),
      toRecord(base({ uuid: 'ffffffffffffffffffffffffffffff02' })),
    ])
    expect(out).toMatchObject({ entryCount: 2, entriesWithOmittedFields: 1 })
  })

  it('a malformed UUID is left out and counted', () => {
    const out = run([{ fields: [{ type: FieldType.UUID, data: Uint8Array.of(1, 2, 3) }] }])
    expect(out.entriesWithOmittedFields).toBe(1)
    expect(parseExport(out.xml).entries[0]!['uuid']).toBeUndefined()
  })

  it('times: zero is "not set", 8-byte values work, other lengths are counted', () => {
    const t8 = new Uint8Array(8)
    new DataView(t8.buffer).setBigUint64(0, 1_700_000_000n, true)
    const out = run([
      withFields([
        { type: FieldType.CREATION_TIME, data: new Uint8Array(4) },
        { type: FieldType.LAST_MOD_TIME, data: t8 },
      ]),
      withFields([{ type: FieldType.CREATION_TIME, data: Uint8Array.of(1, 2, 3) }]),
    ])
    expect(out.entriesWithOmittedFields).toBe(1)
    const [a, b] = parseExport(out.xml).entries
    expect(a!['ctimex']).toBeUndefined()
    expect(a!['rmtimex']).toBe('2023-11-14T22:13:20Z')
    expect(b!['ctimex']).toBeUndefined()
  })

  it('a CR in a non-notes field survives as a character reference', () => {
    const out = run([toRecord(base({ password: 'a\rb\r\nc' }))])
    expect(out.entriesWithOmittedFields).toBe(0)
    expect(parseExport(out.xml).entries[0]!['password']).toBe('a\rb\r\nc')
  })
})

describe('header attributes', () => {
  it('are left out when missing or malformed', () => {
    const out = buildXmlExport({
      header: [
        { type: 0x00, data: Uint8Array.of(1) },
        { type: 0x01, data: Uint8Array.of(1, 2) },
        { type: 0x04, data: Uint8Array.of(1, 2, 3) },
      ],
      records: [],
      scope: { kind: 'all' },
      exportedAt: EXPORTED_AT,
    })
    expect(parseExport(out.xml).attributes).toEqual({
      delimiter: '^',
      ExportTimeStamp: '2026-09-26T12:00:00Z',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:noNamespaceSchemaLocation': 'pwsafe.xsd',
    })
    expect(out.entryCount).toBe(0)
  })

  it('escapes the database name and drops it when XML cannot carry it', () => {
    const named = run([], { databaseName: 'my "vault" & <co>.psafe3' })
    expect(named.xml).toContain('Database="my &quot;vault&quot; &amp; &lt;co&gt;.psafe3"')
    expect(parseExport(named.xml).attributes['Database']).toBe('my "vault" & <co>.psafe3')
    expect(run([], { databaseName: 'bad\u0000name' }).xml).not.toContain('Database=')
  })
})

describe('1,000 entries', () => {
  it('exports every entry with its values', () => {
    const entries = manyEntries(1_000)
    const out = run(entries.map(toRecord))
    expect(out).toMatchObject({ entryCount: 1_000, entriesWithOmittedFields: 0 })
    const parsed = parseExport(out.xml)
    expect(parsed.entries).toHaveLength(1_000)
    parsed.entries.forEach((e, i) => expect(e).toEqual(expectedElements(entries[i]!, '^')))
  })
})

// ---------------------------------------------------------------------------------------------
// Schema validation with xmllint against pwsafe.xsd from Password Safe 1.25.0 (§A7)
// ---------------------------------------------------------------------------------------------

const XSD_DIR = process.env['PWS_XMLDIR'] ?? ''
const hasXmllint = spawnSync('xmllint', ['--version']).error === undefined
const canValidate = XSD_DIR !== '' && hasXmllint
const skipReason = XSD_DIR === '' ? 'PWS_XMLDIR is not set' : 'xmllint is not installed'

describe.skipIf(!canValidate)(
  `pwsafe.xsd validation${canValidate ? '' : ` (skipped: ${skipReason})`}`,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp4-xsd-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    const validate = (name: string, xml: string) => {
      const file = join(dir, name)
      writeFileSync(file, xml, { mode: 0o600 })
      const res = spawnSync('xmllint', ['--noout', '--schema', join(XSD_DIR, 'pwsafe.xsd'), file], {
        encoding: 'utf8',
      })
      // Test data only; xmllint reports element names and line numbers, not values.
      expect(res.status, res.stderr).toBe(0)
      expect(res.stderr).toContain('validates')
    }

    it('the A7 test data validates', () => validate('a7.xml', run(a7Records()).xml))

    it('a group-scoped export validates', () =>
      validate('scoped.xml', run(a7Records(), { scope: { kind: 'group', path: 'a.b' } }).xml))

    it('1,000 entries validate', () =>
      validate('many.xml', run(manyEntries(1_000).map(toRecord)).xml))

    it('an export with no entries and no header validates', () =>
      validate(
        'empty.xml',
        buildXmlExport({ header: [], records: [], scope: { kind: 'all' }, exportedAt: EXPORTED_AT })
          .xml,
      ))

    it('records with unexportable and odd values validate', () => {
      const r = toRecord(base({ password: 'a\rb', title: '' }))
      r.fields.push(
        { type: FieldType.USERNAME, data: Uint8Array.of(0xff) },
        { type: FieldType.NOTES, data: enc.encode('bell\u0007') },
        { type: FieldType.CREATION_TIME, data: new Uint8Array(4) },
        { type: 0xdf, data: Uint8Array.of(1) },
      )
      validate('odd.xml', run([r, { fields: [] }], { databaseName: 'x\u0001' }).xml)
    })
  },
)
