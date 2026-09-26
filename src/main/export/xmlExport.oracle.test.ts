// Oracle check for the XML export (docs/execution-plan.md §A7): our XML is imported with the
// pinned pwsafe-cli 1.25.0 into a new safe, exported back, and compared value by value.
// Runs only when PWSAFE_CLI and PWS_XMLDIR are set (the CI oracle job, or a local build).
// The passphrase goes to the CLI's stdin, never --passphrase. Exported XML stays in a temp
// directory and is never printed.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasOracle, ORACLE_CLI, runCli } from '../../../test/oracle/pwsafeCli'
import { buildXmlExport } from './xmlExport'
import {
  a7Records,
  ENTRIES,
  HEADER,
  manyEntries,
  toRecord,
  type ExpectedEntry,
} from './xmlExport.fixture'
import { parseExport } from './xmlExport.testutil'

const XSD_DIR = process.env['PWS_XMLDIR'] ?? ''
const enabled = hasOracle && XSD_DIR !== ''
const reason = !hasOracle ? 'PWSAFE_CLI is not set' : 'PWS_XMLDIR is not set'

const PASS = 'wp4-oracle-pass'

/** Extra record: a CR inside a password, written as &#13; between CDATA sections. */
const CR_ENTRY: ExpectedEntry = {
  uuid: '00000000000000000000000000000cc1',
  group: 'Specials',
  title: 'CR in password',
  password: 'before\rafter',
}

/**
 * Password Safe's XML importer skips any entry whose title or password is empty
 * (src/core/XML/XMLFileHandlers.cpp @ 1.25.0), so those cannot survive the round trip.
 */
const importable = (e: ExpectedEntry) => e.title !== '' && e.password !== ''

/** pwsafe-cli writes times in local time without a zone; the test runs the CLI with TZ=UTC. */
const cliTime = (s: number) => new Date(s * 1000).toISOString().slice(0, 19)

/**
 * What pwsafe-cli's own export of the imported entry must contain.
 * - Notes: the CLI exports with delimiter " ", so line breaks come back as single spaces
 *   (the real line breaks are checked separately with --print).
 * - Alias passwords: the importer links the alias to its base, and the CLI exports an alias as
 *   [[group:title:username]] of the base.
 * - A CR elsewhere: the CLI writes it raw inside CDATA, which any XML reader turns into LF
 *   (the CR itself is checked separately with --print).
 */
function cliExpected(e: ExpectedEntry): Record<string, string> {
  const lf = (s: string) => s.replace(/\r\n?/g, '\n')
  const out: Record<string, string> = { title: e.title, password: lf(e.password), uuid: e.uuid }
  if (e.group) out['group'] = e.group
  if (e.username) out['username'] = e.username
  if (e.url) out['url'] = e.url
  if (e.email) out['email'] = e.email
  if (e.notes) out['notes'] = e.notes.replace(/\r\n|\r|\n/g, ' ')
  if (e.ctime) out['ctimex'] = cliTime(e.ctime)
  if (e.pmtime) out['pmtimex'] = cliTime(e.pmtime)
  if (e.atime) out['atimex'] = cliTime(e.atime)
  if (e.xtime) out['xtimex'] = cliTime(e.xtime)
  if (e.rmtime) out['rmtimex'] = cliTime(e.rmtime)
  const alias = /^\[\[([0-9a-f]{32})\]\]$/.exec(e.password)
  if (alias) {
    const b = ENTRIES.find((x) => x.uuid === alias[1])!
    out['password'] = `[[${b.group ?? ''}:${b.title}:${b.username ?? ''}]]`
  }
  return out
}

/** Runs the CLI and returns stdout, which holds test data only and is never printed. */
function cliStdout(args: string[], cwd: string): { status: number | null; stdout: string } {
  const res = spawnSync(ORACLE_CLI, args, {
    cwd,
    input: `${PASS}\n`,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC', PWS_XMLDIR: XSD_DIR },
    timeout: 60_000,
  })
  return { status: res.status, stdout: res.stdout ?? '' }
}

