import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CipherError, cbcDecrypt, cbcEncrypt, ecbDecrypt, ecbEncrypt } from '../cipher'
import { CHAIN_128, CHAIN_192, CHAIN_256, IVAL_VECTORS } from './kat-vectors'
import { createTwofish } from './twofish'

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex').toUpperCase()

function encryptOne(key: Uint8Array, pt: Uint8Array): Uint8Array {
  const c = createTwofish(key)
  const out = new Uint8Array(16)
  c.encryptBlock(pt, 0, out, 0)
  const back = new Uint8Array(16)
  c.decryptBlock(out, 0, back, 0)
  expect(toHex(back)).toBe(toHex(pt))
  c.dispose()
  return out
}

describe('Twofish known-answer tests', () => {
  it.each(IVAL_VECTORS.map((v) => [v.key.length * 4, v.key, v.ct] as const))(
    'ecb_ival %i-bit: zero plaintext encrypts to the published ciphertext',
    (_bits, key, ct) => {
      expect(toHex(encryptOne(hex(key), new Uint8Array(16)))).toBe(ct)
    },
  )

  it.each([
    [128, CHAIN_128],
    [192, CHAIN_192],
    [256, CHAIN_256],
  ] as const)('ecb_tbl %i-bit: 49-iteration chained table', (bits, chain) => {
    expect(chain).toHaveLength(49)
    const keyLen = bits / 8
    let key: Uint8Array = new Uint8Array(keyLen)
    let pt: Uint8Array = new Uint8Array(16)
    for (let i = 0; i < 49; i++) {
      const ct = encryptOne(key, pt)
      expect(toHex(ct), `I=${i + 1}`).toBe(chain[i])
      const next = new Uint8Array(16 + keyLen)
      next.set(pt, 0)
      next.set(key, 16)
      key = next.subarray(0, keyLen)
      pt = ct
    }
  })
})

describe('Twofish modes', () => {
  it('ECB round-trips random data', () => {
    const c = createTwofish(randomBytes(32))
    const data = new Uint8Array(randomBytes(16 * 37))
    const enc = ecbEncrypt(c, data)
    expect(toHex(enc)).not.toBe(toHex(data))
    expect(toHex(ecbDecrypt(c, enc))).toBe(toHex(data))
  })

  it.each([16, 24, 32])('CBC round-trips random data with a %i-byte key', (keyLen) => {
    const c = createTwofish(randomBytes(keyLen))
    const iv = new Uint8Array(randomBytes(16))
    for (const len of [0, 16, 32, 16 * 1000 + 16]) {
      const data = new Uint8Array(randomBytes(len))
      const enc = cbcEncrypt(c, iv, data)
      expect(enc).toHaveLength(len)
      expect(toHex(cbcDecrypt(c, iv, enc))).toBe(toHex(data))
    }
  })

  it('CBC-decrypts 1 MB well under a second', () => {
    const c = createTwofish(randomBytes(32))
    const iv = new Uint8Array(randomBytes(16))
    const data = new Uint8Array(randomBytes(1 << 20))
    const enc = cbcEncrypt(c, iv, data)
    const start = performance.now()
    const dec = cbcDecrypt(c, iv, enc)
    const ms = performance.now() - start
    expect(Buffer.compare(dec, data)).toBe(0)
    expect(ms).toBeLessThan(1000)
  })

  it('encrypts in place (input and output the same buffer)', () => {
    const c = createTwofish(new Uint8Array(16))
    const buf = new Uint8Array(32)
    c.encryptBlock(buf, 16, buf, 16)
    expect(toHex(buf.subarray(16))).toBe(CHAIN_128[0])
    c.decryptBlock(buf, 16, buf, 16)
    expect(toHex(buf)).toBe('00'.repeat(32))
  })
})

describe('Twofish input validation', () => {
  it.each([0, 1, 15, 17, 20, 31, 33, 64])('rejects a %i-byte key', (n) => {
    expect(() => createTwofish(new Uint8Array(n))).toThrow(CipherError)
  })

  it('rejects offsets that do not leave a full block', () => {
    const c = createTwofish(new Uint8Array(32))
    const buf = new Uint8Array(32)
    const out = new Uint8Array(32)
    for (const bad of [-1, 17, 32, 1.5, Number.NaN]) {
      expect(() => c.encryptBlock(buf, bad, out, 0)).toThrow(CipherError)
      expect(() => c.decryptBlock(buf, 0, out, bad)).toThrow(CipherError)
    }
    expect(() => c.encryptBlock(new Uint8Array(15), 0, out, 0)).toThrow(CipherError)
    expect(() => c.decryptBlock(buf, 0, new Uint8Array(15), 0)).toThrow(CipherError)
    // The last full block is accepted.
    expect(() => c.encryptBlock(buf, 16, out, 16)).not.toThrow()
  })

  it('does not write output when validation fails', () => {
    const c = createTwofish(new Uint8Array(32))
    const out = new Uint8Array(20).fill(7)
    expect(() => c.encryptBlock(new Uint8Array(16), 0, out, 5)).toThrow(CipherError)
    expect(out.every((b) => b === 7)).toBe(true)
  })

  it('throws after dispose and zeroes its key schedule', () => {
    const c = createTwofish(new Uint8Array(randomBytes(32)))
    c.dispose()
    const buf = new Uint8Array(16)
    expect(() => c.encryptBlock(buf, 0, buf, 0)).toThrow(CipherError)
    expect(() => c.decryptBlock(buf, 0, buf, 0)).toThrow(CipherError)
    // Inspect the private tables: every word must be zero.
    const internals = c as unknown as Record<string, unknown>
    const tables = Object.values(internals).filter((v) => v instanceof Uint32Array)
    expect(tables).toHaveLength(5)
    for (const t of tables) expect((t as Uint32Array).every((w) => w === 0)).toBe(true)
  })
})
