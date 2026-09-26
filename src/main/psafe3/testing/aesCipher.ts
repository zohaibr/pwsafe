// TEST ONLY. An AES-256 BlockCipher built on node:crypto, standing in for Twofish so the codec's
// framing, HMAC and error paths can be tested before WP1 lands. Files made with it are not valid
// Password Safe files; tests that need real files use loadTwofish().
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { BLOCK_SIZE, type BlockCipher, type BlockCipherFactory } from '../../crypto/cipher'

export const aesTestCipher: BlockCipherFactory = (key: Uint8Array): BlockCipher => {
  let k: Buffer | undefined = Buffer.from(key)
  const run = (
    decrypt: boolean,
    input: Uint8Array,
    inOff: number,
    out: Uint8Array,
    outOff: number,
  ) => {
    if (!k) throw new Error('cipher disposed')
    const c = decrypt
      ? createDecipheriv('aes-256-ecb', k, null)
      : createCipheriv('aes-256-ecb', k, null)
    c.setAutoPadding(false)
    out.set(Buffer.concat([c.update(input.subarray(inOff, inOff + BLOCK_SIZE)), c.final()]), outOff)
  }
  return {
    encryptBlock: (i, io, o, oo) => run(false, i, io, o, oo),
    decryptBlock: (i, io, o, oo) => run(true, i, io, o, oo),
    dispose: () => {
      k?.fill(0)
      k = undefined
    },
  }
}
