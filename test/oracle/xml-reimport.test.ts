// §A7: our XML export of every committed pwsafe-cli fixture validates against pwsafe.xsd from
// Password Safe 1.25.0 (xmllint) and re-imports through pwsafe-cli with its values intact.
// Documented importer behaviour (docs/references.md) is accounted for: entries with an empty
// title or password are skipped (none in these fixtures), the CLI's own export writes line breaks
// in notes as spaces (the CRLFs are checked with --print), and the CLI cannot export a safe that
// holds aliases or shortcuts, so cli-links is checked with --print.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildXmlExport } from '../../src/main/export/xmlExport'
import { FIXTURE_NAMES, decodeFixture, loadFixture } from '../integration/support'
import {
  XSD_DIR,
  cliExport,
  cliOk,
  cliStdout,
  expectCliMatches,
  expectNotesViaPrint,
  hasOracle,
  multiLine,
  useUtcForCli,
} from './oracleSupport'

const hasXmllint = spawnSync('xmllint', ['--version']).error === undefined
const enabled = hasOracle && XSD_DIR !== '' && hasXmllint
const why = !hasOracle
  ? 'PWSAFE_CLI is not set'
  : XSD_DIR === ''
    ? 'PWS_XMLDIR is not set'
    : 'xmllint is not installed'

describe.skipIf(!enabled)(
  `our XML export re-imports through pwsafe-cli${enabled ? '' : ` (skipped: ${why})`}`,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp8-xml-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    useUtcForCli()

    describe.each(FIXTURE_NAMES)('%s', (name) => {
      const f = loadFixture(name)
      const pass = f.expected.password
      const xmlFile = `${name}.export.xml`
      const safe = `${name}.reimported.psafe3`

      it('validates against pwsafe.xsd and imports into a new safe', async () => {
        const v = await decodeFixture(f)
        const out = buildXmlExport({
          header: v.header,
          records: v.records,
          scope: { kind: 'all' },
          databaseName: `${name}.psafe3`,
          exportedAt: new Date(),
        })
        expect(out.entryCount).toBe(f.expected.entryCount)
        writeFileSync(join(dir, xmlFile), out.xml, { mode: 0o600 })
        const lint = spawnSync(
          'xmllint',
          ['--noout', '--schema', join(XSD_DIR, 'pwsafe.xsd'), xmlFile],
          {
            cwd: dir,
            encoding: 'utf8',
          },
        )
        // xmllint reports element names and line numbers, not values.
        expect(lint.status, lint.stderr).toBe(0)
        cliOk(dir, [safe, '--create'], pass, 2)
        cliOk(dir, [safe, `--import=${xmlFile}`, '--xml'], pass)
      })

      if (name === 'cli-links') {
        it('aliases and shortcuts are linked again by the importer', () => {
          const print = (title: string) =>
            cliStdout(dir, [safe, `--search=${title}`, '--print=Username,Password'], pass)
          expect(print('Alias base')).toContain('Password: alias-base-pw\n')
          expect(print('Shortcut base')).toContain('Username: sb\n')
          expect(print('The alias')).toContain('Password: [Alias]\n')
          expect(print('The shortcut')).toContain('Password: [Shortcut]\n')
        })
        return
      }

      it('the imported safe holds every value of the expected-values JSON', () => {
        const importable = f.expected.entries.filter((e) => e.title !== '' && e.password !== '')
        expect(importable).toHaveLength(f.expected.entries.length)
        expectCliMatches(cliExport(dir, safe, pass), importable)
        expectNotesViaPrint(dir, safe, pass, multiLine(importable).slice(0, 6))
      })
    })
  },
)
