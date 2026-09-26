import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { BlockCipherFactory } from '../crypto/cipher'
import { createTwofish } from '../crypto/twofish/twofish'
import { ErrorCode, type Result } from '../../shared/errors'
import { MAX_FILE_BYTES, MAX_ITERATIONS_READ, MIN_ITERATIONS_WRITE } from '../../shared/limits'
import { FieldType, HeaderFieldType } from '../../shared/types'
import { decode, encode, type DecodedVault, type VaultModel, wipeModel } from './codec'
import { BODY_OFFSET, EOF_MARKER, ITER_OFFSET } from './format'
import { SAVE_METADATA_HEADER_TYPES, stampHeaderForSave } from './header'
import type { StretchFn } from './stretch'
import { aesTestCipher } from './testing/aesCipher'
import { sampleModel, text, versionField } from './testing/fixtures'
import {
  TEST_PASSWORD,
  fastDeps,
  fileFrom,
  fileOf,
  freshParts,
  plainOf,
  syncStretch,
} from './testing/files'

const ciphers: [string, BlockCipherFactory][] = [
  ['Twofish', createTwofish],
  ['AES test adapter', aesTestCipher],
]

function expectCode(r: Result<unknown>, code: ErrorCode): void {
  expect(r.ok ? 'ok' : r.error.code).toBe(code)
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}

/** A stretch that must never run (for checks that have to fail before step 4). */
const forbiddenStretch: StretchFn = async () => {
  throw new Error('stretch must not be called')
}

describe.each(ciphers)('round-trip with %s', (_name, cipherFactory) => {
  it('decode(encode(model)) gives back every field byte-for-byte and in order', async () => {
    const model = sampleModel()
    const bytes = unwrap(
      await encode(model, TEST_PASSWORD, { cipherFactory, stretch: syncStretch }),
    )
    const back = unwrap(await decode(bytes, TEST_PASSWORD, fastDeps(cipherFactory)))
    expect(back.header).toEqual(model.header)
    expect(back.records).toEqual(model.records)
    expect(back.meta).toEqual({ iterations: MIN_ITERATIONS_WRITE, formatVersion: 0x0311 })
    // And once more: decode → encode → decode is stable.
    const again = unwrap(
      await encode(
        back,
        TEST_PASSWORD,
        { cipherFactory, stretch: syncStretch },
        { iterations: back.meta.iterations },
      ),
    )
    const back2 = unwrap(await decode(again, TEST_PASSWORD, fastDeps(cipherFactory)))
    expect(back2.header).toEqual(back.header)
    expect(back2.records).toEqual(back.records)
  })
})

