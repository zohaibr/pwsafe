// Twofish block cipher (128-bit block; 128/192/256-bit keys).
//
// Written from the algorithm description in: B. Schneier, J. Kelsey, D. Whiting, D. Wagner,
// C. Hall, N. Ferguson, "Twofish: A 128-Bit Block Cipher", 15 June 1998 (the AES submission
// paper). Section references below point to that paper. See LICENSE-NOTICE.md.
//
// The key-dependent S-boxes are fully precomputed per key (4 tables x 256 words), so each round
// function g() is four table lookups. The fixed tables (q0, q1 and the MDS columns) are built
// once at module load.

import { BLOCK_SIZE, type BlockCipher, type BlockCipherFactory, CipherError } from '../cipher'

const ROUNDS = 16

// §4.3.5: the 4-bit "t" tables that define the fixed permutations q0 and q1.
const Q0_T = [
  [0x8, 0x1, 0x7, 0xd, 0x6, 0xf, 0x3, 0x2, 0x0, 0xb, 0x5, 0x9, 0xe, 0xc, 0xa, 0x4],
  [0xe, 0xc, 0xb, 0x8, 0x1, 0x2, 0x3, 0x5, 0xf, 0x4, 0xa, 0x6, 0x7, 0x0, 0x9, 0xd],
  [0xb, 0xa, 0x5, 0xe, 0x6, 0xd, 0x9, 0x0, 0xc, 0x8, 0xf, 0x3, 0x2, 0x4, 0x7, 0x1],
  [0xd, 0x7, 0xf, 0x4, 0x1, 0x2, 0x6, 0xe, 0x9, 0xb, 0x3, 0x0, 0x8, 0x5, 0xc, 0xa],
] as const
const Q1_T = [
  [0x2, 0x8, 0xb, 0xd, 0xf, 0x7, 0x6, 0xe, 0x3, 0x1, 0x9, 0x4, 0x0, 0xa, 0xc, 0x5],
  [0x1, 0xe, 0x2, 0xb, 0x4, 0xc, 0x3, 0x7, 0x6, 0xd, 0xa, 0x5, 0xf, 0x9, 0x0, 0x8],
  [0x4, 0xc, 0x7, 0x5, 0x1, 0x6, 0x9, 0xa, 0x0, 0xe, 0xd, 0x8, 0x2, 0xb, 0x3, 0xf],
  [0xb, 0x9, 0x5, 0x1, 0xc, 0x3, 0xd, 0xe, 0x6, 0x4, 0x7, 0xf, 0x2, 0x0, 0x8, 0xa],
] as const

type TTables = readonly (readonly number[])[]

function buildQ(t: TTables): Uint8Array {
  const [t0, t1, t2, t3] = t as [number[], number[], number[], number[]]
  const ror4 = (x: number): number => ((x >>> 1) | (x << 3)) & 0xf
  const q = new Uint8Array(256)
  for (let x = 0; x < 256; x++) {
    const a0 = x >>> 4
    const b0 = x & 0xf
    const a1 = a0 ^ b0
    const b1 = (a0 ^ ror4(b0) ^ (a0 << 3)) & 0xf
    const a2 = t0[a1]!
    const b2 = t1[b1]!
    const a3 = a2 ^ b2
    const b3 = (a2 ^ ror4(b2) ^ (a2 << 3)) & 0xf
    const a4 = t2[a3]!
    const b4 = t3[b3]!
    q[x] = (b4 << 4) | a4
  }
  return q
}

const Q0 = buildQ(Q0_T)
const Q1 = buildQ(Q1_T)

/** Multiplication in GF(2^8) modulo the given primitive polynomial. */
function gfMul(a: number, b: number, poly: number): number {
  let r = 0
  while (b !== 0) {
    if (b & 1) r ^= a
    a <<= 1
    if (a & 0x100) a ^= poly
    b >>>= 1
  }
  return r
}

// §4.3.2: MDS matrix over GF(2^8) with v(x) = x^8 + x^6 + x^5 + x^3 + 1 (0x169).
const MDS_POLY = 0x169
const MDS = [
  [0x01, 0xef, 0x5b, 0x5b],
  [0x5b, 0xef, 0xef, 0x01],
  [0xef, 0x5b, 0x01, 0xef],
  [0xef, 0x01, 0xef, 0x5b],
] as const

// MDS_COL[j][b]: the MDS matrix times a vector that is b in position j and 0 elsewhere,
// packed as a little-endian 32-bit word.
const MDS_COL: Uint32Array[] = [0, 1, 2, 3].map((j) => {
  const col = new Uint32Array(256)
  for (let b = 0; b < 256; b++) {
    let w = 0
    for (let i = 0; i < 4; i++) w |= gfMul(MDS[i]![j]!, b, MDS_POLY) << (8 * i)
    col[b] = w >>> 0
  }
  return col
})

