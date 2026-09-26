import { describe, expect, it } from 'vitest'
import {
  bytesEqual,
  decodeText,
  decodeTime,
  decodeTimeIso,
  decodeUuid,
  decodeVersion,
  encodeText,
  encodeTime,
  encodeUuid,
  historyCount,
  newUuidBytes,
} from './fields'

const b = (...x: number[]) => Uint8Array.from(x)
const ascii = (s: string) => new TextEncoder().encode(s)

describe('Text (§3.1.2)', () => {
  it('round-trips UTF-8 including astral characters, without BOM or terminator', () => {
    const s = 'Grüße 🔑 \u0000 end'
    const data = encodeText(s)
    expect(data[0]).not.toBe(0xef)
    expect(decodeText(data)).toBe(s)
  })
  it('keeps a leading BOM as text rather than stripping it', () => {
    expect(decodeText(b(0xef, 0xbb, 0xbf, 0x41))).toBe('﻿A')
  })
  it('returns undefined for invalid UTF-8', () => {
    expect(decodeText(b(0xff, 0xfe))).toBeUndefined()
    expect(decodeText(b(0xc3))).toBeUndefined()
  })
  it('empty data is the empty string', () => {
    expect(decodeText(new Uint8Array(0))).toBe('')
  })
})

describe('UUID (§3.1.1)', () => {
  it('is 16 bytes shown as 32 lowercase hex digits', () => {
    const data = b(...Array.from({ length: 16 }, (_, i) => i * 17))
    const hex = decodeUuid(data)!
    expect(hex).toBe('00112233445566778899aabbccddeeff')
    expect(bytesEqual(encodeUuid(hex.toUpperCase())!, data)).toBe(true)
  })
  it('rejects other lengths', () => {
    expect(decodeUuid(new Uint8Array(15))).toBeUndefined()
    expect(decodeUuid(new Uint8Array(17))).toBeUndefined()
    expect(encodeUuid('xyz')).toBeUndefined()
  })
  it('new UUIDs are RFC 4122 version 4', () => {
    const u = newUuidBytes(() => new Uint8Array(16).fill(0xff))
    expect(u[6]! >> 4).toBe(4)
    expect(u[8]! >> 6).toBe(2)
  })
})

describe('Time (§3.1.3)', () => {
  it('reads 32-bit little-endian seconds', () => {
    expect(decodeTime(encodeTime(1_700_000_000))).toBe(1_700_000_000)
    expect(decodeTimeIso(b(0x00, 0x00, 0x00, 0x80))).toBe('2038-01-19T03:14:08.000Z')
  })
  it('reads the 40-bit form', () => {
    expect(decodeTime(b(0, 0, 0, 0, 1))).toBe(2 ** 32)
  })
  it('reads the legacy 8-character hex ASCII form', () => {
    expect(decodeTime(ascii('6553f100'))).toBe(0x6553f100)
  })
  it('reads 8 non-hex bytes as 64-bit little-endian', () => {
    expect(decodeTime(b(0x00, 0xf1, 0x53, 0x65, 0, 0, 0, 0))).toBe(0x6553f100)
  })
  it('treats 0 as unset and other lengths as unreadable', () => {
    expect(decodeTime(b(0, 0, 0, 0))).toBeUndefined()
    expect(decodeTime(b(1, 2, 3))).toBeUndefined()
    expect(decodeTime(new Uint8Array(0))).toBeUndefined()
  })
  it('encodes as 4 bytes little-endian', () => {
    expect([...encodeTime(0x01020304)]).toEqual([4, 3, 2, 1])
  })
})

describe('Version (§3.2 [1])', () => {
  it('0x0311 is stored as 11 03', () => {
    expect(decodeVersion(b(0x11, 0x03))).toBe(0x0311)
    expect(decodeVersion(b(0x11))).toBeUndefined()
  })
})

describe('Password history header (§3.3 [12])', () => {
  it('reads the current count', () => {
    expect(historyCount(ascii('10301655f00000004bold'))).toBe(1)
    expect(historyCount(ascii('00000'))).toBe(0)
    expect(historyCount(ascii('zz'))).toBeUndefined()
  })
})
