// Checks Twofish against a real Password Safe V3 file: the pypwsafe test safes, fetched by
// `npm run fixtures:pypwsafe` (not committed). This is a minimal test-only reading of the V3
// format; the real codec lives in src/main/psafe3 (WP2).
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cbcDecrypt, ecbDecrypt } from '../cipher'
import { createTwofish } from './twofish'

const FIXTURE_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'pypwsafe',
)
const FIXTURES = ['simple.psafe3', 'VersionTest.psafe3', 'passwordPolicyTest.psafe3']
const PASSWORD = 'bogus12345'
const EOF_MARKER = Buffer.from('PWS3-EOFPWS3-EOF', 'latin1')

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

function checkFixture(file: Buffer): void {
  // Header: TAG(4) SALT(32) ITER(4) H(P')(32) B1B2(32) B3B4(32) IV(16).
  expect(file.subarray(0, 4).toString('latin1')).toBe('PWS3')
  const salt = file.subarray(4, 36)
  const iter = file.readUInt32LE(36)
  const hp = file.subarray(40, 72)
  const b1b4 = file.subarray(72, 136)
  const iv = file.subarray(136, 152)

  // Key stretching: X0 = SHA256(P || salt), then iter times Xi = SHA256(Xi-1); P' = X_iter.
  let p: Buffer = sha256(Buffer.from(PASSWORD, 'utf8'), salt)
  for (let i = 0; i < iter; i++) p = sha256(p)
  expect(sha256(p).equals(hp)).toBe(true)

  // K = Twofish-ECB-decrypt(P', B1B2), L = Twofish-ECB-decrypt(P', B3B4).
  const keyCipher = createTwofish(p)
  const kl = ecbDecrypt(keyCipher, b1b4)
  keyCipher.dispose()
  const k = kl.subarray(0, 32)
  const l = kl.subarray(32, 64)

  // Encrypted fields run from offset 152 up to the plaintext EOF block, then the 32-byte HMAC.
  const eof = file.indexOf(EOF_MARKER, 152)
  expect(eof).toBeGreaterThan(152)
  expect((eof - 152) % 16).toBe(0)
  expect(file.length).toBe(eof + 16 + 32)
  const hmacStored = file.subarray(eof + 16)

  const fieldCipher = createTwofish(k)
  const plain = cbcDecrypt(fieldCipher, iv, file.subarray(152, eof))
  fieldCipher.dispose()

  // Each field: length(4, LE) type(1) data(length), padded to a multiple of 16 bytes.
  // The HMAC covers the data bytes of every field, in order.
  const mac = createHmac('sha256', l)
  let off = 0
  let fields = 0
  while (off < plain.length) {
    const len = Buffer.from(plain.buffer, plain.byteOffset + off, 4).readUInt32LE(0)
    expect(5 + len).toBeLessThanOrEqual(plain.length - off)
    mac.update(plain.subarray(off + 5, off + 5 + len))
    off += Math.max(16, Math.ceil((5 + len) / 16) * 16)
    fields++
  }
  expect(off).toBe(plain.length)
  expect(fields).toBeGreaterThan(1)
  expect(mac.digest().equals(hmacStored)).toBe(true)
}

describe('Twofish against pypwsafe V3 fixtures', () => {
  for (const name of FIXTURES) {
    const path = join(FIXTURE_DIR, name)
    const present = existsSync(path)
    it.skipIf(!present)(
      `${name}: B1-B4 decrypt to K and L that verify the file HMAC${present ? '' : ' (skipped: fixture missing, run `npm run fixtures:pypwsafe`)'}`,
      () => {
        checkFixture(readFileSync(path))
      },
    )
  }
})
