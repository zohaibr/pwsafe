// TEST ONLY. Builds V3 files from an arbitrary plaintext field stream so malformed-input tests can
// control every byte, with a cheap synchronous stretch (2,048 rounds) and a fixed P' cache.
import { randomBytes } from 'node:crypto'
import type { BlockCipherFactory } from '../../crypto/cipher'
import { assemble, type CodecDeps, type VaultModel } from '../codec'
import { serializeFieldStream } from '../format'
import { type StretchFn, stretchKeySync } from '../stretch'

export const TEST_PASSWORD = new TextEncoder().encode('correct horse battery staple')
export const FAST_ITERATIONS = 2_048

/** Runs the reference stretch on the calling thread (fast for 2,048 rounds). */
export const syncStretch: StretchFn = async (password, salt, iterations) =>
  stretchKeySync(password, salt, iterations)

export interface Parts {
  salt: Uint8Array
  k: Uint8Array
  l: Uint8Array
  iv: Uint8Array
  pPrime: Uint8Array
  iterations: number
}

export function freshParts(iterations = FAST_ITERATIONS, password = TEST_PASSWORD): Parts {
  const salt = new Uint8Array(randomBytes(32))
  return {
    salt,
    k: new Uint8Array(randomBytes(32)),
    l: new Uint8Array(randomBytes(32)),
    iv: new Uint8Array(randomBytes(16)),
    pPrime: stretchKeySync(password, salt, iterations),
    iterations,
  }
}

export function plainOf(model: VaultModel, parts: Parts): { plain: Uint8Array; hmac: Uint8Array } {
  return serializeFieldStream(
    model.header,
    model.records,
    parts.l,
    (n) => new Uint8Array(randomBytes(n)),
  )
}

/** Assembles a file around `plain` with the given HMAC (for tampering tests). */
export function fileFrom(
  plain: Uint8Array,
  hmac: Uint8Array,
  parts: Parts,
  cipherFactory: BlockCipherFactory,
): Promise<Uint8Array> {
  return assemble(
    { password: TEST_PASSWORD, plain, hmac, ...parts },
    { cipherFactory, stretch: syncStretch },
  )
}

export async function fileOf(
  model: VaultModel,
  parts: Parts,
  cipherFactory: BlockCipherFactory,
): Promise<Uint8Array> {
  const { plain, hmac } = plainOf(model, parts)
  return fileFrom(plain, hmac, parts, cipherFactory)
}

export const fastDeps = (cipherFactory: BlockCipherFactory): CodecDeps => ({
  cipherFactory,
  stretch: syncStretch,
})
