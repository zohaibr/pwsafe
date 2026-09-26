// V3 file layout and the typed-field framing (format spec v3.31 §2, §3):
//   TAG|SALT|ITER|H(P')|B1|B2|B3|B4|IV|HDR|R1..Rn|EOF|HMAC
// Each field: 4-byte little-endian data length, 1-byte type, data; padded with random bytes to a
// multiple of 16. The first block holds up to 11 data bytes.
import { createHmac } from 'node:crypto'
import { BLOCK_SIZE } from '../crypto/cipher'
import { MAX_FIELDS_PER_RECORD, MAX_FIELD_BYTES, MAX_RECORDS } from '../../shared/limits'
import { FieldType, HeaderFieldType, type RawField, type RawRecord } from '../../shared/types'

export const TAG = new Uint8Array([0x50, 0x57, 0x53, 0x33]) // "PWS3"
export const EOF_MARKER = new TextEncoder().encode('PWS3-EOFPWS3-EOF')

export const SALT_OFFSET = 4
export const ITER_OFFSET = 36
export const HP_OFFSET = 40
export const B1_OFFSET = 72 // B1..B4: four 16-byte blocks
export const IV_OFFSET = 136
export const BODY_OFFSET = 152
export const HMAC_BYTES = 32
/** EOF block plus HMAC after the encrypted body. */
export const TRAILER_BYTES = EOF_MARKER.length + HMAC_BYTES

const FIELD_PREFIX = 5 // length (4) + type (1)
const END = FieldType.END

/** Number of 16-byte blocks a field with `dataLength` bytes occupies. */
export function fieldBlocks(dataLength: number): number {
  return Math.max(1, Math.ceil((dataLength + FIELD_PREFIX) / BLOCK_SIZE))
}

/** Thrown by the framing parser; turned into CORRUPT_FILE by the codec. Never carries field data. */
export class FramingError extends Error {
  override name = 'FramingError'
}

export interface ParsedStream {
  header: RawField[]
  records: RawRecord[]
  /** HMAC-SHA-256 over every field's data, keyed with L (spec §2.11). */
  hmac: Uint8Array
}

/**
 * Parses the decrypted field stream (A2.6, A4.6). Checks every length against the remaining bytes
 * and the limits, that the header starts with Version and ends with END, and that every record ends
 * with END. Field data is copied out, so the caller may zero `plain` afterwards.
 */
export function parseFieldStream(plain: Uint8Array, hmacKey: Uint8Array): ParsedStream {
  if (plain.length % BLOCK_SIZE !== 0) throw new FramingError('body is not block aligned')
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const mac = createHmac('sha256', hmacKey)
  let pos = 0
  // Every field copy made so far, wiped if parsing fails part-way.
  const copies: Uint8Array[] = []

  const readField = (where: string): RawField => {
    if (plain.length - pos < BLOCK_SIZE) throw new FramingError(`truncated field in ${where}`)
    const length = view.getUint32(pos, true)
    const type = plain[pos + 4]!
    if (length > MAX_FIELD_BYTES) throw new FramingError(`field too long in ${where}`)
    const span = fieldBlocks(length) * BLOCK_SIZE
    if (span > plain.length - pos) throw new FramingError(`field overruns data in ${where}`)
    const data = plain.slice(pos + FIELD_PREFIX, pos + FIELD_PREFIX + length)
    copies.push(data)
    mac.update(data)
    pos += span
    return { type, data }
  }

  const readFieldList = (where: string, first: RawField | undefined): RawField[] => {
    const fields: RawField[] = []
    let f = first ?? readField(where)
    while (f.type !== END) {
      if (fields.length >= MAX_FIELDS_PER_RECORD)
        throw new FramingError(`too many fields in ${where}`)
      fields.push(f)
      if (pos >= plain.length) throw new FramingError(`missing END in ${where}`)
      f = readField(where)
    }
    // END is implicit in the model, so END data could not be preserved; refuse it instead.
    if (f.data.length !== 0) throw new FramingError(`END field with data in ${where}`)
    return fields
  }

  try {
    if (plain.length === 0) throw new FramingError('empty body')
    const firstHeader = readField('header')
    if (firstHeader.type !== HeaderFieldType.VERSION) {
      throw new FramingError('header does not start with Version')
    }
    const header = readFieldList('header', firstHeader)

    const records: RawRecord[] = []
    while (pos < plain.length) {
      if (records.length >= MAX_RECORDS) throw new FramingError('too many records')
      records.push({ fields: readFieldList(`record ${records.length}`, undefined) })
    }
    return { header, records, hmac: new Uint8Array(mac.digest()) }
  } catch (e) {
    for (const c of copies) c.fill(0)
    throw e
  }
}

export class EncodeLimitError extends Error {
  override name = 'EncodeLimitError'
}

/**
 * Serialises header and records into the plaintext field stream (END fields added) and computes
 * the HMAC. Padding bytes come from `random`.
 */
export function serializeFieldStream(
  header: readonly RawField[],
  records: readonly RawRecord[],
  hmacKey: Uint8Array,
  random: (n: number) => Uint8Array,
): { plain: Uint8Array; hmac: Uint8Array } {
  if (records.length > MAX_RECORDS) throw new EncodeLimitError('too many records')
  const lists: (readonly RawField[])[] = [header, ...records.map((r) => r.fields)]
  let total = 0
  for (const list of lists) {
    if (list.length > MAX_FIELDS_PER_RECORD) throw new EncodeLimitError('too many fields')
    for (const f of list) {
      if (f.type === END) throw new EncodeLimitError('END must not appear in a field list')
      if (!Number.isInteger(f.type) || f.type < 0 || f.type > 0xff) {
        throw new EncodeLimitError('field type out of range')
      }
      if (f.data.length > MAX_FIELD_BYTES) throw new EncodeLimitError('field too long')
      total += fieldBlocks(f.data.length) * BLOCK_SIZE
    }
    total += BLOCK_SIZE // END
  }
  const plain = new Uint8Array(total)
  plain.set(random(total).subarray(0, total))
  const view = new DataView(plain.buffer)
  const mac = createHmac('sha256', hmacKey)
  let pos = 0
  const write = (type: number, data: Uint8Array) => {
    view.setUint32(pos, data.length, true)
    plain[pos + 4] = type
    plain.set(data, pos + FIELD_PREFIX)
    mac.update(data)
    pos += fieldBlocks(data.length) * BLOCK_SIZE
  }
  const empty = new Uint8Array(0)
  for (const list of lists) {
    for (const f of list) write(f.type, f.data)
    write(END, empty)
  }
  return { plain, hmac: new Uint8Array(mac.digest()) }
}