// §4.3: Reed-Solomon matrix over GF(2^8) with w(x) = x^8 + x^6 + x^3 + x^2 + 1 (0x14D).
const RS_POLY = 0x14d
const RS = [
  [0x01, 0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e],
  [0xa4, 0x56, 0x82, 0xf3, 0x1e, 0xc6, 0x68, 0xe5],
  [0x02, 0xa1, 0xfc, 0xc1, 0x47, 0xae, 0x3d, 0x19],
  [0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e, 0x03],
] as const

// §4.3.2, function h: per byte position, which q is applied at each stage (outermost last).
// Stage for l3 (only when k = 4), stage for l2 (k >= 3), then the fixed tail q, ^l1, q, ^l0, q.
const Q_L3 = [Q1, Q0, Q0, Q1] as const
const Q_L2 = [Q1, Q1, Q0, Q0] as const
const Q_L1 = [Q0, Q1, Q0, Q1] as const
const Q_L0 = [Q0, Q0, Q1, Q1] as const
const Q_OUT = [Q1, Q0, Q1, Q0] as const

const byteOf = (w: number, j: number): number => (w >>> (8 * j)) & 0xff

/** The byte-wise part of h (before the MDS multiply) for byte position j. */
function hByte(x: number, j: number, l: readonly number[]): number {
  const k = l.length
  let y = x
  if (k === 4) y = Q_L3[j]![y]! ^ byteOf(l[3]!, j)
  if (k >= 3) y = Q_L2[j]![y]! ^ byteOf(l[2]!, j)
  y = Q_L1[j]![y]! ^ byteOf(l[1]!, j)
  y = Q_L0[j]![y]! ^ byteOf(l[0]!, j)
  return Q_OUT[j]![y]!
}

/** h(X, L) from §4.3.2 for a 32-bit word X and list L of k words. */
function h(x: number, l: readonly number[]): number {
  let r = 0
  for (let j = 0; j < 4; j++) r ^= MDS_COL[j]![hByte(byteOf(x, j), j, l)]!
  return r >>> 0
}

const rol = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0
const ror = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

function readWordLE(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
}

function writeWordLE(b: Uint8Array, o: number, w: number): void {
  b[o] = w & 0xff
  b[o + 1] = (w >>> 8) & 0xff
  b[o + 2] = (w >>> 16) & 0xff
  b[o + 3] = (w >>> 24) & 0xff
}

function assertBlockRange(buf: Uint8Array, offset: number, what: string): void {
  if (!(buf instanceof Uint8Array)) throw new CipherError(`${what} buffer is not a Uint8Array`)
  if (!Number.isInteger(offset) || offset < 0 || offset + BLOCK_SIZE > buf.length) {
    throw new CipherError(
      `${what} offset ${offset} does not leave a full ${BLOCK_SIZE}-byte block in a buffer of ${buf.length} bytes`,
    )
  }
}

