// Opens a real fixture down to its decrypted field stream and rebuilds files around an edited
// stream, so the §A4 malformed-input corpus can damage specific bytes of real pwsafe-cli files.
// Rebuilt files keep the fixture's salt, iterations and keys (so the memoised stretch applies)
// and, unless told otherwise, the fixture's original HMAC.
import { createHmac } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { expect } from 'vitest'
import { BLOCK_SIZE, type BlockCipher, cbcDecrypt, ecbDecrypt } from '../../src/main/crypto/cipher'
import { createTwofish } from '../../src/main/crypto/twofish/twofish'
import { assemble, decode, type CodecDeps } from '../../src/main/psafe3/codec'
import {
  B1_OFFSET,
  BODY_OFFSET,
  ITER_OFFSET,
  IV_OFFSET,
  SALT_OFFSET,
  TRAILER_BYTES,
  fieldBlocks,
} from '../../src/main/psafe3/format'
import type { ErrorCode, Result } from '../../src/shared/errors'
import { FieldType } from '../../src/shared/types'
import { cachedStretch, deps, type Fixture } from './support'

/** Position of one field in the decrypted stream. */
export interface FieldAt {
  /** Offset of the 4-byte length. */
  pos: number
  length: number
  type: number
  /** Bytes the field occupies, including padding. */
  span: number
}

export interface OpenedFixture {
  fixture: Fixture
  salt: Uint8Array
  iterations: number
  pPrime: Uint8Array
  k: Uint8Array
  l: Uint8Array
  iv: Uint8Array
  /** Decrypted field stream (header, records, END fields, padding). */
  plain: Uint8Array
  /** HMAC stored in the fixture. */
  hmac: Uint8Array
  fields: FieldAt[]
}

function using<T>(key: Uint8Array, fn: (c: BlockCipher) => T): T {
  const c = createTwofish(key)
  try {
    return fn(c)
  } finally {
    c.dispose()
  }
}

/** Walks a well-formed stream (the fixture's own); throws if it is not. */
export function walkFields(plain: Uint8Array): FieldAt[] {
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const out: FieldAt[] = []
  for (let pos = 0; pos < plain.length;) {
    const length = view.getUint32(pos, true)
    const span = fieldBlocks(length) * BLOCK_SIZE
    out.push({ pos, length, type: plain[pos + 4]!, span })
    pos += span
    if (pos > plain.length) throw new Error('fixture stream is not well formed')
  }
  return out
}

export async function openFixture(fixture: Fixture): Promise<OpenedFixture> {
  const b = fixture.bytes
  const salt = b.slice(SALT_OFFSET, SALT_OFFSET + 32)
  const iterations = new DataView(b.buffer, b.byteOffset).getUint32(ITER_OFFSET, true)
  const pPrime = await cachedStretch(fixture.password, salt, iterations)
  const kl = using(pPrime, (c) => ecbDecrypt(c, b.subarray(B1_OFFSET, B1_OFFSET + 64)))
  const k = kl.slice(0, 32)
  const l = kl.slice(32, 64)
  const iv = b.slice(IV_OFFSET, IV_OFFSET + BLOCK_SIZE)
  const bodyEnd = b.length - TRAILER_BYTES
  const plain = using(k, (c) => cbcDecrypt(c, iv, b.subarray(BODY_OFFSET, bodyEnd)))
  const hmac = b.slice(bodyEnd + 16)
  return { fixture, salt, iterations, pPrime, k, l, iv, plain, hmac, fields: walkFields(plain) }
}

/** HMAC over the data of every field, framed by the (possibly edited) lengths in `plain`. */
export function recomputeHmac(o: OpenedFixture, plain: Uint8Array): Uint8Array {
  const mac = createHmac('sha256', o.l)
  for (const f of walkFields(plain)) mac.update(plain.subarray(f.pos + 5, f.pos + 5 + f.length))
  return new Uint8Array(mac.digest())
}

/** Encrypts `plain` into a complete file with the fixture's keys; the stored HMAC by default. */
export function rebuild(
  o: OpenedFixture,
  plain: Uint8Array,
  hmac: Uint8Array = o.hmac,
): Promise<Uint8Array> {
  return assemble(
    {
      password: o.fixture.password,
      iterations: o.iterations,
      plain,
      hmac,
      salt: o.salt,
      k: o.k,
      l: o.l,
      iv: o.iv,
      pPrime: o.pPrime,
    },
    deps,
  )
}

/** Every END field in the stream (the header's, then one per record). */
export const endFields = (o: OpenedFixture) => o.fields.filter((f) => f.type === FieldType.END)

/** Per-case time budget from the plan (§D WP8: each malformed case < 2 s). */
export const CASE_BUDGET_MS = 2_000

/**
 * Decodes `bytes` and checks it fails with one of `codes`, without throwing and within the time
 * budget. Returns the code.
 */
export async function expectRejected(
  o: OpenedFixture,
  bytes: Uint8Array,
  codes: ErrorCode[],
  label: string,
  codecDeps: CodecDeps = deps,
): Promise<ErrorCode> {
  const start = performance.now()
  let r: Result<unknown>
  try {
    r = await decode(bytes, o.fixture.password, codecDeps)
  } catch (e) {
    throw new Error(`${label}: decode threw ${(e as Error).name}`, { cause: e })
  }
  const ms = performance.now() - start
  expect(ms, `${label}: took ${ms.toFixed(0)} ms`).toBeLessThan(CASE_BUDGET_MS)
  expect(r.ok, `${label}: decoded successfully`).toBe(false)
  const code = r.ok ? ('OK' as ErrorCode) : r.error.code
  expect(codes, `${label}: got ${code}`).toContain(code)
  return code
}
