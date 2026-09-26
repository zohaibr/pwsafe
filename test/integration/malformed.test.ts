// §A4 malformed-input corpus applied to the real pwsafe-cli fixtures (docs/execution-plan.md §A4,
// §D WP8). Every case must return the exact error code, never throw, and finish in < 2 s.
// WP2's codec tests cover the same cases on small synthetic files; here the damage is applied to
// every block and every field of files made by Password Safe itself.
import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BLOCK_SIZE } from '../../src/main/crypto/cipher'
import { createTwofish } from '../../src/main/crypto/twofish/twofish'
import { decode } from '../../src/main/psafe3/codec'
import { BODY_OFFSET, EOF_MARKER, ITER_OFFSET, TRAILER_BYTES } from '../../src/main/psafe3/format'
import type { StretchFn } from '../../src/main/psafe3/stretch'
import { ErrorCode } from '../../src/shared/errors'
import { MAX_ITERATIONS_READ } from '../../src/shared/limits'
import { FieldType, HeaderFieldType } from '../../src/shared/types'
import { FIXTURE_NAMES, decodeFixture, deps, loadFixture } from './support'
import {
  CASE_BUDGET_MS,
  type OpenedFixture,
  endFields,
  expectRejected,
  openFixture,
  rebuild,
  recomputeHmac,
} from './tamper'

const { CORRUPT_FILE, INTEGRITY_FAILED, UNSUPPORTED_FORMAT } = ErrorCode

// Each test loops over hundreds of cases (each held to CASE_BUDGET_MS); allow slow CI runners.
vi.setConfig({ testTimeout: 90_000 })

/**
 * Fixtures up to this many fields get every length bit of every field flipped; larger ones (cli-many)
 * get the first and last 40 fields, which include the header and the first and last records.
 */
const EXHAUSTIVE_LIMIT_FIELDS = 200