class Twofish implements BlockCipher {
  /** Round subkeys K0..K39 (§4.3.7). */
  private readonly k = new Uint32Array(40)
  /** Key-dependent S-boxes merged with the MDS columns: g(X) = s0[x0]^s1[x1]^s2[x2]^s3[x3]. */
  private readonly s0 = new Uint32Array(256)
  private readonly s1 = new Uint32Array(256)
  private readonly s2 = new Uint32Array(256)
  private readonly s3 = new Uint32Array(256)
  private disposed = false

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array)) throw new CipherError('Twofish key is not a Uint8Array')
    const n = key.length
    if (n !== 16 && n !== 24 && n !== 32) {
      throw new CipherError(`Twofish key length ${n} bytes is not 16, 24 or 32`)
    }
    const kw = n / 8 // k = N/64

    // §4.3: split the key into even and odd words, and derive S via the RS code.
    const me: number[] = []
    const mo: number[] = []
    const s: number[] = new Array<number>(kw)
    for (let i = 0; i < kw; i++) {
      me.push(readWordLE(key, 8 * i))
      mo.push(readWordLE(key, 8 * i + 4))
      let si = 0
      for (let r = 0; r < 4; r++) {
        let v = 0
        for (let c = 0; c < 8; c++) v ^= gfMul(RS[r]![c]!, key[8 * i + c]!, RS_POLY)
        si |= v << (8 * r)
      }
      // S = (S_{k-1}, ..., S_0): the list is reversed.
      s[kw - 1 - i] = si >>> 0
    }

    // §4.3.7: expanded key words.
    const rho = 0x01010101
    for (let i = 0; i < ROUNDS + 4; i++) {
      const a = h(Math.imul(2 * i, rho) >>> 0, me)
      const b = rol(h(Math.imul(2 * i + 1, rho) >>> 0, mo), 8)
      this.k[2 * i] = (a + b) >>> 0
      this.k[2 * i + 1] = rol((a + 2 * b) >>> 0, 9)
    }

    // Precompute g() as four lookup tables for this key.
    const tables = [this.s0, this.s1, this.s2, this.s3]
    for (let j = 0; j < 4; j++) {
      const t = tables[j]!
      const col = MDS_COL[j]!
      for (let x = 0; x < 256; x++) t[x] = col[hByte(x, j, s)]!
    }

    me.fill(0)
    mo.fill(0)
    s.fill(0)
  }

  private check(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number) {
    if (this.disposed) throw new CipherError('Twofish cipher has been disposed')
    assertBlockRange(input, inOffset, 'Input')
    assertBlockRange(output, outOffset, 'Output')
  }

  encryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void {
    this.check(input, inOffset, output, outOffset)
    const { k, s0, s1, s2, s3 } = this
    let x0 = readWordLE(input, inOffset) ^ k[0]!
    let x1 = readWordLE(input, inOffset + 4) ^ k[1]!
    let x2 = readWordLE(input, inOffset + 8) ^ k[2]!
    let x3 = readWordLE(input, inOffset + 12) ^ k[3]!
    for (let r = 0; r < ROUNDS; r++) {
      const t0 = s0[x0 & 0xff]! ^ s1[(x0 >>> 8) & 0xff]! ^ s2[(x0 >>> 16) & 0xff]! ^ s3[x0 >>> 24]!
      const t1 = s0[x1 >>> 24]! ^ s1[x1 & 0xff]! ^ s2[(x1 >>> 8) & 0xff]! ^ s3[(x1 >>> 16) & 0xff]!
      const f0 = (t0 + t1 + k[2 * r + 8]!) >>> 0
      const f1 = (t0 + 2 * t1 + k[2 * r + 9]!) >>> 0
      const n2 = ror((x2 ^ f0) >>> 0, 1)
      const n3 = (rol(x3, 1) ^ f1) >>> 0
      x2 = x0
      x3 = x1
      x0 = n2
      x1 = n3
    }
    // Undo the last swap and apply output whitening.
    writeWordLE(output, outOffset, (x2 ^ k[4]!) >>> 0)
    writeWordLE(output, outOffset + 4, (x3 ^ k[5]!) >>> 0)
    writeWordLE(output, outOffset + 8, (x0 ^ k[6]!) >>> 0)
    writeWordLE(output, outOffset + 12, (x1 ^ k[7]!) >>> 0)
  }

  decryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void {
    this.check(input, inOffset, output, outOffset)
    const { k, s0, s1, s2, s3 } = this
    let x2 = readWordLE(input, inOffset) ^ k[4]!
    let x3 = readWordLE(input, inOffset + 4) ^ k[5]!
    let x0 = readWordLE(input, inOffset + 8) ^ k[6]!
    let x1 = readWordLE(input, inOffset + 12) ^ k[7]!
    for (let r = ROUNDS - 1; r >= 0; r--) {
      // State is (x0, x1, x2, x3) = (c', d', a, b); F is computed from a and b.
      const t0 = s0[x2 & 0xff]! ^ s1[(x2 >>> 8) & 0xff]! ^ s2[(x2 >>> 16) & 0xff]! ^ s3[x2 >>> 24]!
      const t1 = s0[x3 >>> 24]! ^ s1[x3 & 0xff]! ^ s2[(x3 >>> 8) & 0xff]! ^ s3[(x3 >>> 16) & 0xff]!
      const f0 = (t0 + t1 + k[2 * r + 8]!) >>> 0
      const f1 = (t0 + 2 * t1 + k[2 * r + 9]!) >>> 0
      const c = (rol(x0, 1) ^ f0) >>> 0
      const d = ror((x1 ^ f1) >>> 0, 1)
      x0 = x2
      x1 = x3
      x2 = c
      x3 = d
    }
    writeWordLE(output, outOffset, (x0 ^ k[0]!) >>> 0)
    writeWordLE(output, outOffset + 4, (x1 ^ k[1]!) >>> 0)
    writeWordLE(output, outOffset + 8, (x2 ^ k[2]!) >>> 0)
    writeWordLE(output, outOffset + 12, (x3 ^ k[3]!) >>> 0)
  }

  dispose(): void {
    this.k.fill(0)
    this.s0.fill(0)
    this.s1.fill(0)
    this.s2.fill(0)
    this.s3.fill(0)
    this.disposed = true
  }
}

/** Creates a Twofish cipher for a 16-, 24- or 32-byte key. The key bytes are not retained. */
export const createTwofish: BlockCipherFactory = (key) => new Twofish(key)