describe('encode', () => {
  const deps = { cipherFactory: createTwofish, stretch: syncStretch }

  it('raises iterations to MIN_ITERATIONS_WRITE and keeps higher values', async () => {
    const iters = async (iterations?: number) => {
      const bytes = unwrap(
        await encode(
          sampleModel(),
          TEST_PASSWORD,
          deps,
          iterations === undefined ? {} : { iterations },
        ),
      )
      return new DataView(bytes.buffer).getUint32(ITER_OFFSET, true)
    }
    expect(await iters()).toBe(MIN_ITERATIONS_WRITE)
    expect(await iters(2_048)).toBe(MIN_ITERATIONS_WRITE)
    expect(await iters(300_000)).toBe(300_000)
  })

  it('refuses iterations above what we can read back', async () => {
    expectCode(
      await encode(sampleModel(), TEST_PASSWORD, deps, { iterations: MAX_ITERATIONS_READ + 1 }),
      ErrorCode.INVALID_ARGUMENT,
    )
  })

  it('draws fresh salt, K, L, IV and padding from the injected random source', async () => {
    const random = vi.fn((n: number) => new Uint8Array(randomBytes(n)))
    const a = unwrap(await encode(sampleModel(), TEST_PASSWORD, { ...deps, randomBytes: random }))
    const b = unwrap(await encode(sampleModel(), TEST_PASSWORD, { ...deps, randomBytes: random }))
    expect(random.mock.calls.map((c) => c[0]).slice(0, 4)).toEqual([32, 32, 32, 16])
    expect(Buffer.from(a.subarray(4, 36))).not.toEqual(Buffer.from(b.subarray(4, 36)))
    expect(Buffer.from(a.subarray(136, 152))).not.toEqual(Buffer.from(b.subarray(136, 152)))
  })

  it('is deterministic for a fixed random source (so the source really is used for everything)', async () => {
    let seed = 1
    const det = (n: number) =>
      Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
    seed = 1
    const a = unwrap(await encode(sampleModel(), TEST_PASSWORD, { ...deps, randomBytes: det }))
    seed = 1
    const b = unwrap(await encode(sampleModel(), TEST_PASSWORD, { ...deps, randomBytes: det }))
    expect(Buffer.from(a)).toEqual(Buffer.from(b))
  })

  it('refuses a newer-format header (READ_ONLY) and a header without Version', async () => {
    const newer = sampleModel()
    newer.header[0] = versionField(0x0312)
    expectCode(await encode(newer, TEST_PASSWORD, deps), ErrorCode.READ_ONLY)
    const noVersion = sampleModel()
    noVersion.header.shift()
    expectCode(await encode(noVersion, TEST_PASSWORD, deps), ErrorCode.INVALID_ARGUMENT)
    const v4 = sampleModel()
    v4.header[0] = versionField(0x0400)
    expectCode(await encode(v4, TEST_PASSWORD, deps), ErrorCode.INVALID_ARGUMENT)
  })

  it('refuses a model containing END or an oversized field', async () => {
    const m = sampleModel()
    m.records[0]!.fields.push({ type: FieldType.END, data: new Uint8Array(0) })
    expectCode(await encode(m, TEST_PASSWORD, deps), ErrorCode.INVALID_ARGUMENT)
  })

  it('returns CANCELLED when aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    expectCode(
      await encode(sampleModel(), TEST_PASSWORD, deps, { signal: ac.signal }),
      ErrorCode.CANCELLED,
    )
  })

  it('stampHeaderForSave changes only 0x04, 0x06 and existing 0x07/0x08, in place', () => {
    const header = [
      versionField(),
      text(HeaderFieldType.WHAT_LAST_SAVED, 'Password Safe V3.29'),
      text(HeaderFieldType.LAST_SAVED_BY_USER, 'alice'),
      text(HeaderFieldType.DATABASE_NAME, 'db'),
    ]
    const out = stampHeaderForSave(header, {
      now: 1_800_000_000,
      application: 'psafe3 Opener V0.1.0',
      user: 'bob',
      host: 'mac',
    })
    expect(out.map((f) => f.type)).toEqual([0x00, 0x06, 0x07, 0x09, 0x04])
    expect(new TextDecoder().decode(out[1]!.data)).toBe('psafe3 Opener V0.1.0')
    expect(new TextDecoder().decode(out[2]!.data)).toBe('bob')
    expect(out[3]).toBe(header[3])
    expect(header[1]!.data).toEqual(text(6, 'Password Safe V3.29').data) // input untouched
    expect(SAVE_METADATA_HEADER_TYPES).toEqual([4, 6, 7, 8])
  })
})

