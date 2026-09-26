// `.plk` content encoding (docs/execution-plan.md §A6). Password Safe writes `user@host:pid` as
// wide characters with no terminator: wchar_t is 4 bytes on macOS and Linux (UTF-32LE) and 2 bytes
// on Windows (UTF-16LE). The pid is zero-padded to 8 digits (pws_os::getprocessid @ 1.25.0).
// We read ASCII/UTF-8, UTF-16LE and UTF-32LE, and write the platform's native encoding.

export type LockPlatform = 'darwin' | 'linux' | 'win32'

export interface LockHolder {
  user: string
  host: string
  pid: number
}

/** `user@host:pid` with the pid zero-padded to at least 8 digits, as Password Safe writes it. */
export function formatLocker(holder: LockHolder): string {
  return `${holder.user}@${holder.host}:${String(holder.pid).padStart(8, '0')}`
}

export function encodeUtf32le(text: string): Uint8Array {
  const cps = Array.from(text, (c) => c.codePointAt(0)!)
  const out = new Uint8Array(cps.length * 4)
  const view = new DataView(out.buffer)
  cps.forEach((cp, i) => view.setUint32(i * 4, cp, true))
  return out
}

export function encodeUtf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
  return out
}

/** Encodes lock content in the platform's native wide-character encoding. */
export function encodeLocker(text: string, platform: LockPlatform): Uint8Array {
  return platform === 'win32' ? encodeUtf16le(text) : encodeUtf32le(text)
}

function looksUtf32le(b: Uint8Array): boolean {
  if (b.length === 0 || b.length % 4 !== 0) return false
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < b.length; i += 4) {
    const cp = view.getUint32(i, true)
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false
  }
  return true
}

function stripNulsAndBom(bytes: Uint8Array, unit: number): Uint8Array {
  let end = bytes.length
  // Trailing NUL terminators (not written by Password Safe, tolerated on read).
  while (end >= unit && bytes.subarray(end - unit, end).every((x) => x === 0)) end -= unit
  return bytes.subarray(0, end)
}

/**
 * Decodes `.plk` content written by any Password Safe build. Returns undefined when the bytes are
 * not valid text in any of the accepted encodings.
 */
export function decodeLocker(raw: Uint8Array): string | undefined {
  let text: string | undefined
  if (!raw.includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      return undefined
    }
  } else {
    const as32 = stripNulsAndBom(raw, 4)
    if (looksUtf32le(as32)) {
      const view = new DataView(as32.buffer, as32.byteOffset, as32.byteLength)
      const cps: number[] = []
      for (let i = 0; i < as32.length; i += 4) cps.push(view.getUint32(i, true))
      text = String.fromCodePoint(...cps)
    } else {
      const as16 = stripNulsAndBom(raw, 2)
      if (as16.length % 2 !== 0) return undefined
      try {
        text = new TextDecoder('utf-16le', { fatal: true }).decode(as16)
      } catch {
        return undefined
      }
      if (text.includes('\u0000')) return undefined
    }
  }
  if (text.startsWith('﻿')) text = text.slice(1)
  return text
}

/**
 * Splits `user@host:pid` the way Password Safe's PWSUtil::GetLockerData does: user up to the first
 * '@', host up to the next ':', then a non-negative decimal pid. Undefined when any part is missing.
 */
export function parseLocker(text: string): LockHolder | undefined {
  const at = text.indexOf('@')
  if (at <= 0) return undefined
  const rest = text.slice(at + 1)
  const colon = rest.indexOf(':')
  if (colon <= 0) return undefined
  const pidText = rest.slice(colon + 1).trim()
  if (!/^\d{1,10}$/.test(pidText)) return undefined
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return undefined
  return { user: text.slice(0, at), host: rest.slice(0, colon), pid }
}
