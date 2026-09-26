// TEST ONLY. Helpers for the vault, lock file and fault-injection tests: a deterministic random
// source, a fast stand-in for key stretching, and synthetic vault files.
import { createHash } from 'node:crypto'
import { createTwofish } from '../crypto/twofish/twofish'
import type { LockPlatform } from '../lockfile/encoding'
import { assemble, type CodecDeps, encode, type VaultModel } from '../psafe3/codec'
import { serializeFieldStream } from '../psafe3/format'
import type { StretchFn } from '../psafe3/stretch'
import { FieldType, HeaderFieldType, type RawField } from '../../shared/types'
import { encodeText, encodeTime } from '../psafe3/fields'
import type { MemoryFileSystem } from '../fs/memoryFs'
import { Vault, type VaultDeps } from './vault'

export const PASSWORD = new TextEncoder().encode('test master password')
export const OTHER_PASSWORD = new TextEncoder().encode('an older master password')

/** Deterministic byte source: SHA-256 in counter mode over a seed. */
export function seededRandom(seed: string): (n: number) => Uint8Array {
  let counter = 0
  let pool = new Uint8Array(0)
  return (n) => {
    while (pool.length < n) {
      const block = createHash('sha256').update(`${seed}:${counter++}`).digest()
      const next = new Uint8Array(pool.length + block.length)
      next.set(pool, 0)
      next.set(block, pool.length)
      pool = next
    }
    const out = pool.slice(0, n)
    pool = pool.slice(n)
    return out
  }
}

/**
 * Stand-in for key stretching: one SHA-256 of password || salt, whatever the iteration count.
 * Keeps the fault-injection suite fast; the real-disk test uses the real worker stretch.
 */
export const fastStretch: StretchFn = async (password, salt, _iterations, options) => {
  options?.onProgress?.(1)
  return new Uint8Array(createHash('sha256').update(password).update(salt).digest())
}

export function fastCodec(seed = 'codec'): CodecDeps {
  return { cipherFactory: createTwofish, stretch: fastStretch, randomBytes: seededRandom(seed) }
}

export const text = (type: number, value: string): RawField => ({ type, data: encodeText(value) })

export function uuidBytes(n: number): Uint8Array {
  const b = new Uint8Array(16)
  b[0] = 0xab
  b[15] = n
  return b
}
export const uuidHex = (n: number): string =>
  'ab' + '00'.repeat(14) + n.toString(16).padStart(2, '0')

export function versionField(version = 0x0311): RawField {
  return { type: HeaderFieldType.VERSION, data: Uint8Array.from([version & 0xff, version >> 8]) }
}

/** A small vault: three normal entries, an alias of entry 1, a protected entry, an empty group. */
export function smallModel(version = 0x0311): VaultModel {
  return {
    header: [
      versionField(version),
      { type: HeaderFieldType.UUID, data: new Uint8Array(16).fill(3) },
      text(HeaderFieldType.LAST_SAVED_BY_USER, 'someone'),
      text(HeaderFieldType.EMPTY_GROUPS, 'Archive.Old'),
      { type: 0xe7, data: Uint8Array.from([9, 8, 7]) },
    ],
    records: [
      {
        fields: [
          { type: FieldType.UUID, data: uuidBytes(1) },
          text(FieldType.GROUP, 'Banking'),
          text(FieldType.TITLE, 'Bank'),
          text(FieldType.USERNAME, 'jordan'),
          text(FieldType.PASSWORD, 'bank-secret'),
          { type: FieldType.LAST_MOD_TIME, data: encodeTime(1_700_000_000) },
          { type: 0xdf, data: Uint8Array.from([0xde, 0xad]) },
        ],
      },
      {
        fields: [
          { type: FieldType.UUID, data: uuidBytes(2) },
          text(FieldType.GROUP, 'Banking.Cards'),
          text(FieldType.TITLE, 'Card'),
          text(FieldType.PASSWORD, 'card-secret'),
          text(FieldType.URL, 'https://card.example'),
        ],
      },
      {
        fields: [
          { type: FieldType.UUID, data: uuidBytes(3) },
          text(FieldType.TITLE, 'Mail'),
          text(FieldType.PASSWORD, 'mail-secret'),
          text(FieldType.EMAIL, 'me@example.com'),
        ],
      },
      {
        fields: [
          { type: FieldType.UUID, data: uuidBytes(4) },
          text(FieldType.TITLE, 'Bank alias'),
          text(FieldType.PASSWORD, `[[${uuidHex(1)}]]`),
        ],
      },
      {
        fields: [
          { type: FieldType.UUID, data: uuidBytes(5) },
          text(FieldType.TITLE, 'Protected'),
          text(FieldType.PASSWORD, 'locked'),
          { type: FieldType.PROTECTED, data: Uint8Array.from([1]) },
        ],
      },
    ],
  }
}

/** Encodes a model with the fast codec (iterations raised to 262,144 in the header only). */
export async function encodeModel(
  model: VaultModel,
  password = PASSWORD,
  options: { iterations?: number; seed?: string } = {},
): Promise<Uint8Array> {
  const r = await encode(model, password, fastCodec(options.seed ?? 'encode'), {
    iterations: options.iterations ?? 262_144,
  })
  if (!r.ok) throw new Error(`encode failed: ${r.error.code}`)
  return r.value
}

/** Writes any header (including a newer format version encode() refuses) with the fast stretch. */
export async function assembleModel(model: VaultModel, password = PASSWORD): Promise<Uint8Array> {
  const random = seededRandom('assemble')
  const l = random(32)
  const { plain, hmac } = serializeFieldStream(model.header, model.records, l, random)
  const salt = random(32)
  return assemble(
    {
      password,
      iterations: 2_048,
      plain,
      hmac,
      salt,
      k: random(32),
      l,
      iv: random(16),
    },
    { cipherFactory: createTwofish, stretch: fastStretch },
  )
}

export const USER = 'alex'
export const HOST = 'studio'
export const PID = 4312

export interface TestVaultOptions {
  platform?: LockPlatform
  pid?: number
  user?: string
  host?: string
  processExists?: (pid: number) => boolean | undefined
  seed?: string
  onSaveStep?: (step: number) => void
  log?: (msg: string) => void
  codec?: CodecDeps
}

export function makeVault(fs: MemoryFileSystem | VaultDeps['fs'], o: TestVaultOptions = {}): Vault {
  const deps: VaultDeps = {
    fs,
    platform: o.platform ?? 'linux',
    identity: { user: o.user ?? USER, host: o.host ?? HOST, pid: o.pid ?? PID },
    processExists: o.processExists ?? (() => true),
    codec: o.codec ?? fastCodec(o.seed ?? 'vault'),
    now: () => 1_750_000_000_000,
    appName: 'psafe3 Opener test',
    sleep: async () => {},
  }
  if (o.onSaveStep) deps.onSaveStep = o.onSaveStep
  if (o.log) deps.log = o.log
  return new Vault(deps)
}

export function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } },
): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}