describe('§A4 malformed input', () => {
  const cf = createTwofish
  const model = (): VaultModel => ({
    header: [versionField(0x030b), text(HeaderFieldType.DATABASE_NAME, 'm')],
    records: [
      {
        fields: [
          text(FieldType.TITLE, 'a'),
          text(FieldType.NOTES, 'n'.repeat(80)),
          text(FieldType.PASSWORD, 'p'),
        ],
      },
      { fields: [text(FieldType.TITLE, 'b')] },
    ],
  })
  const parts = freshParts()
  const good = () => fileOf(model(), parts, cf)
  const open = (bytes: Uint8Array, deps = fastDeps(cf)) => decode(bytes, TEST_PASSWORD, deps)

  it('a valid file opens', async () => {
    const v = unwrap(await open(await good()))
    expect(v.records).toHaveLength(2)
  })

  it('step 1: shorter than 232 bytes is CORRUPT_FILE, before the tag check', async () => {
    expectCode(
      await open(new Uint8Array(231), { cipherFactory: cf, stretch: forbiddenStretch }),
      ErrorCode.CORRUPT_FILE,
    )
    expectCode(await open(new Uint8Array(0)), ErrorCode.CORRUPT_FILE)
  })

  it('step 1: larger than 128 MB is TOO_LARGE, before anything else', async () => {
    expectCode(
      await open(new Uint8Array(MAX_FILE_BYTES + 1), {
        cipherFactory: cf,
        stretch: forbiddenStretch,
      }),
      ErrorCode.TOO_LARGE,
    )
  })

  it('step 2: no PWS3 tag (V4, V1/V2, anything else) is UNSUPPORTED_FORMAT', async () => {
    const f = await good()
    f[3] = 0x34 // "PWS4"
    expectCode(
      await open(f, { cipherFactory: cf, stretch: forbiddenStretch }),
      ErrorCode.UNSUPPORTED_FORMAT,
    )
    expectCode(
      await open(new Uint8Array(randomBytes(4096)), {
        cipherFactory: cf,
        stretch: forbiddenStretch,
      }),
      ErrorCode.UNSUPPORTED_FORMAT,
    )
  })

  it.each([0, 2_047, MAX_ITERATIONS_READ + 1, 2 ** 32 - 1])(
    'step 3: iterations %i are refused before any stretching',
    async (iterations) => {
      const f = await good()
      new DataView(f.buffer).setUint32(ITER_OFFSET, iterations, true)
      const stretch = vi.fn(forbiddenStretch)
      const r = await open(f, { cipherFactory: cf, stretch })
      expectCode(r, ErrorCode.UNSUPPORTED_FORMAT)
      expect(stretch).not.toHaveBeenCalled()
      if (!r.ok) expect(r.error.message).toMatch(/key-stretching rounds/)
    },
  )

  it('step 3: the bounds 2,048 and 2^24 are accepted', async () => {
    for (const iterations of [2_048, MAX_ITERATIONS_READ]) {
      const f = await good()
      new DataView(f.buffer).setUint32(ITER_OFFSET, iterations, true)
      const stretch = vi.fn<StretchFn>(async () => new Uint8Array(32))
      expectCode(await open(f, { cipherFactory: cf, stretch }), ErrorCode.WRONG_PASSWORD)
      expect(stretch).toHaveBeenCalledOnce()
    }
  })

  it('step 4: wrong password is WRONG_PASSWORD, even when the body is also broken', async () => {
    const f = await good()
    expectCode(
      await decode(f, new TextEncoder().encode('nope'), fastDeps(cf)),
      ErrorCode.WRONG_PASSWORD,
    )
    const broken = f.slice(0, f.length - 48) // no EOF, no HMAC
    expectCode(
      await decode(broken, new TextEncoder().encode('nope'), fastDeps(cf)),
      ErrorCode.WRONG_PASSWORD,
    )
  })

  it('step 4: a flipped bit in the salt or H(P′) is WRONG_PASSWORD', async () => {
    for (const offset of [4, 35, 40, 71]) {
      const f = await good()
      f[offset]! ^= 0x10
      expectCode(await open(f), ErrorCode.WRONG_PASSWORD)
    }
  })

  it('truncated at every block boundary is CORRUPT_FILE', async () => {
    const f = await good()
    for (let len = f.length - 16; len > 0; len -= 16) {
      expectCode(await open(f.slice(0, len)), ErrorCode.CORRUPT_FILE)
    }
    // Truncated inside the HMAC.
    expectCode(await open(f.slice(0, f.length - 1)), ErrorCode.CORRUPT_FILE)
  })

  it('missing EOF, duplicate EOF, EOF not block-aligned, trailing bytes: CORRUPT_FILE', async () => {
    const f = await good()
    const eofAt = f.length - 48
    const noEof = f.slice()
    noEof.set(new Uint8Array(16), eofAt)
    expectCode(await open(noEof), ErrorCode.CORRUPT_FILE)

    const dup = new Uint8Array(f.length + 16)
    dup.set(f.subarray(0, eofAt))
    dup.set(EOF_MARKER, eofAt)
    dup.set(f.subarray(eofAt), eofAt + 16)
    expectCode(await open(dup), ErrorCode.CORRUPT_FILE)

    const earlyDup = f.slice()
    earlyDup.set(EOF_MARKER, BODY_OFFSET + 16)
    expectCode(await open(earlyDup), ErrorCode.CORRUPT_FILE)

    const shifted = new Uint8Array(f.length + 5)
    shifted.set(f.subarray(0, eofAt))
    shifted.set(f.subarray(eofAt), eofAt + 5)
    expectCode(await open(shifted), ErrorCode.CORRUPT_FILE)

    const trailing = new Uint8Array(f.length + 16)
    trailing.set(f)
    expectCode(await open(trailing), ErrorCode.CORRUPT_FILE)
  })

  /** Re-assembles a file after changing its plaintext, keeping the original (now stale) HMAC. */
  async function tampered(edit: (plain: Uint8Array, view: DataView) => void, rehmac = false) {
    const { plain, hmac } = plainOf(model(), parts)
    edit(plain, new DataView(plain.buffer))
    if (rehmac) {
      // Recompute a valid HMAC over the edited stream by parsing its fields leniently.
      const { createHmac } = await import('node:crypto')
      const mac = createHmac('sha256', parts.l)
      const v = new DataView(plain.buffer)
      for (let pos = 0; pos < plain.length;) {
        const len = v.getUint32(pos, true)
        mac.update(plain.subarray(pos + 5, pos + 5 + len))
        pos += Math.max(1, Math.ceil((len + 5) / 16)) * 16
      }
      return fileFrom(plain, new Uint8Array(mac.digest()), parts, cf)
    }
    return fileFrom(plain, hmac, parts, cf)
  }

  it('header not starting with Version is CORRUPT_FILE', async () => {
    expectCode(
      await open(await tampered((p) => (p[4] = HeaderFieldType.UUID))),
      ErrorCode.CORRUPT_FILE,
    )
  })

  it('length overflowing the buffer and length 0xFFFFFFFF are CORRUPT_FILE', async () => {
    expectCode(
      await open(await tampered((_p, v) => v.setUint32(48, 5000, true))),
      ErrorCode.CORRUPT_FILE,
    )
    expectCode(
      await open(await tampered((_p, v) => v.setUint32(48, 0xffffffff, true))),
      ErrorCode.CORRUPT_FILE,
    )
  })

  it('missing END is CORRUPT_FILE', async () => {
    // Turn the last record's END into an unknown field: the stream then ends without END.
    expectCode(
      await open(await tampered((p) => (p[p.length - 16 + 4] = 0xee))),
      ErrorCode.CORRUPT_FILE,
    )
  })

  it('framing is judged before the HMAC (step 6 before 7)', async () => {
    const f = await tampered((p) => (p[4] = HeaderFieldType.UUID))
    f[f.length - 1]! ^= 1
    expectCode(await open(f), ErrorCode.CORRUPT_FILE)
  })

  it('a flipped bit in field data is INTEGRITY_FAILED', async () => {
    // Record 1: title at block 3, notes (80 bytes) at blocks 4..9; data starts at +5.
    for (const offset of [4 * 16 + 5, 4 * 16 + 20, 4 * 16 + 84]) {
      expectCode(
        await open(await tampered((p) => (p[offset]! ^= 0x01))),
        ErrorCode.INTEGRITY_FAILED,
      )
    }
  })

  it('a flipped bit in the stored HMAC is INTEGRITY_FAILED', async () => {
    const f = await good()
    f[f.length - 7]! ^= 0x80
    expectCode(await open(f), ErrorCode.INTEGRITY_FAILED)
  })

  it('a flipped ciphertext bit inside a long field is INTEGRITY_FAILED', async () => {
    // Notes (80 bytes) spans blocks 4..9; flipping ciphertext block 6 garbles block 6 and flips one
    // bit of block 7, both pure data.
    const f = await good()
    f[BODY_OFFSET + 6 * 16 + 3]! ^= 0x04
    expectCode(await open(f), ErrorCode.INTEGRITY_FAILED)
  })

  it('every flipped bit in a length field is CORRUPT_FILE or INTEGRITY_FAILED, never a crash', async () => {
    for (const block of [0, 1, 2, 3]) {
      for (let byte = 0; byte < 4; byte++) {
        for (let bit = 0; bit < 8; bit++) {
          const f = await tampered((p) => (p[block * 16 + byte]! ^= 1 << bit))
          const r = await open(f)
          expect(r.ok).toBe(false)
          if (!r.ok)
            expect([ErrorCode.CORRUPT_FILE, ErrorCode.INTEGRITY_FAILED]).toContain(r.error.code)
        }
      }
    }
  })

  it('random ciphertext bit flips never crash and never return a changed model', async () => {
    const f = await good()
    const original = model()
    for (let i = 0; i < 300; i++) {
      const g = f.slice()
      const pos = 72 + Math.floor(Math.random() * (g.length - 72))
      g[pos]! ^= 1 << Math.floor(Math.random() * 8)
      const r = await open(g)
      if (r.ok) {
        // Only possible when the flip landed in random padding (e.g. via the IV).
        expect(r.value.header).toEqual(original.header)
        expect(r.value.records).toEqual(original.records)
      } else {
        expect([
          ErrorCode.CORRUPT_FILE,
          ErrorCode.INTEGRITY_FAILED,
          ErrorCode.WRONG_PASSWORD,
        ]).toContain(r.error.code)
      }
    }
  })

  it('Version major other than 3 (authenticated) is UNSUPPORTED_FORMAT', async () => {
    expectCode(await open(await tampered((p) => (p[6] = 0x04), true)), ErrorCode.UNSUPPORTED_FORMAT)
  })

  it('Version with the wrong length (authenticated) is CORRUPT_FILE', async () => {
    expectCode(
      await open(await tampered((_p, v) => v.setUint32(0, 3, true), true)),
      ErrorCode.CORRUPT_FILE,
    )
  })

  it('a newer V3 minor opens with readOnlyReason newer-format; 0x0311 does not', async () => {
    const newer = unwrap(await open(await tampered((p) => (p[5] = 0x12), true)))
    expect(newer.meta).toEqual({
      iterations: 2_048,
      formatVersion: 0x0312,
      readOnlyReason: 'newer-format',
    })
    const current = unwrap(await open(await tampered((p) => (p[5] = 0x11), true)))
    expect(current.meta.readOnlyReason).toBeUndefined()
  })

  it('file sizes 232 (smallest valid) open', async () => {
    const f = await fileOf({ header: [versionField()], records: [] }, parts, cf)
    expect(f.length).toBe(232)
    const v = unwrap(await open(f))
    expect(v.records).toEqual([])
  })
})

