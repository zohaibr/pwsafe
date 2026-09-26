// Tests for the password generator (docs/execution-plan.md §D WP4 evidence, §B1).
// src/shared may not import node:*, so randomness here comes from globalThis.crypto (Web Crypto).
import { describe, expect, it } from 'vitest'
import {
  alphabetFor,
  byteSourceFromFill,
  DIGITS,
  generatePassword,
  LOOK_ALIKES,
  LOWERCASE,
  SYMBOLS,
  UPPERCASE,
  type ByteSource,
} from './generator'
import type { GeneratorOptions } from './types'

const NONE: GeneratorOptions = {
  length: 8,
  upper: false,
  lower: false,
  digits: false,
  symbols: false,
  avoidLookAlikes: false,
  requireEachSelected: false,
}

const opts = (o: Partial<GeneratorOptions>): GeneratorOptions => ({ ...NONE, ...o })

/** A byte source that returns the scripted bytes in order and records every request. */
function scripted(bytes: number[]): ByteSource & { requests: number[]; remaining: () => number } {
  let pos = 0
  const requests: number[] = []
  const src = (n: number): Uint8Array => {
    requests.push(n)
    if (pos + n > bytes.length) throw new Error(`script exhausted at byte ${pos} (asked ${n})`)
    const out = Uint8Array.from(bytes.slice(pos, pos + n))
    pos += n
    return out
  }
  return Object.assign(src, { requests, remaining: () => bytes.length - pos })
}

function unwrap(r: ReturnType<typeof generatePassword>): string {
  if (!r.ok) throw new Error(`generatePassword failed: ${r.error.message}`)
  return r.value
}

const realBytes = byteSourceFromFill((b) => globalThis.crypto.getRandomValues(b))

// The four alphabets named in the evidence list.
const ALPHABETS: { name: string; options: GeneratorOptions; size: number }[] = [
  { name: 'digits', options: opts({ digits: true }), size: 10 },
  { name: 'lowercase', options: opts({ lower: true }), size: 26 },
  {
    name: 'upper+lower+digits',
    options: opts({ upper: true, lower: true, digits: true }),
    size: 62,
  },
  {
    name: 'all four sets',
    options: opts({ upper: true, lower: true, digits: true, symbols: true }),
    size: 94,
  },
]

describe('generatePassword: argument checks', () => {
  it('returns INVALID_ARGUMENT when no character set is selected', () => {
    const r = generatePassword(NONE, scripted([]))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGUMENT')
      expect(r.error.message).toBe('Choose at least one character type.')
    }
  })

  it.each([7, 65, 8.5, Number.NaN])('rejects length %s', (length) => {
    const r = generatePassword(opts({ lower: true, length }), realBytes)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGUMENT')
  })

  it('reports a byte source that returns the wrong number of bytes', () => {
    const r = generatePassword(opts({ lower: true }), () => new Uint8Array(1))
    expect(r.ok).toBe(false)
  })

  it('gives up instead of looping forever when every byte is rejected', () => {
    const r = generatePassword(opts({ digits: true }), (n) => new Uint8Array(n).fill(255))
    expect(r.ok).toBe(false)
  })

  it('builds the 94-character alphabet from the four sets in order', () => {
    expect(alphabetFor(ALPHABETS[3]!.options)).toBe(UPPERCASE + LOWERCASE + DIGITS + SYMBOLS)
    expect(new Set(alphabetFor(ALPHABETS[3]!.options)).size).toBe(94)
  })
})