describe.skipIf(!enabled)(
  `pwsafe-cli imports our XML${enabled ? '' : ` (skipped: ${reason})`}`,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp4-oracle-'))
    const savedTz = process.env['TZ']
    beforeAll(() => {
      // runCli passes process.env through; the CLI then writes times in UTC.
      process.env['TZ'] = 'UTC'
    })
    afterAll(() => {
      if (savedTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = savedTz
      rmSync(dir, { recursive: true, force: true })
    })

    /** Create a safe, import `xml`, export it back and parse the CLI's export. */
    function roundTrip(name: string, xml: string) {
      writeFileSync(join(dir, `${name}.xml`), xml, { mode: 0o600 })
      const created = runCli([`${name}.psafe3`, '--create'], [PASS, PASS], dir)
      expect(created.status, created.stderr).toBe(0)
      const imported = runCli([`${name}.psafe3`, `--import=${name}.xml`, '--xml'], [PASS], dir)
      expect(imported.status, imported.stderr).toBe(0)
      const exported = runCli([`${name}.psafe3`, `--export=${name}.back.xml`, '--xml'], [PASS], dir)
      expect(exported.status, exported.stderr).toBe(0)
      return parseExport(readFileSync(join(dir, `${name}.back.xml`), 'utf8'))
    }

    it('A7 test data: every importable entry comes back with the same values', () => {
      const entries = [...ENTRIES, CR_ENTRY]
      const out = buildXmlExport({
        header: HEADER,
        records: [...a7Records(), toRecord(CR_ENTRY)],
        scope: { kind: 'all' },
        databaseName: 'a7.psafe3',
        exportedAt: new Date(),
      })
      const back = roundTrip('a7', out.xml)
      const byUuid = new Map(back.entries.map((e) => [e['uuid'], e]))
      const expected = entries.filter(importable)
      expect(back.entries).toHaveLength(expected.length)
      for (const e of expected) {
        expect(byUuid.get(e.uuid), `entry ${e.uuid}`).toEqual(cliExpected(e))
      }
      // Titles with spaces keep their spaces: our delimiter is not a space (docs/references.md).
      expect(byUuid.get('0000000000000000000000000000000c')!['title']).toBe('Example Bank')
    })

    it('A7 test data: line breaks in notes are restored as CRLF', () => {
      // Needs the safe from the previous test.
      for (const [title, notes] of [
        ['Multiline CRLF', 'line one\r\nline two\r\n\r\nline four'],
        ['Multiline LF', 'first\r\nsecond'],
      ] as const) {
        const res = cliStdout(['a7.psafe3', `--search=${title}`, '--print=Notes'], dir)
        expect(res.status).toBe(0)
        expect(res.stdout.includes(`Notes: ${notes}\n`), `notes of ${title}`).toBe(true)
      }
    })

    it('A7 test data: a CR inside a password survives the import', () => {
      const res = cliStdout(['a7.psafe3', `--search=${CR_ENTRY.title}`, '--print=Password'], dir)
      expect(res.status).toBe(0)
      expect(res.stdout.includes(`Password: ${CR_ENTRY.password}\n`)).toBe(true)
    })

    it('1,000 entries all import with their values', () => {
      const entries = manyEntries(1_000)
      const out = buildXmlExport({
        header: HEADER,
        records: entries.map(toRecord),
        scope: { kind: 'all' },
        exportedAt: new Date(),
      })
      const back = roundTrip('many', out.xml)
      expect(back.entries).toHaveLength(1_000)
      const byUuid = new Map(back.entries.map((e) => [e['uuid'], e]))
      for (const e of entries) expect(byUuid.get(e.uuid)).toEqual(cliExpected(e))
    }, 120_000)
  },
)
