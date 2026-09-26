// Data representations of V3 field payloads (format spec v3.31 §3.1).
// Decoders never throw: a payload that does not match its representation decodes to `undefined`
// and the field is still preserved byte-for-byte by the codec.

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const utf8Encoder = new TextEncoder()

/** §3.1.2 Text: UTF-8, no BOM, no terminator. `undefined` when the bytes are not valid UTF-8. */
export function decodeText(data: Uint8Array): string | undefined {
  try {
    return utf8Strict.decode(data)
  } catch {
    return undefined
  }
}

export function encodeText(value: string): Uint8Array {
  return utf8Encoder.encode(value)
}

/** §3.1.1 UUID: 16 bytes, shown as 32 lowercase hex digits (the form used by alias passwords). */
export function decodeUuid(data: Uint8Array): string | undefined {
  if (data.length !== 16) return undefined
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex')
}

export function encodeUuid(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

/** Creates a random RFC 4122 version 4 UUID from 16 random bytes. */
export function newUuidBytes(random: (n: number) => Uint8Array): Uint8Array {
  const b = new Uint8Array(random(16).subarray(0, 16))
  if (b.length !== 16) throw new RangeError('random source returned too few bytes')
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  return b
}

/**
 * §3.1.3 Time: seconds since 1970-01-01 UTC. The spec stores 32-bit little-endian values; it also
 * allows 40-bit values (TOTP start time) and asks readers to accept the pre-3.09 eight-character
 * hex ASCII form. Eight bytes that are not hex are read as a 64-bit little-endian value.
 * Returns `undefined` for other lengths and for 0 ("not set" / "never").
 */
export function decodeTime(data: Uint8Array): number | undefined {
  let secs: number
  if (data.length === 4 || data.length === 5) {
    secs = 0
    for (let i = data.length - 1; i >= 0; i--) secs = secs * 256 + data[i]!
  } else if (data.length === 8) {
    const ascii = String.fromCharCode(...data)
    if (/^[0-9a-fA-F]{8}$/.test(ascii)) {
      secs = parseInt(ascii, 16)
    } else {
      const v = Buffer.from(data.buffer, data.byteOffset, 8).readBigUInt64LE(0)
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
      secs = Number(v)
    }
  } else {
    return undefined
  }
  return secs === 0 ? undefined : secs
}

/** Time as an ISO 8601 string, or `undefined` when unset or out of the Date range. */
export function decodeTimeIso(data: Uint8Array): string | undefined {
  const secs = decodeTime(data)
  if (secs === undefined) return undefined
  const d = new Date(secs * 1000)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** Encodes seconds since the epoch as the standard 4-byte little-endian time_t. */
export function encodeTime(secs: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, Math.max(0, Math.min(0xffffffff, Math.floor(secs))), true)
  return out
}

/** Header Version (§3.2 [1]): 2 bytes little-endian, e.g. 0x0311 is stored as 11 03. */
export function decodeVersion(data: Uint8Array): number | undefined {
  if (data.length !== 2) return undefined
  return data[0]! | (data[1]! << 8)
}

/**
 * Password history (§3.3 [12]) header "fmmnn": returns the current number of stored passwords,
 * or `undefined` when the header cannot be read.
 */
export function historyCount(data: Uint8Array): number | undefined {
  if (data.length < 5) return undefined
  const head = String.fromCharCode(...data.subarray(0, 5))
  if (!/^[01][0-9a-fA-F]{4}$/.test(head)) return undefined
  return parseInt(head.slice(3, 5), 16)
}

/** Byte-wise equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
