// The committed pwsafe-cli fixtures decode to exactly their expected values, and survive an
// open -> save -> reopen with no edits (docs/execution-plan.md §A2.1, §A3). Runs on every OS; the
// oracle suite (test/oracle/) checks the same files against pwsafe-cli itself.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decode, encode } from '../../src/main/psafe3/codec'
import { SAVE_METADATA_HEADER_TYPES, stampHeaderForSave } from '../../src/main/psafe3/header'
import {
  FIXTURE_DIR,
  FIXTURE_NAMES,
  decodeFixture,
  deps,
  expectEntries,
  loadFixture,
  unwrap,
} from './support'

describe('committed fixtures', () => {
  it('exist, each with an expected-values JSON and a PROVENANCE.md row, under 1 MB in total', () => {
    expect(FIXTURE_NAMES).toEqual(['cli-add', 'cli-import', 'cli-links', 'cli-many'])
    const provenance = readFileSync(resolve(FIXTURE_DIR, '../PROVENANCE.md'), 'utf8')
    let total = 0
    for (const f of readdirSync(FIXTURE_DIR)) total += statSync(join(FIXTURE_DIR, f)).size
    expect(total).toBeLessThan(1024 * 1024)
    for (const name of FIXTURE_NAMES) {
      const f = loadFixture(name)
      expect(f.expected.file).toBe(`${name}.psafe3`)
      expect(f.expected.entries).toHaveLength(f.expected.entryCount)
      expect(provenance).toContain(`| \`${name}.psafe3\` |`)
    }
  })

  describe.each(FIXTURE_NAMES)('%s', (name) => {
    const f = loadFixture(name)

    it('decodes to the expected format, iterations and entry values', async () => {
      const v = await decodeFixture(f)
      expect(v.meta.formatVersion).toBe(parseInt(f.expected.formatVersion, 16))
      expect(v.meta.iterations).toBe(f.expected.iterations)
      expect(v.meta.readOnlyReason).toBeUndefined()
      expect(v.records).toHaveLength(f.expected.entryCount)
      expectEntries(v.records, f.expected.entries)
    })

    it('rejects a wrong password with WRONG_PASSWORD', async () => {
      const r = await decode(f.bytes, new TextEncoder().encode('not the password'), deps)
      expect(r.ok ? 'ok' : r.error.code).toBe('WRONG_PASSWORD')
    })

    it('no-edit round trip keeps every field byte-for-byte except the save metadata', async () => {
      const v = await decodeFixture(f)
      const header = stampHeaderForSave(v.header, { now: 1_900_000_000, application: 'wp8 test' })
      const out = unwrap(
        await encode({ header, records: v.records }, f.password, deps, {
          iterations: v.meta.iterations,
        }),
      )
      const back = unwrap(await decode(out, f.password, deps))
      expect(back.meta.iterations).toBe(f.expected.iterations)
      const strip = (h: typeof v.header) =>
        h.filter((x) => !SAVE_METADATA_HEADER_TYPES.includes(x.type))
      expect(strip(back.header)).toEqual(strip(v.header))
      expect(back.records).toEqual(v.records)
      expectEntries(back.records, f.expected.entries)
    })
  })
})
