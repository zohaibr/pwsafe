// The 8 pypwsafe test safes (made by other Password Safe V3 implementations), fetched at test time by
// `npm run fixtures:pypwsafe` and never committed. CI fetches them before `npm test`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTwofish } from '../crypto/twofish/twofish'
import { ErrorCode, type Result } from '../../shared/errors'
import { MIN_ITERATIONS_WRITE } from '../../shared/limits'
import { FieldType } from '../../shared/types'
import { decode, encode } from './codec'
import { SAVE_METADATA_HEADER_TYPES, stampHeaderForSave } from './header'
import { PYPWSAFE_DIR, PYPWSAFE_FILES, PYPWSAFE_PASSWORD, hasPypwsafe } from './testing/fixtures'
import { syncStretch } from './testing/files'
import { buildEntries } from './views'

const password = new TextEncoder().encode(PYPWSAFE_PASSWORD)
const deps = { cipherFactory: createTwofish }
const fastDeps = { cipherFactory: createTwofish, stretch: syncStretch }
const read = (f: string) => new Uint8Array(readFileSync(join(PYPWSAFE_DIR, f)))

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}

// Entry counts and formats as listed in test/fixtures/PROVENANCE.md (checked with pwsafe-cli).
const EXPECTED: Record<string, { entries: number; format: number }> = {
  'EmptyGroupTest.psafe3': { entries: 9, format: 0x030b },
  'LastSaveUserTest.psafe3': { entries: 9, format: 0x030b },
  'NonDefaultPrefsTest.psafe3': { entries: 9, format: 0x030b },
  'RecentEntriesTest.psafe3': { entries: 9, format: 0x030b },
  'VersionTest.psafe3': { entries: 9, format: 0x030b },
  'passwordPolicyTest.psafe3': { entries: 4, format: 0x030b },
  'simple.psafe3': { entries: 9, format: 0x0309 },
  'unknown-record-prop-1.psafe3': { entries: 1, format: 0x0309 },
}

describe.skipIf(!hasPypwsafe)('pypwsafe fixtures', () => {
  it.each(PYPWSAFE_FILES)('%s opens with the expected entry count and format', async (f) => {
    const v = unwrap(await decode(read(f), password, fastDeps))
    expect(v.records).toHaveLength(EXPECTED[f]!.entries)
    expect(v.meta).toEqual({ iterations: 2_048, formatVersion: EXPECTED[f]!.format })
    const entries = buildEntries(v.records)
    for (const e of entries) {
      expect(e.uuid).toMatch(/^[0-9a-f]{32}$/)
      expect(e.title.length).toBeGreaterThan(0)
    }
  })

  it.each(PYPWSAFE_FILES)(
    '%s: decode → encode → decode keeps every field (self-consistency, §A2)',
    async (f) => {
      const first = unwrap(await decode(read(f), password, fastDeps))
      // Exactly as read: header and records identical byte-for-byte.
      const plain = unwrap(
        await encode(first, password, deps, { iterations: first.meta.iterations }),
      )
      const again = unwrap(await decode(plain, password, deps))
      expect(again.header).toEqual(first.header)
      expect(again.records).toEqual(first.records)
      expect(again.meta.iterations).toBe(MIN_ITERATIONS_WRITE)

      // As a save would do it: only the save-metadata header fields may differ.
      const stamped = stampHeaderForSave(first.header, {
        now: 1_800_000_000,
        application: 'psafe3 Opener V0.1.0',
        user: 'tester',
        host: 'test-host',
      })
      const saved = unwrap(
        await encode({ header: stamped, records: first.records }, password, fastDeps),
      )
      const reopened = unwrap(await decode(saved, password, fastDeps))
      const strip = (h: typeof first.header) =>
        h.filter((x) => !SAVE_METADATA_HEADER_TYPES.includes(x.type))
      expect(strip(reopened.header)).toEqual(strip(first.header))
      expect(reopened.records).toEqual(first.records)
    },
    30_000,
  )

  it('simple.psafe3 truncated at every block boundary is CORRUPT_FILE', async () => {
    const f = read('simple.psafe3')
    for (let len = f.length - 16; len > 0; len -= 16) {
      const r = await decode(f.slice(0, len), password, fastDeps)
      expect(r.ok ? 'ok' : r.error.code, `length ${len}`).toBe(ErrorCode.CORRUPT_FILE)
    }
  })

  it('wrong password is WRONG_PASSWORD', async () => {
    const r = await decode(read('simple.psafe3'), new TextEncoder().encode('bogus1234'), fastDeps)
    expect(r.ok ? 'ok' : r.error.code).toBe(ErrorCode.WRONG_PASSWORD)
  })

  it('the protected entry in simple.psafe3 is read-only (§A3)', async () => {
    const v = unwrap(await decode(read('simple.psafe3'), password, fastDeps))
    const entries = buildEntries(v.records)
    const protectedRecords = v.records.filter((r) =>
      r.fields.some((x) => x.type === FieldType.PROTECTED && x.data.some((b) => b !== 0)),
    )
    expect(protectedRecords.length).toBeGreaterThan(0)
    for (const e of entries) {
      const rec = v.records[entries.indexOf(e)]!
      expect(e.editable).toBe(!protectedRecords.includes(rec))
    }
  })
})
