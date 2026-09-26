// §A2 independent oracle, direction 1: files made by pwsafe-cli 1.25.0 are opened by our codec and
// every decoded value equals what the CLI itself exports, and the expected-values JSON.
// Runs only when PWSAFE_CLI (and PWS_XMLDIR, for the importer) is set; the CI oracle job sets both.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FIXTURE_DIR,
  FIXTURE_NAMES,
  actualEntries,
  decodeFixture,
  expectEntries,
  loadFixture,
} from '../integration/support'
import {
  XSD_DIR,
  cliExport,
  cliStdout,
  expectCliMatches,
  expectNotesViaPrint,
  hasOracle,
  multiLine,
  useUtcForCli,
} from './oracleSupport'

const enabled = hasOracle && XSD_DIR !== ''
const why = !hasOracle ? 'PWSAFE_CLI is not set' : 'PWS_XMLDIR is not set'

describe.skipIf(!enabled)(
  `pwsafe-cli files -> our decoder${enabled ? '' : ` (skipped: ${why})`}`,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp8-cli-to-ours-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    useUtcForCli()

    // The CLI's export crashes on aliases and shortcuts (docs/references.md); cli-links is
    // checked through --print below.
    describe.each(FIXTURE_NAMES.filter((n) => n !== 'cli-links'))('%s', (name) => {
      const f = loadFixture(name)
      const file = `${name}.psafe3`

      it('every value we decode equals the CLI export of the same file', async () => {
        copyFileSync(f.path, join(dir, file))
        const ours = actualEntries((await decodeFixture(f)).records, f.expected.entries)
        const exp = cliExport(dir, file, f.expected.password)
        // Our decoded values, put through the same CLI view, equal the CLI's export.
        expectCliMatches(exp, ours)
        // And the CLI agrees with the expected-values JSON.
        expectCliMatches(exp, f.expected.entries)
      })

      it('multi-line notes match the CLI byte for byte (CRLF), via --print', async () => {
        const ours = (await decodeFixture(f)).records
        const ml = multiLine(actualEntries(ours, f.expected.entries))
        expect(ml).toEqual(multiLine(f.expected.entries))
        expectNotesViaPrint(dir, file, f.expected.password, ml.slice(0, 8))
      })
    })

    it('cli-links: aliases, shortcuts and their bases as the CLI prints them', async () => {
      const f = loadFixture('cli-links')
      copyFileSync(f.path, join(dir, 'cli-links.psafe3'))
      const ours = actualEntries((await decodeFixture(f)).records, f.expected.entries)
      const print = (title: string) =>
        cliStdout(
          dir,
          ['cli-links.psafe3', `--search=${title}`, '--print=Title,Username,Password'],
          f.expected.password,
        )
      for (const title of ['Alias base', 'Shortcut base', 'Plain']) {
        const e = ours.find((x) => x.title === title)!
        const out = print(title)
        expect(out).toContain(`Title: ${title}\n`)
        expect(out).toContain(`Password: ${e.password}\n`)
        if (e.username) expect(out).toContain(`Username: ${e.username}\n`)
      }
      // The CLI prints a linked entry's password as "[Alias]" / "[Shortcut]", which shows it
      // resolved the stored [[uuid]] / [~uuid~] to a base, as we do.
      expect(print('The alias')).toContain('Password: [Alias]\n')
      expect(print('The shortcut')).toContain('Password: [Shortcut]\n')
      expect(ours.find((x) => x.title === 'The alias')).toMatchObject({ kind: 'alias' })
      expect(ours.find((x) => x.title === 'The shortcut')).toMatchObject({ kind: 'shortcut' })
    })

    it('regenerating the fixtures with make-generated.mjs gives files we decode to the same values', async () => {
      const out = join(dir, 'regenerated')
      const res = spawnSync(
        process.execPath,
        [resolve(FIXTURE_DIR, '../make-generated.mjs'), out],
        {
          encoding: 'utf8',
          env: { ...process.env, MAKE_GENERATED_QUIET: '1' },
          timeout: 170_000,
        },
      )
      expect(res.status, res.stderr).toBe(0)
      // Only the UUIDs pwsafe-cli assigns on --add differ between runs.
      const anyUuid = (s: string) => s.replace(/[0-9a-f]{32}/g, '<uuid>')
      for (const name of FIXTURE_NAMES) {
        const fresh = loadFixture(name, out)
        const committed = readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8')
        const freshJson = readFileSync(join(out, `${name}.expected.json`), 'utf8')
        if (name === 'cli-import' || name === 'cli-many') expect(freshJson).toBe(committed)
        else expect(anyUuid(freshJson)).toBe(anyUuid(committed))
        const v = await decodeFixture(fresh)
        expect(v.meta.formatVersion).toBe(0x0311)
        expectEntries(v.records, fresh.expected.entries)
      }
    }, 180_000)
  },
)
