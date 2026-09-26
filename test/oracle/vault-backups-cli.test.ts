// §A5 against the independent oracle: after three saves by our Vault on a real disk, pwsafe-cli
// 1.25.0 opens the saved database AND every backup generation (.bak, .bak2, .bak3) with the right
// password, and its XML export of each equals our model of that version (the records the vault
// held when that version was saved; the oldest generation is the fixture itself). Runs only when
// PWSAFE_CLI is set (the CI oracle job); not on Windows, where v1 never saves.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEntries } from '../../src/main/psafe3/views'
import type { RawRecord } from '../../src/shared/types'
import { FIXTURE_NAMES, actualEntries, loadFixture, unwrap } from '../integration/support'
import {
  WINDOWS,
  copyRecords,
  editRound,
  type EditState,
  newVault,
} from '../integration/vaultSupport'
import { cliExport, cliStdout, expectCliMatches, hasOracle, useUtcForCli } from './oracleSupport'

const enabled = hasOracle && !WINDOWS
const why = !hasOracle ? 'PWSAFE_CLI is not set' : 'Windows opens vaults read-only'

/** Opens a copy of the fixture, saves three times, and returns each version's records. */
async function threeSaves(dir: string, name: string) {
  const f = loadFixture(name)
  const file = `${name}.psafe3`
  copyFileSync(f.path, join(dir, file))
  const v = newVault()
  unwrap(await v.open(join(dir, file)))
  unwrap(await v.unlock(f.password))
  const versions: RawRecord[][] = [copyRecords(unwrap(v.getExportData()).records)]
  const state: EditState = {}
  for (let round = 1; round <= 3; round++) {
    await editRound(v, round, state)
    unwrap(await v.save())
    versions.push(copyRecords(unwrap(v.getExportData()).records))
  }
  unwrap(await v.close())
  // Newest first: the database, then .bak (one save back), .bak2, .bak3 (the fixture).
  const files = [file, `${file}.bak`, `${file}.bak2`, `${file}.bak3`]
  return { f, files, records: versions.reverse(), state }
}

describe.skipIf(!enabled)(
  `our saves and backup generations -> pwsafe-cli${enabled ? '' : ` (skipped: ${why})`}`,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp8-a5-oracle-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    useUtcForCli()

    // The CLI's XML export crashes on aliases and shortcuts (docs/references.md); cli-links is
    // checked through --print below.
    it.each(FIXTURE_NAMES.filter((n) => n !== 'cli-links'))(
      '%s: the database and each backup open in pwsafe-cli and export our model',
      async (name) => {
        const { f, files, records } = await threeSaves(dir, name)
        files.forEach((file, i) => {
          const exp = cliExport(dir, file, f.expected.password)
          expectCliMatches(exp, actualEntries(records[i]!, f.expected.entries))
        })
      },
      120_000,
    )

    it('cli-links: each generation opens in pwsafe-cli with the retitled entry of its save', async () => {
      const { f, files, records, state } = await threeSaves(dir, 'cli-links')
      files.forEach((file, i) => {
        const title = buildEntries(records[i]!).find((e) => e.uuid === state.target)!.title
        const out = cliStdout(
          dir,
          [file, `--search=${title}`, '--print=Title'],
          f.expected.password,
        )
        expect(out, `${file}`).toContain(`Title: ${title}\n`)
      })
    }, 120_000)
  },
)