describe('generatePassword: (a) rejection sampling', () => {
  it.each(ALPHABETS)('alphabet of $size ($name): bytes >= 256 - 256 % n are redrawn', (a) => {
    const n = a.size
    const limit = 256 - (256 % n)
    const alphabet = alphabetFor(a.options)
    expect(alphabet.length).toBe(n)
    // 8 bytes: first the rejected boundary values, then accepted ones. The generator asks for
    // 8 bytes, keeps the accepted ones, then asks again for exactly the number it still needs.
    const first = [limit, 255, limit - 1, 0, limit + 1, n, n - 1, 1]
    // accepted from `first`: limit-1, 0, n, n-1, 1 -> 5 chars, 3 still needed
    const second = [255, 2, 3]
    // accepted: 2, 3 -> 1 still needed
    const third = [limit]
    const fourth = [n + 5]
    const src = scripted([...first, ...second, ...third, ...fourth])
    const pw = unwrap(generatePassword({ ...a.options, length: 8 }, src))
    expect(src.requests).toEqual([8, 3, 1, 1])
    expect(src.remaining()).toBe(0)
    const expected = [limit - 1, 0, n, n - 1, 1, 2, 3, n + 5].map((b) => alphabet[b % n]).join('')
    expect(pw).toBe(expected)
  })

  it.each(ALPHABETS)('alphabet of $size: every byte below the limit is accepted', (a) => {
    const n = a.size
    const limit = 256 - (256 % n)
    const alphabet = alphabetFor(a.options)
    const bytes = Array.from({ length: limit }, (_, i) => i)
    // Pad to a multiple of the length so the script is consumed exactly.
    const len = 8
    while (bytes.length % len !== 0) bytes.push(0)
    const src = scripted(bytes)
    let out = ''
    while (src.remaining() > 0) out += unwrap(generatePassword({ ...a.options, length: len }, src))
    expect(src.requests.every((r) => r === len)).toBe(true)
    expect(out.slice(0, limit)).toBe(
      bytes
        .slice(0, limit)
        .map((b) => alphabet[b % n])
        .join(''),
    )
  })
})

describe('generatePassword: (b) accepted bytes map to exact characters', () => {
  it('maps byte values onto upper, lower, digits, symbols in that order', () => {
    const all = ALPHABETS[3]!.options
    // 0 -> 'A', 25 -> 'Z', 26 -> 'a', 51 -> 'z', 52 -> '0', 61 -> '9', 62 -> '!', 93 -> '~'
    const src = scripted([0, 25, 26, 51, 52, 61, 62, 93])
    expect(unwrap(generatePassword({ ...all, length: 8 }, src))).toBe('AZaz09!~')
    // Values above 93 wrap (limit is 188): 94 -> 'A', 187 -> '~', 95 -> 'B', 120 -> 'a',
    // 146 -> '0', 155 -> '9', 156 -> '!', 100 -> 'G'
    const src2 = scripted([94, 187, 95, 120, 146, 155, 156, 100])
    expect(unwrap(generatePassword({ ...all, length: 8 }, src2))).toBe('A~Ba09!G')
  })

  it('maps digits-only bytes exactly', () => {
    const src = scripted([0, 1, 2, 3, 4, 5, 6, 249])
    expect(unwrap(generatePassword(opts({ digits: true }), src))).toBe('01234569')
  })

  it('maps against the look-alike-free alphabet when that option is on', () => {
    const o = opts({ upper: true, digits: true, avoidLookAlikes: true })
    const alphabet = alphabetFor(o)
    expect(alphabet).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    // n = 32, limit = 256: every byte is accepted
    const src = scripted([0, 8, 13, 23, 24, 31, 32, 255])
    expect(unwrap(generatePassword(o, src))).toBe('AJPZ29A9')
  })
})

describe('generatePassword: (c) "at least one of each selected type"', () => {
  // upper + digits: n = 36, limit = 252. Bytes 0..25 -> A..Z, 26..35 -> 0..9.
  const base = opts({ upper: true, digits: true })
  const noDigit = [0, 1, 2, 3, 4, 5, 6, 7] // "ABCDEFGH"
  const withDigit = [0, 26, 1, 27, 2, 28, 3, 29] // "A0B1C2D3"

  it('on: a candidate missing a selected type is discarded and a whole new one drawn', () => {
    const src = scripted([...noDigit, ...withDigit])
    const pw = unwrap(generatePassword({ ...base, requireEachSelected: true }, src))
    expect(pw).toBe('A0B1C2D3')
    expect(src.requests).toEqual([8, 8])
  })

  it('on: several discarded candidates in a row, including one with a rejected byte', () => {
    const allDigits = [26, 27, 28, 29, 30, 31, 32, 33] // "01234567", no uppercase
    const src = scripted([...noDigit, ...allDigits, 252, ...withDigit.slice(0, 7), withDigit[7]!])
    const pw = unwrap(generatePassword({ ...base, requireEachSelected: true }, src))
    expect(pw).toBe('A0B1C2D3')
    expect(src.requests).toEqual([8, 8, 8, 1])
  })

  it('off: the first candidate is returned even when it misses a type', () => {
    const src = scripted([...noDigit, ...withDigit])
    const pw = unwrap(generatePassword({ ...base, requireEachSelected: false }, src))
    expect(pw).toBe('ABCDEFGH')
    expect(src.requests).toEqual([8])
    expect(src.remaining()).toBe(8)
  })

  it('on: every output from the real CSPRNG contains each selected type', () => {
    const all = opts({
      upper: true,
      lower: true,
      digits: true,
      symbols: true,
      requireEachSelected: true,
    })
    for (let i = 0; i < 2_000; i++) {
      const pw = unwrap(generatePassword(all, realBytes))
      expect(pw).toHaveLength(8)
      for (const set of [UPPERCASE, LOWERCASE, DIGITS, SYMBOLS]) {
        expect(
          [...pw].some((c) => set.includes(c)),
          `${set} missing`,
        ).toBe(true)
      }
    }
  })
})

