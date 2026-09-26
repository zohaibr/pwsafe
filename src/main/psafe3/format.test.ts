import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_FIELDS_PER_RECORD, MAX_FIELD_BYTES } from '../../shared/limits'
import { FieldType, HeaderFieldType, type RawField } from '../../shared/types'
import {
  EncodeLimitError,
  FramingError,
  fieldBlocks,
  parseFieldStream,
  serializeFieldStream,
} from './format'
import { versionField } from './testing/fixtures'

const key = new Uint8Array(32).fill(1)
const rnd = (n: number) => new Uint8Array(randomBytes(n))
const zeros = (n: number) => new Uint8Array(n)

function roundTrip(header: RawField[], records: RawField[][]) {
  const { plain, hmac } = serializeFieldStream(
    header,
    records.map((fields) => ({ fields })),
    key,
    rnd,
  )
  const parsed = parseFieldStream(plain, key)
  expect(Buffer.from(parsed.hmac)).toEqual(Buffer.from(hmac))
  return { plain, parsed }
}

describe('field framing (§3)', () => {
  it('a field takes ceil((len + 5) / 16) blocks, at least one', () => {
    expect([0, 1, 11, 12, 27, 28, 43].map(fieldBlocks)).toEqual([1, 1, 1, 2, 2, 3, 3])
  })

  it('writes length LE, type, data, then random padding', () => {
    const { plain } = roundTrip([versionField(0x030b)], [])
    expect([...plain.subarray(0, 7)]).toEqual([2, 0, 0, 0, HeaderFieldType.VERSION, 0x0b, 0x03])
    // END of the header: length 0, type 0xff.
    expect([...plain.subarray(16, 21)]).toEqual([0, 0, 0, 0, 0xff])
    expect(plain.length).toBe(32)
  })

  const recordTypes = Object.entries(FieldType).filter(([, t]) => t !== FieldType.END)
  const unknownTypes: [string, number][] = [
    ['unassigned 0x31', 0x31],
    ['application 0xc0', 0xc0],
    ['testing 0xdf', 0xdf],
    ['implementation 0xe0', 0xe0],
    ['implementation 0xfe', 0xfe],
  ]
  const lengths = [0, 1, 10, 11, 12, 16, 27, 28, 300]

  it.each([...recordTypes, ...unknownTypes])(
    'record field %s (0x%s) keeps type, bytes and order at every length',
    (_name, type) => {
      const fields = lengths.map((n) => ({ type, data: rnd(n) }))
      const { parsed } = roundTrip([versionField()], [fields, [{ type, data: rnd(5) }]])
      expect(parsed.records).toHaveLength(2)
      expect(parsed.records[0]!.fields).toEqual(fields)
    },
  )

  const headerTypes = Object.entries(HeaderFieldType).filter(
    ([, t]) => t !== HeaderFieldType.END && t !== HeaderFieldType.VERSION,
  )
  it.each([...headerTypes, ['unknown 0x0c', 0x0c], ['unknown 0xe0', 0xe0]] as [string, number][])(
    'header field %s (0x%s) is kept, including repeats',
    (_name, type) => {
      const header = [versionField(), { type, data: rnd(20) }, { type, data: rnd(0) }]
      const { parsed } = roundTrip(header, [])
      expect(parsed.header).toEqual(header)
      expect(parsed.records).toEqual([])
    },
  )

  it('HMAC covers field data only, including the header Version', () => {
    const a = roundTrip([versionField(0x0310)], [[{ type: 3, data: rnd(4) }]])
    const b = roundTrip(
      [versionField(0x0311)],
      [[{ type: 3, data: a.parsed.records[0]!.fields[0]!.data }]],
    )
    expect(Buffer.from(a.parsed.hmac)).not.toEqual(Buffer.from(b.parsed.hmac))
    // Same data under a different type: same HMAC (the V3 gap the framing checks compensate for).
    const c = roundTrip(
      [versionField(0x0310)],
      [[{ type: 4, data: a.parsed.records[0]!.fields[0]!.data }]],
    )
    expect(Buffer.from(a.parsed.hmac)).toEqual(Buffer.from(c.parsed.hmac))
  })

  it('an empty record (END only) is kept', () => {
    const { parsed } = roundTrip([versionField()], [[]])
    expect(parsed.records).toEqual([{ fields: [] }])
  })
})

describe('framing errors (§A2.6, §A4.6)', () => {
  const valid = () =>
    serializeFieldStream([versionField()], [{ fields: [{ type: 3, data: rnd(40) }] }], key, rnd)
      .plain
  const expectFraming = (plain: Uint8Array) =>
    expect(() => parseFieldStream(plain, key)).toThrow(FramingError)

  it('header not starting with Version', () => {
    const p = valid()
    p[4] = HeaderFieldType.UUID
    expectFraming(p)
  })
  it('length overflowing the buffer', () => {
    const p = valid()
    new DataView(p.buffer).setUint32(32, 41 + 16, true)
    expectFraming(p)
  })
  it('length 0xFFFFFFFF', () => {
    const p = valid()
    new DataView(p.buffer).setUint32(32, 0xffffffff, true)
    expectFraming(p)
  })
  it('length above MAX_FIELD_BYTES even when the buffer is large enough', () => {
    const p = new Uint8Array(MAX_FIELD_BYTES + 64)
    p.set(valid().subarray(0, 32))
    new DataView(p.buffer).setUint32(32, MAX_FIELD_BYTES + 1, true)
    expectFraming(p)
  })
  it('record missing END', () => {
    const p = valid()
    expectFraming(p.subarray(0, p.length - 16))
  })
  it('header missing END', () => {
    expectFraming(valid().subarray(0, 16))
  })
  it('END carrying data', () => {
    const p = valid()
    new DataView(p.buffer).setUint32(p.length - 16, 3, true)
    expectFraming(p)
  })
  it('unaligned or empty body', () => {
    expectFraming(valid().subarray(0, 40))
    expectFraming(zeros(0))
  })
  it(`more than ${MAX_FIELDS_PER_RECORD} fields in a record`, () => {
    const many = Array.from({ length: MAX_FIELDS_PER_RECORD + 1 }, () => ({
      type: 5,
      data: zeros(0),
    }))
    // Build it by hand: the serializer refuses it.
    const body = new Uint8Array((many.length + 3) * 16)
    body.set(valid().subarray(0, 32))
    for (let i = 0; i < many.length; i++) body[32 + i * 16 + 4] = 5
    body[body.length - 12] = 0xff
    expectFraming(body)
    expect(() => serializeFieldStream([versionField()], [{ fields: many }], key, rnd)).toThrow(
      EncodeLimitError,
    )
  })
  it('the serializer refuses END in a field list and oversize fields', () => {
    expect(() =>
      serializeFieldStream([versionField(), { type: 0xff, data: zeros(0) }], [], key, rnd),
    ).toThrow(EncodeLimitError)
    expect(() =>
      serializeFieldStream(
        [versionField()],
        [{ fields: [{ type: 5, data: zeros(MAX_FIELD_BYTES + 1) }] }],
        key,
        rnd,
      ),
    ).toThrow(EncodeLimitError)
  })
})
