// Block cipher contract and ECB/CBC modes (docs/execution-plan.md §C, WP1).
// WP1 supplies the Twofish implementation of BlockCipher; the modes here are cipher-agnostic.

export const BLOCK_SIZE = 16

export class CipherError extends Error {
  override name = 'CipherError'
}

/** A 128-bit block cipher keyed at construction. Implementations must not keep extra key copies. */
export interface BlockCipher {
  /** Encrypts one 16-byte block from `input` at `inOffset` into `output` at `outOffset`. */
  encryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void
  /** Decrypts one 16-byte block from `input` at `inOffset` into `output` at `outOffset`. */
  decryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void
  /** Overwrites the expanded key schedule with zeros. The instance is unusable afterwards. */
  dispose(): void
}

/** Creates a keyed cipher. V3 only uses 256-bit keys, but KAT tests also cover 128/192. */
export type BlockCipherFactory = (key: Uint8Array) => BlockCipher

function assertBlocks(data: Uint8Array, what: string): void {
  if (data.length % BLOCK_SIZE !== 0) {
    throw new CipherError(`${what} length ${data.length} is not a multiple of ${BLOCK_SIZE}`)
  }
}

function assertIv(iv: Uint8Array): void {
  if (iv.length !== BLOCK_SIZE) {
    throw new CipherError(`IV length ${iv.length} is not ${BLOCK_SIZE}`)
  }
}

export function ecbEncrypt(cipher: BlockCipher, plaintext: Uint8Array): Uint8Array {
  assertBlocks(plaintext, 'Plaintext')
  const out = new Uint8Array(plaintext.length)
  for (let i = 0; i < plaintext.length; i += BLOCK_SIZE) cipher.encryptBlock(plaintext, i, out, i)
  return out
}

export function ecbDecrypt(cipher: BlockCipher, ciphertext: Uint8Array): Uint8Array {
  assertBlocks(ciphertext, 'Ciphertext')
  const out = new Uint8Array(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i += BLOCK_SIZE) cipher.decryptBlock(ciphertext, i, out, i)
  return out
}

export function cbcEncrypt(cipher: BlockCipher, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertIv(iv)
  assertBlocks(plaintext, 'Plaintext')
  const out = new Uint8Array(plaintext.length)
  const block = new Uint8Array(BLOCK_SIZE)
  let prev: Uint8Array = iv
  let prevOffset = 0
  for (let i = 0; i < plaintext.length; i += BLOCK_SIZE) {
    for (let j = 0; j < BLOCK_SIZE; j++) block[j] = plaintext[i + j]! ^ prev[prevOffset + j]!
    cipher.encryptBlock(block, 0, out, i)
    prev = out
    prevOffset = i
  }
  block.fill(0)
  return out
}

export function cbcDecrypt(
  cipher: BlockCipher,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  assertIv(iv)
  assertBlocks(ciphertext, 'Ciphertext')
  const out = new Uint8Array(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i += BLOCK_SIZE) {
    cipher.decryptBlock(ciphertext, i, out, i)
    const prev = i === 0 ? iv : ciphertext
    const prevOffset = i === 0 ? 0 : i - BLOCK_SIZE
    for (let j = 0; j < BLOCK_SIZE; j++) out[i + j] = out[i + j]! ^ prev[prevOffset + j]!
  }
  return out
}