describe('generatePassword: (d) deselected and look-alike characters never appear', () => {
  const combos: GeneratorOptions[] = []
  for (let m = 1; m < 16; m++) {
    for (const avoidLookAlikes of [false, true]) {
      combos.push({
        length: 20,
        upper: (m & 1) !== 0,
        lower: (m & 2) !== 0,
        digits: (m & 4) !== 0,
        symbols: (m & 8) !== 0,
        avoidLookAlikes,
        requireEachSelected: true,
      })
    }
  }

  it.each(combos)(
    'upper=$upper lower=$lower digits=$digits symbols=$symbols avoid=$avoidLookAlikes',
    (o) => {
      const allowed = new Set<string>()
      if (o.upper) for (const c of UPPERCASE) allowed.add(c)
      if (o.lower) for (const c of LOWERCASE) allowed.add(c)
      if (o.digits) for (const c of DIGITS) allowed.add(c)
      if (o.symbols) for (const c of SYMBOLS) allowed.add(c)
      if (o.avoidLookAlikes) for (const c of LOOK_ALIKES) allowed.delete(c)
      expect(new Set(alphabetFor(o))).toEqual(allowed)

      // Every byte value 0..255, in order, several times over: all mappings are exercised.
      const cycle = Array.from({ length: 256 * 40 }, (_, i) => i % 256)
      let pos = 0
      const cyclic: ByteSource = (n) => {
        const out = new Uint8Array(n)
        for (let i = 0; i < n; i++) out[i] = cycle[pos++ % cycle.length]!
        return out
      }
      const seen = new Set<string>()
      for (let i = 0; i < 300; i++) {
        // Consecutive bytes rarely cover every set, so the cyclic source runs without the redraw.
        const plain = { ...o, requireEachSelected: false }
        for (const c of unwrap(generatePassword(plain, cyclic))) seen.add(c)
        for (const c of unwrap(generatePassword(o, realBytes))) seen.add(c)
      }
      for (const c of seen) expect(allowed.has(c), `unexpected ${JSON.stringify(c)}`).toBe(true)
      // And the whole allowed alphabet is reachable.
      expect(seen.size).toBe(allowed.size)
    },
  )
})

describe('byteSourceFromFill', () => {
  it('splits large requests into 65,536-byte fills', () => {
    const sizes: number[] = []
    const src = byteSourceFromFill((b) => {
      sizes.push(b.length)
      b.fill(7)
    })
    const out = src(150_000)
    expect(out).toHaveLength(150_000)
    expect(out.every((b) => b === 7)).toBe(true)
    expect(sizes).toEqual([65_536, 65_536, 18_928])
  })

  it('works with crypto.getRandomValues', () => {
    const out = realBytes(100_000)
    expect(out).toHaveLength(100_000)
    expect(new Set(out).size).toBeGreaterThan(200)
  })
})

// ---------------------------------------------------------------------------------------------
// Statistical check (supplementary, not a gate on its own; §D WP4).
// A 256-bit seed is drawn from the real CSPRNG (crypto.getRandomValues) and expanded with
// AES-256-CTR via Web Crypto, so a failing run can be reproduced from the logged seed.
// 1,000,000 characters per alphabet, chi-square against the uniform distribution, alpha 0.001.
// On failure the check re-runs once with a fresh seed and fails only if both runs fail.
// ---------------------------------------------------------------------------------------------

const CHI_CHARS = 1_000_000
const ALPHA = 0.001

