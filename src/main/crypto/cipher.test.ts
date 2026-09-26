import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BLOCK_SIZE,
  type BlockCipher,
  CipherError,
  cbcDecrypt,
  cbcEncrypt,
  ecbDecrypt,
  ecbEncrypt,
} from './cipher'

// Reference block cipher: AES-256 single-block ECB from Node, used only to test the modes.
function aesBlockCipher(key: Uint8Array): BlockCipher {
  const run = (
    decrypt: boolean,
    input: Uint8Array,
    inOff: number,
    output: Uint8Array,
    outOff: number,
  ) => {
    const c = decrypt
      ? createDecipheriv('aes-256-ecb', key, null)
      : createCipheriv('aes-256-ecb', key, null)
    c.setAutoPadding(false)
    const res = Buffer.concat([c.update(input.subarray(inOff, inOff + BLOCK_SIZE)), c.final()])
    output.set(res, outOff)
  }
  return {
    encryptBlock: (i, io, o, oo) => run(false, i, io, o, oo),
    decryptBlock: (i, io, o, oo) => run(true, i, io, o, oo),
    dispose: () => {},
  }
}

describe('cipher modes', () => {
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const cipher = aesBlockCipher(key)

  it('ECB matches Node aes-256-ecb', () => {
    const pt = randomBytes(BLOCK_SIZE * 5)
    const ref = createCipheriv('aes-256-ecb', key, null).setAutoPadding(false)
    const expected = Buffer.concat([ref.update(pt), ref.final()])
    const ct = ecbEncrypt(cipher, pt)
    expect(Buffer.from(ct)).toEqual(expected)
    expect(Buffer.from(ecbDecrypt(cipher, ct))).toEqual(pt)
  })

  it('CBC matches Node aes-256-cbc', () => {
    const pt = randomBytes(BLOCK_SIZE * 7)
    const ref = createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false)
    const expected = Buffer.concat([ref.update(pt), ref.final()])
    const ct = cbcEncrypt(cipher, iv, pt)
    expect(Buffer.from(ct)).toEqual(expected)
    expect(Buffer.from(cbcDecrypt(cipher, iv, ct))).toEqual(pt)
  })

  it('handles empty input', () => {
    expect(cbcEncrypt(cipher, iv, new Uint8Array(0)).length).toBe(0)
    expect(ecbDecrypt(cipher, new Uint8Array(0)).length).toBe(0)
  })

  it('rejects partial blocks and bad IVs instead of truncating', () => {
    expect(() => ecbEncrypt(cipher, new Uint8Array(15))).toThrow(CipherError)
    expect(() => cbcDecrypt(cipher, iv, new Uint8Array(17))).toThrow(CipherError)
    expect(() => cbcEncrypt(cipher, new Uint8Array(8), new Uint8Array(16))).toThrow(CipherError)
  })
})
