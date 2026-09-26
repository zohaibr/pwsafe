// Password Safe V3 codec: file bytes + passphrase <-> { header, records, meta }
// (docs/execution-plan.md §A1, §A2, §A4; format spec v3.31 §2). Written from the spec only.
//
// decode() runs the §A4 open sequence in order and returns a Result; nothing decrypted is returned
// unless every step passes, and it never throws. encode() writes a fresh salt, K, L, IV and padding.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  BLOCK_SIZE,
  type BlockCipher,
  type BlockCipherFactory,
  cbcDecrypt,
  cbcEncrypt,
  ecbDecrypt,
  ecbEncrypt,
} from '../crypto/cipher'
import { DEFAULT_MESSAGES, ErrorCode, fail, ok, type Result } from '../../shared/errors'
import {
  FORMAT_MAJOR,
  FORMAT_MAX_WRITABLE_MINOR,
  MAX_FILE_BYTES,
  MAX_ITERATIONS_READ,
  MIN_FILE_BYTES,
  MIN_ITERATIONS_READ,
  MIN_ITERATIONS_WRITE,
} from '../../shared/limits'
import { HeaderFieldType, type RawField, type RawRecord } from '../../shared/types'
import { decodeVersion } from './fields'
import {
  B1_OFFSET,
  BODY_OFFSET,
  EOF_MARKER,
  EncodeLimitError,
  FramingError,
  HMAC_BYTES,
  HP_OFFSET,
  ITER_OFFSET,
  IV_OFFSET,
  SALT_OFFSET,
  TAG,
  TRAILER_BYTES,
  parseFieldStream,
  serializeFieldStream,
} from './format'
import { StretchCancelledError, type StretchFn, stretchKeyInWorker } from './stretch'

export interface CodecDeps {
  /** Twofish in production (WP1). Any 128-bit block cipher taking a 256-bit key works for tests. */
  cipherFactory: BlockCipherFactory
  /** Key stretching. Defaults to the worker-thread implementation. */
  stretch?: StretchFn
  /** Random bytes for salt, K, L, IV, new UUIDs and padding. Defaults to crypto.randomBytes. */
  randomBytes?: (n: number) => Uint8Array
}

export interface DecodeOptions {
  /** Stretching progress, 0..1. */
  onProgress?: (fraction: number) => void
  /** Aborting resolves the decode with CANCELLED. */
  signal?: AbortSignal
}

export interface VaultMeta {
  /** Key-stretch iterations stored in the file. */
  iterations: number
  /** Header Version field, e.g. 0x030b. */
  formatVersion: number
  /** Set when the file must open read-only: a newer V3 minor than we can write (§A1). */
  readOnlyReason?: 'newer-format'
}

/** Everything in the file: the header and records exactly as stored, in file order. */
export interface VaultModel {
  /** Header fields in file order, starting with Version; END is implicit. */
  header: RawField[]
  records: RawRecord[]
}

export interface DecodedVault extends VaultModel {
  meta: VaultMeta
}