/** Regularized upper incomplete gamma Q(a, x) (series / continued fraction). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1
  const lnGammaA = lnGamma(a)
  if (x < a + 1) {
    let sum = 1 / a
    let term = sum
    for (let n = 1; n < 10_000; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGammaA)
  }
  // Lentz's continued fraction for Q.
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return Math.exp(-x + a * Math.log(x) - lnGammaA) * h
}

/** Lanczos approximation of ln(Gamma(z)), z > 0. */
function lnGamma(z: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  const zz = z - 1
  let x = c[0]!
  for (let i = 1; i < g + 2; i++) x += c[i]! / (zz + i)
  const t = zz + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
}

/** p-value of a chi-square statistic with `df` degrees of freedom. */
function chiSquareP(stat: number, df: number): number {
  return gammaQ(df / 2, stat / 2)
}

/** AES-256-CTR keystream from `seed`, as a synchronous ByteSource over a precomputed buffer. */
async function seededStream(seed: Uint8Array, size: number): Promise<ByteSource> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', new Uint8Array(seed), 'AES-CTR', false, ['encrypt'])
  const stream = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
      key,
      new Uint8Array(size),
    ),
  )
  let pos = 0
  return (n) => {
    if (pos + n > stream.length) throw new Error('seeded stream exhausted')
    const out = stream.subarray(pos, pos + n)
    pos += n
    return out
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

async function chiSquareRun(options: GeneratorOptions, seed: Uint8Array) {
  const alphabet = alphabetFor(options)
  const n = alphabet.length
  // Worst rejection rate among these alphabets is 68/256 (n = 94); 2.5 bytes per char is ample.
  const src = await seededStream(seed, Math.ceil(CHI_CHARS * 2.5))
  const index = new Map([...alphabet].map((c, i) => [c, i]))
  const counts = new Array<number>(n).fill(0)
  const length = 40
  for (let made = 0; made < CHI_CHARS; made += length) {
    for (const c of unwrap(generatePassword({ ...options, length }, src))) {
      counts[index.get(c)!]!++
    }
  }
  const expected = CHI_CHARS / n
  const stat = counts.reduce((s, k) => s + (k - expected) ** 2 / expected, 0)
  return { stat, p: chiSquareP(stat, n - 1) }
}

describe('generatePassword: chi-square uniformity (1M chars per alphabet, alpha 0.001)', () => {
  it('chi-square p-values match known critical values', () => {
    // Critical values at 0.001 from standard tables.
    expect(chiSquareP(27.877, 9)).toBeCloseTo(0.001, 5)
    expect(chiSquareP(52.62, 25)).toBeCloseTo(0.001, 5)
    expect(chiSquareP(1, 1)).toBeCloseTo(0.3173, 4)
    expect(chiSquareP(100, 93)).toBeGreaterThan(0.2)
  })

  it.each(ALPHABETS)(
    'alphabet of $size ($name) is uniform',
    async (a) => {
      const seed1 = globalThis.crypto.getRandomValues(new Uint8Array(32))
      const first = await chiSquareRun(a.options, seed1)
      if (first.p >= ALPHA) return
      console.warn(
        `chi-square failed for n=${a.size}: stat=${first.stat.toFixed(2)} p=${first.p} ` +
          `seed=${hex(seed1)}; re-running once with a fresh seed`,
      )
      const seed2 = globalThis.crypto.getRandomValues(new Uint8Array(32))
      const second = await chiSquareRun(a.options, seed2)
      if (second.p < ALPHA) {
        console.warn(
          `chi-square failed again for n=${a.size}: stat=${second.stat.toFixed(2)} ` +
            `p=${second.p} seed=${hex(seed2)}`,
        )
      }
      expect(
        second.p,
        `both runs failed; seeds ${hex(seed1)}, ${hex(seed2)}`,
      ).toBeGreaterThanOrEqual(ALPHA)
    },
    60_000,
  )

  it('detects a biased generator (the check has power)', async () => {
    // Plain modulo without rejection on n = 94 over the seeded stream: bytes 0..67 map twice.
    const seed = globalThis.crypto.getRandomValues(new Uint8Array(32))
    const src = await seededStream(seed, CHI_CHARS)
    const counts = new Array<number>(94).fill(0)
    for (const b of src(CHI_CHARS)) counts[b % 94]!++
    const expected = CHI_CHARS / 94
    const stat = counts.reduce((s, k) => s + (k - expected) ** 2 / expected, 0)
    expect(chiSquareP(stat, 93)).toBeLessThan(ALPHA)
  })
})