describe('secrets and cancellation', () => {
  it('zeroes P′, K and L after decode', async () => {
    const parts = freshParts()
    const f = await fileOf(sampleModel(), parts, createTwofish)
    const keys: Uint8Array[] = []
    const spy: BlockCipherFactory = (key) => {
      keys.push(key)
      return createTwofish(key)
    }
    const r = await decode(f, TEST_PASSWORD, { cipherFactory: spy, stretch: syncStretch })
    expect(r.ok).toBe(true)
    expect(keys).toHaveLength(2)
    for (const k of keys) expect(k.every((b) => b === 0)).toBe(true)
  })

  it('zeroes keys on a failed HMAC too, and wipeModel clears field buffers', async () => {
    const parts = freshParts()
    const f = await fileOf(sampleModel(), parts, createTwofish)
    f[f.length - 1]! ^= 1
    const keys: Uint8Array[] = []
    await decode(f, TEST_PASSWORD, {
      cipherFactory: (k) => (keys.push(k), createTwofish(k)),
      stretch: syncStretch,
    })
    for (const k of keys) expect(k.every((b) => b === 0)).toBe(true)
    const m = sampleModel()
    wipeModel(m)
    expect(m.records.flatMap((r) => r.fields).every((x) => x.data.every((b) => b === 0))).toBe(true)
  })

  it('decode in the worker reports progress and returns CANCELLED on abort', async () => {
    // A header claiming 2^24 rounds: the worker would take many seconds, so the abort must win.
    const parts = freshParts()
    const f = await fileOf(sampleModel(), parts, createTwofish)
    new DataView(f.buffer).setUint32(ITER_OFFSET, MAX_ITERATIONS_READ, true)
    const ac = new AbortController()
    const progress: number[] = []
    const started = Date.now()
    const p = decode(
      f,
      TEST_PASSWORD,
      { cipherFactory: createTwofish },
      {
        signal: ac.signal,
        onProgress: (x) => {
          progress.push(x)
          if (progress.length === 2) ac.abort()
        },
      },
    )
    expectCode(await p, ErrorCode.CANCELLED)
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('decode through the default worker stretch opens a real 262,144-round file', async () => {
    const bytes = unwrap(
      await encode(sampleModel(), TEST_PASSWORD, { cipherFactory: createTwofish }),
    )
    const v: DecodedVault = unwrap(
      await decode(bytes, TEST_PASSWORD, { cipherFactory: createTwofish }),
    )
    expect(v.records).toEqual(sampleModel().records)
  })
})