export interface EncodeOptions {
  /** Key-stretch iterations; raised to MIN_ITERATIONS_WRITE. Defaults to MIN_ITERATIONS_WRITE. */
  iterations?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

const err = <T>(code: ErrorCode, detail?: string): Result<T> =>
  fail<T>(code, DEFAULT_MESSAGES[code], detail)

const ITERATIONS_MESSAGE =
  'This file uses more key-stretching rounds than this app supports, so it cannot be opened. It was not changed.'

/** Best-effort overwrite of a secret buffer. */
function wipe(...bufs: (Uint8Array | undefined)[]): void {
  for (const b of bufs) b?.fill(0)
}

function withCipher<T>(factory: BlockCipherFactory, key: Uint8Array, fn: (c: BlockCipher) => T): T {
  const c = factory(key)
  try {
    return fn(c)
  } finally {
    c.dispose()
  }
}

function startsWith(bytes: Uint8Array, offset: number, prefix: Uint8Array): boolean {
  if (bytes.length < offset + prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[offset + i] !== prefix[i]) return false
  return true
}

/**
 * Finds the EOF block (A4.5): it must appear exactly once, on a block boundary after the start of
 * the body, followed by exactly the 32-byte HMAC. Returns the body end offset or `undefined`.
 */
function locateEof(bytes: Uint8Array): number | undefined {
  let found: number | undefined
  for (let p = BODY_OFFSET; p + EOF_MARKER.length <= bytes.length; p += BLOCK_SIZE) {
    if (startsWith(bytes, p, EOF_MARKER)) {
      if (found !== undefined) return undefined // duplicate EOF
      found = p
    }
  }
  if (found === undefined || found + TRAILER_BYTES !== bytes.length) return undefined
  return found
}

function toKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/**
 * Opens a V3 file. Steps and their errors, in this order (§A4):
 * 1 size (CORRUPT_FILE / TOO_LARGE), 2 tag (UNSUPPORTED_FORMAT), 3 iterations (UNSUPPORTED_FORMAT),
 * 4 stretch + H(P') (WRONG_PASSWORD; CANCELLED), 5 EOF/alignment (CORRUPT_FILE),
 * 6 framing and limits (CORRUPT_FILE), 7 HMAC (INTEGRITY_FAILED), then the Version major byte
 * (UNSUPPORTED_FORMAT). The caller keeps ownership of `password`.
 */
export async function decode(
  bytes: Uint8Array,
  password: Uint8Array,
  deps: CodecDeps,
  options: DecodeOptions = {},
): Promise<Result<DecodedVault>> {
  // 1. Size bounds.
  if (bytes.length > MAX_FILE_BYTES) return err(ErrorCode.TOO_LARGE)
  if (bytes.length < MIN_FILE_BYTES) return err(ErrorCode.CORRUPT_FILE, 'file is too short')
  // 2. Tag.
  if (!startsWith(bytes, 0, TAG)) return err(ErrorCode.UNSUPPORTED_FORMAT)
  // 3. Iterations.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const iterations = view.getUint32(ITER_OFFSET, true)
  if (iterations < MIN_ITERATIONS_READ || iterations > MAX_ITERATIONS_READ) {
    return fail(ErrorCode.UNSUPPORTED_FORMAT, ITERATIONS_MESSAGE, `iterations ${iterations}`)
  }
  if (options.signal?.aborted) return err(ErrorCode.CANCELLED)

  // 4. Stretch the key and check H(P').
  const stretch = deps.stretch ?? stretchKeyInWorker
  const salt = bytes.slice(SALT_OFFSET, SALT_OFFSET + 32)
  let pPrime: Uint8Array
  try {
    const stretchOpts: { onProgress?: (f: number) => void; signal?: AbortSignal } = {}
    if (options.onProgress) stretchOpts.onProgress = options.onProgress
    if (options.signal) stretchOpts.signal = options.signal
    pPrime = await stretch(password, salt, iterations, stretchOpts)
  } catch (e) {
    if (e instanceof StretchCancelledError || options.signal?.aborted) {
      return err(ErrorCode.CANCELLED)
    }
    return err(ErrorCode.IO_ERROR, 'key stretching failed')
  }
  if (options.signal?.aborted) {
    wipe(pPrime)
    return err(ErrorCode.CANCELLED)
  }
  const hp = createHash('sha256').update(pPrime).digest()
  const stored = bytes.subarray(HP_OFFSET, HP_OFFSET + 32)
  if (!timingSafeEqual(hp, stored)) {
    wipe(pPrime)
    return err(ErrorCode.WRONG_PASSWORD)
  }

  let kl: Uint8Array | undefined
  let plain: Uint8Array | undefined
  try {
    // 5. EOF and alignment; decrypt K and L (ECB) and the body (CBC).
    const bodyEnd = locateEof(bytes)
    if (bodyEnd === undefined)
      return err(ErrorCode.CORRUPT_FILE, 'end-of-file marker is missing or misplaced')
    kl = withCipher(deps.cipherFactory, pPrime, (c) =>
      ecbDecrypt(c, bytes.subarray(B1_OFFSET, B1_OFFSET + 64)),
    )
    const k = kl.subarray(0, 32)
    const l = kl.subarray(32, 64)
    const iv = bytes.subarray(IV_OFFSET, IV_OFFSET + BLOCK_SIZE)
    plain = withCipher(deps.cipherFactory, k, (c) =>
      cbcDecrypt(c, iv, bytes.subarray(BODY_OFFSET, bodyEnd)),
    )

    // 6. Framing and limits (HMAC is computed here but judged only in step 7).
    let parsed
    try {
      parsed = parseFieldStream(plain, l)
    } catch (e) {
      if (e instanceof FramingError) return err(ErrorCode.CORRUPT_FILE, e.message)
      throw e
    }

    // 7. HMAC.
    const storedMac = bytes.subarray(bodyEnd + EOF_MARKER.length, bodyEnd + TRAILER_BYTES)
    if (storedMac.length !== HMAC_BYTES || !timingSafeEqual(parsed.hmac, storedMac)) {
      wipeModel(parsed)
      return err(ErrorCode.INTEGRITY_FAILED)
    }

    // Version (inside the authenticated data): major must be 3; a newer minor opens read-only.
    const version = decodeVersion(parsed.header[0]!.data)
    if (version === undefined) {
      wipeModel(parsed)
      return err(ErrorCode.CORRUPT_FILE, 'version field has the wrong length')
    }
    if (version >> 8 !== FORMAT_MAJOR) {
      wipeModel(parsed)
      return err(ErrorCode.UNSUPPORTED_FORMAT, `format version ${version.toString(16)}`)
    }
    const meta: VaultMeta = { iterations, formatVersion: version }
    if ((version & 0xff) > FORMAT_MAX_WRITABLE_MINOR) meta.readOnlyReason = 'newer-format'
    return ok({ header: parsed.header, records: parsed.records, meta })
  } catch {
    // Defensive: no input may crash the caller. No detail, since it could reflect file content.
    return err(ErrorCode.CORRUPT_FILE, 'unexpected parser error')
  } finally {
    wipe(pPrime, kl, plain)
  }
}

export interface AssembleInput {
  password: Uint8Array
  iterations: number
  /** Plaintext field stream (header, records, END fields), block aligned. */
  plain: Uint8Array
  /** HMAC to store; normally from serializeFieldStream. */
  hmac: Uint8Array
  salt: Uint8Array
  k: Uint8Array
  l: Uint8Array
  iv: Uint8Array
  /** P' when the caller has already stretched (tests reuse one stretch across many files). */
  pPrime?: Uint8Array
}

/** Low-level writer: lays out TAG..HMAC around an already serialised plaintext stream. */
export async function assemble(
  input: AssembleInput,
  deps: CodecDeps,
  options: { onProgress?: (f: number) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const stretch = deps.stretch ?? stretchKeyInWorker
  const pPrime =
    input.pPrime ?? (await stretch(input.password, input.salt, input.iterations, options))
  let kl: Uint8Array | undefined
  try {
    const hp = createHash('sha256').update(pPrime).digest()
    kl = new Uint8Array(64)
    kl.set(input.k, 0)
    kl.set(input.l, 32)
    const bBlocks = withCipher(deps.cipherFactory, pPrime, (c) => ecbEncrypt(c, kl!))
    const body = withCipher(deps.cipherFactory, input.k, (c) =>
      cbcEncrypt(c, input.iv, input.plain),
    )
    const out = new Uint8Array(BODY_OFFSET + body.length + TRAILER_BYTES)
    const view = new DataView(out.buffer)
    out.set(TAG, 0)
    out.set(input.salt, SALT_OFFSET)
    view.setUint32(ITER_OFFSET, input.iterations, true)
    out.set(hp, HP_OFFSET)
    out.set(bBlocks, B1_OFFSET)
    out.set(input.iv, IV_OFFSET)
    out.set(body, BODY_OFFSET)
    out.set(EOF_MARKER, BODY_OFFSET + body.length)
    out.set(input.hmac, BODY_OFFSET + body.length + EOF_MARKER.length)
    return out
  } finally {
    wipe(kl)
    if (!input.pPrime) wipe(pPrime)
  }
}

function takeRandom(random: (n: number) => Uint8Array, n: number): Uint8Array {
  const b = random(n)
  if (b.length < n) throw new RangeError('random source returned too few bytes')
  return b.slice(0, n)
}

/**
 * Writes a V3 file from a model. The header is written exactly as given (callers update the save
 * metadata with `stampHeaderForSave` first). Iterations are raised to MIN_ITERATIONS_WRITE.
 * Errors: INVALID_ARGUMENT (malformed model), READ_ONLY (newer format), TOO_LARGE, CANCELLED,
 * IO_ERROR (key stretching worker failed).
 */
export async function encode(
  model: VaultModel,
  password: Uint8Array,
  deps: CodecDeps,
  options: EncodeOptions = {},
): Promise<Result<Uint8Array>> {
  const first = model.header[0]
  const version = first?.type === HeaderFieldType.VERSION ? decodeVersion(first.data) : undefined
  if (version === undefined || version >> 8 !== FORMAT_MAJOR) {
    return err(ErrorCode.INVALID_ARGUMENT, 'header must start with a V3 Version field')
  }
  if ((version & 0xff) > FORMAT_MAX_WRITABLE_MINOR) return err(ErrorCode.READ_ONLY)
  const requested = options.iterations ?? MIN_ITERATIONS_WRITE
  if (!Number.isInteger(requested) || requested > MAX_ITERATIONS_READ) {
    return err(ErrorCode.INVALID_ARGUMENT, 'iterations out of range')
  }
  const iterations = Math.max(requested, MIN_ITERATIONS_WRITE)
  if (options.signal?.aborted) return err(ErrorCode.CANCELLED)

  const random = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)))
  const salt = takeRandom(random, 32)
  const k = takeRandom(random, 32)
  const l = takeRandom(random, 32)
  const iv = takeRandom(random, BLOCK_SIZE)
  if (toKey(k) === toKey(l)) return err(ErrorCode.INVALID_ARGUMENT, 'random source is not random')
  let stream: { plain: Uint8Array; hmac: Uint8Array } | undefined
  try {
    try {
      stream = serializeFieldStream(model.header.slice(), model.records, l, random)
    } catch (e) {
      if (e instanceof EncodeLimitError) return err(ErrorCode.INVALID_ARGUMENT, e.message)
      throw e
    }
    if (BODY_OFFSET + stream.plain.length + TRAILER_BYTES > MAX_FILE_BYTES) {
      return err(ErrorCode.TOO_LARGE)
    }
    const stretchOpts: { onProgress?: (f: number) => void; signal?: AbortSignal } = {}
    if (options.onProgress) stretchOpts.onProgress = options.onProgress
    if (options.signal) stretchOpts.signal = options.signal
    const out = await assemble(
      { password, iterations, plain: stream.plain, hmac: stream.hmac, salt, k, l, iv },
      deps,
      stretchOpts,
    )
    if (options.signal?.aborted) return err(ErrorCode.CANCELLED)
    return ok(out)
  } catch (e) {
    if (e instanceof StretchCancelledError || options.signal?.aborted) {
      return err(ErrorCode.CANCELLED)
    }
    return err(ErrorCode.IO_ERROR, 'encoding failed')
  } finally {
    wipe(k, l, stream?.plain)
  }
}

/** Overwrites every field buffer of a model (call on lock). The model is unusable afterwards. */
export function wipeModel(model: { header: RawField[]; records: RawRecord[] }): void {
  for (const f of model.header) f.data.fill(0)
  for (const r of model.records) for (const f of r.fields) f.data.fill(0)
}