describe.each(FIXTURE_NAMES)('§A4 malformed input on %s', (name) => {
  const fixture = loadFixture(name)
  let o: OpenedFixture
  let bodyEnd: number

  beforeAll(async () => {
    o = await openFixture(fixture)
    bodyEnd = fixture.bytes.length - TRAILER_BYTES
  })

  it('a file rebuilt from the untouched stream decodes like the fixture (harness check)', async () => {
    const rebuilt = await rebuild(o, o.plain.slice())
    const a = await decodeFixture(fixture)
    const r = await decode(rebuilt, fixture.password, deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.records).toEqual(a.records)
    expect(recomputeHmac(o, o.plain)).toEqual(o.hmac)
  })

  it('truncated at every block boundary (and inside the trailer) is CORRUPT_FILE', async () => {
    const f = fixture.bytes
    for (let len = f.length - BLOCK_SIZE; len >= 0; len -= BLOCK_SIZE) {
      await expectRejected(o, f.slice(0, len), [CORRUPT_FILE], `truncated to ${len}`)
    }
    for (const cut of [1, 17, 31, 32, 33, 47]) {
      await expectRejected(o, f.slice(0, f.length - cut), [CORRUPT_FILE], `minus ${cut} bytes`)
    }
  })

  it('a length overflowing the buffer, at every field, is CORRUPT_FILE', async () => {
    for (const fld of o.fields) {
      const p = o.plain.slice()
      const remaining = p.length - fld.pos - 5
      new DataView(p.buffer).setUint32(fld.pos, remaining + 1, true)
      await expectRejected(o, await rebuild(o, p), [CORRUPT_FILE], `overflow at ${fld.pos}`)
    }
  })

  it('length 0xFFFFFFFF, at every field, is CORRUPT_FILE', async () => {
    for (const fld of o.fields) {
      const p = o.plain.slice()
      new DataView(p.buffer).setUint32(fld.pos, 0xffffffff, true)
      await expectRejected(o, await rebuild(o, p), [CORRUPT_FILE], `0xFFFFFFFF at ${fld.pos}`)
    }
  })

  it('missing END: the final END removed or turned into another type is CORRUPT_FILE', async () => {
    const last = endFields(o).at(-1)!
    expect(last.pos + BLOCK_SIZE).toBe(o.plain.length)
    await expectRejected(
      o,
      await rebuild(o, o.plain.slice(0, last.pos)),
      [CORRUPT_FILE],
      'END removed',
    )
    const p = o.plain.slice()
    p[last.pos + 4] = 0xee
    await expectRejected(o, await rebuild(o, p), [CORRUPT_FILE], 'END retyped')
  })

  it('every END block cut out of the ciphertext is CORRUPT_FILE or INTEGRITY_FAILED', async () => {
    // Removing a whole plaintext END (with the key) merges two records and is invisible to the V3
    // HMAC, which covers field data only (§A2.6). An attacker without the key can only cut
    // ciphertext, which garbles the following block; that must never open.
    for (const end of endFields(o)) {
      const at = BODY_OFFSET + end.pos
      const f = new Uint8Array(fixture.bytes.length - BLOCK_SIZE)
      f.set(fixture.bytes.subarray(0, at))
      f.set(fixture.bytes.subarray(at + BLOCK_SIZE), at)
      await expectRejected(o, f, [CORRUPT_FILE, INTEGRITY_FAILED], `END cut at ${end.pos}`)
    }
  })

  it('missing EOF (zeroed or removed) is CORRUPT_FILE', async () => {
    const zeroed = fixture.bytes.slice()
    zeroed.fill(0, bodyEnd, bodyEnd + BLOCK_SIZE)
    await expectRejected(o, zeroed, [CORRUPT_FILE], 'EOF zeroed')
    const removed = new Uint8Array(fixture.bytes.length - BLOCK_SIZE)
    removed.set(fixture.bytes.subarray(0, bodyEnd))
    removed.set(fixture.bytes.subarray(bodyEnd + BLOCK_SIZE), bodyEnd)
    await expectRejected(o, removed, [CORRUPT_FILE], 'EOF removed')
  })

  it('duplicate EOF: an extra EOF block after the real one, or over any body block', async () => {
    const f = fixture.bytes
    const doubled = new Uint8Array(f.length + BLOCK_SIZE)
    doubled.set(f.subarray(0, bodyEnd + BLOCK_SIZE))
    doubled.set(EOF_MARKER, bodyEnd + BLOCK_SIZE)
    doubled.set(f.subarray(bodyEnd + BLOCK_SIZE), bodyEnd + 2 * BLOCK_SIZE)
    await expectRejected(o, doubled, [CORRUPT_FILE], 'EOF twice in a row')
    for (let at = BODY_OFFSET; at < bodyEnd; at += BLOCK_SIZE) {
      const g = f.slice()
      g.set(EOF_MARKER, at)
      await expectRejected(o, g, [CORRUPT_FILE], `early EOF at ${at}`)
    }
  })

  it('EOF not block-aligned (1 to 15 bytes shifted) is CORRUPT_FILE', async () => {
    const f = fixture.bytes
    for (let shift = 1; shift < BLOCK_SIZE; shift++) {
      const g = new Uint8Array(f.length + shift)
      g.set(f.subarray(0, bodyEnd))
      g.set(randomBytes(shift), bodyEnd)
      g.set(f.subarray(bodyEnd), bodyEnd + shift)
      await expectRejected(o, g, [CORRUPT_FILE], `EOF shifted by ${shift}`)
    }
    // Body bytes removed so the EOF lands mid-block.
    const h = new Uint8Array(f.length - 5)
    h.set(f.subarray(0, bodyEnd - 5))
    h.set(f.subarray(bodyEnd), bodyEnd - 5)
    await expectRejected(o, h, [CORRUPT_FILE], 'body shortened by 5')
  })

  it('header not starting with Version is CORRUPT_FILE, even with the HMAC intact', async () => {
    expect(o.plain[4]).toBe(HeaderFieldType.VERSION)
    for (const type of [
      HeaderFieldType.UUID,
      HeaderFieldType.DATABASE_NAME,
      FieldType.TITLE,
      0x7f,
      0xfe,
      FieldType.END,
    ]) {
      const p = o.plain.slice()
      p[4] = type
      // The V3 HMAC does not cover field types, so the stored HMAC still matches.
      expect(recomputeHmac(o, p)).toEqual(o.hmac)
      await expectRejected(
        o,
        await rebuild(o, p),
        [CORRUPT_FILE],
        `first type 0x${type.toString(16)}`,
      )
    }
  })

  it('a flipped bit in the data of any field is INTEGRITY_FAILED', async () => {
    let n = 0
    for (const fld of o.fields) {
      if (fld.length === 0) continue
      const p = o.plain.slice()
      const byte = fld.pos + 5 + (n % fld.length)
      p[byte]! ^= 1 << (n % 8)
      n++
      await expectRejected(o, await rebuild(o, p), [INTEGRITY_FAILED], `data bit at ${byte}`)
    }
    expect(n).toBeGreaterThan(0)
  })

  it('a flipped bit in any length byte is CORRUPT_FILE or INTEGRITY_FAILED', async () => {
    const fields =
      o.fields.length <= EXHAUSTIVE_LIMIT_FIELDS
        ? o.fields
        : [...o.fields.slice(0, 40), ...o.fields.slice(-40)]
    const seen = new Set<ErrorCode>()
    for (const fld of fields) {
      for (let bit = 0; bit < 32; bit++) {
        const p = o.plain.slice()
        p[fld.pos + (bit >> 3)]! ^= 1 << (bit & 7)
        seen.add(
          await expectRejected(
            o,
            await rebuild(o, p),
            [CORRUPT_FILE, INTEGRITY_FAILED],
            `length bit ${bit} at ${fld.pos}`,
          ),
        )
      }
    }
    expect(seen.has(CORRUPT_FILE)).toBe(true)
  })

  it('random ciphertext bit flips never throw, hang or return changed values', async () => {
    const good = await decodeFixture(fixture)
    for (let i = 0; i < 150; i++) {
      const g = fixture.bytes.slice()
      const pos = BODY_OFFSET + Math.floor(Math.random() * (bodyEnd - BODY_OFFSET))
      g[pos]! ^= 1 << Math.floor(Math.random() * 8)
      const start = performance.now()
      const r = await decode(g, fixture.password, deps)
      expect(performance.now() - start).toBeLessThan(CASE_BUDGET_MS)
      if (r.ok) {
        // Only possible when the flip garbled nothing but padding.
        expect(r.value.header).toEqual(good.header)
        expect(r.value.records).toEqual(good.records)
      } else {
        expect([CORRUPT_FILE, INTEGRITY_FAILED], `flip at ${pos}`).toContain(r.error.code)
      }
    }
  })

  it.each([2 ** 32 - 1, MAX_ITERATIONS_READ + 1])(
    'iterations = %i is UNSUPPORTED_FORMAT before any stretching',
    async (iterations) => {
      const f = fixture.bytes.slice()
      new DataView(f.buffer).setUint32(ITER_OFFSET, iterations, true)
      const stretch = vi.fn<StretchFn>(async () => {
        throw new Error('stretch must not run')
      })
      await expectRejected(o, f, [UNSUPPORTED_FORMAT], `iterations ${iterations}`, {
        cipherFactory: createTwofish,
        stretch,
      })
      expect(stretch).not.toHaveBeenCalled()
      // The default worker-thread stretch is not reached either: no hang with production deps.
      await expectRejected(o, f, [UNSUPPORTED_FORMAT], 'production deps', {
        cipherFactory: createTwofish,
      })
    },
  )
})
