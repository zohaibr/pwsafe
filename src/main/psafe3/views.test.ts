// §A3 record model, row by row, on synthetic records (the CLI-made files are in a3-cli.test.ts).
import { describe, expect, it } from 'vitest'
import { ErrorCode, type Result } from '../../shared/errors'
import { FieldType, type RawField, type RawRecord } from '../../shared/types'
import { decodeTime, encodeTime } from './fields'
import { bytes, text, uuidField, uuidHex } from './testing/fixtures'
import {
  RecordReadOnlyReason,
  applyDraft,
  buildEntries,
  buildEntry,
  createRecord,
  hasDependants,
  indexRecords,
  resolvePassword,
} from './views'

const rec = (...fields: RawField[]): RawRecord => ({ fields })
const basic = (n: number, ...more: RawField[]) =>
  rec(uuidField(n), text(FieldType.TITLE, `T${n}`), text(FieldType.PASSWORD, `pw${n}`), ...more)
const one = (r: RawRecord, others: RawRecord[] = []) => buildEntries([r, ...others])[0]!

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}

describe('row 1: UUID, group, title, username, notes, password, URL, email are shown and editable', () => {
  const r = basic(
    1,
    text(FieldType.GROUP, 'Banking\\.Co.Online'),
    text(FieldType.USERNAME, 'jordan'),
    text(FieldType.NOTES, 'a\r\nb'),
    text(FieldType.URL, 'https://x.example'),
    text(FieldType.EMAIL, 'j@x.example'),
  )
  it('builds the view', () => {
    const e = one(r)
    expect(e).toMatchObject({
      uuid: uuidHex(1),
      title: 'T1',
      group: 'Banking\\.Co.Online',
      username: 'jordan',
      notes: 'a\r\nb',
      url: 'https://x.example',
      email: 'j@x.example',
      password: '',
      kind: 'normal',
      editable: true,
    })
    expect(e.readOnlyReason).toBeUndefined()
    expect(e.flags.extraFieldCount).toBe(0)
  })
  it('password is only included on request', () => {
    expect(buildEntries([r], { includePassword: true })[0]!.password).toBe('pw1')
  })
  it('absent optional fields read as empty', () => {
    expect(one(basic(2))).toMatchObject({ group: '', username: '', url: '', email: '', notes: '' })
  })
})

describe('row 2: times are shown', () => {
  it('maps 0x07, 0x0c, 0x08, 0x0a to ISO strings; 0x09 is shown-type but not in the view', () => {
    const e = one(
      basic(
        1,
        { type: FieldType.CREATION_TIME, data: encodeTime(1_704_164_645) },
        { type: FieldType.LAST_MOD_TIME, data: encodeTime(1_704_164_646) },
        { type: FieldType.PASSWORD_MOD_TIME, data: encodeTime(1_704_164_647) },
        { type: FieldType.PASSWORD_EXPIRY_TIME, data: encodeTime(1_904_164_648) },
        { type: FieldType.LAST_ACCESS_TIME, data: encodeTime(1_704_164_649) },
      ),
    )
    expect(e.created).toBe('2024-01-02T03:04:05.000Z')
    expect(e.modified).toBe('2024-01-02T03:04:06.000Z')
    expect(e.passwordModified).toBe('2024-01-02T03:04:07.000Z')
    expect(e.expires).toBe(new Date(1_904_164_648_000).toISOString())
    expect(e.flags.extraFieldCount).toBe(0)
  })
  it('expiry 0 means never', () => {
    expect(
      one(basic(1, { type: FieldType.PASSWORD_EXPIRY_TIME, data: encodeTime(0) })).expires,
    ).toBeUndefined()
  })
})

describe('row 3: password history is preserved and flagged', () => {
  it('flags history with entries, not an empty "00000" header', () => {
    expect(
      one(basic(1, text(FieldType.PASSWORD_HISTORY, '10301655f00000004bold'))).flags.hasHistory,
    ).toBe(true)
    expect(one(basic(1, text(FieldType.PASSWORD_HISTORY, '00000'))).flags.hasHistory).toBe(false)
    expect(one(basic(1)).flags.hasHistory).toBe(false)
  })
  it('a password edit does not touch the history field', () => {
    const hist = text(FieldType.PASSWORD_HISTORY, '10301655f00000004bold')
    const r = basic(1, hist)
    const out = unwrap(applyDraft(r, { password: 'new' }, indexRecords([r]), { now: 1 }))
    expect(out.fields[3]).toBe(hist)
  })
})

describe('row 4: 2FA and TOTP are preserved with a badge', () => {
  it('flags a two-factor key; TOTP parameters alone are extra fields', () => {
    const e = one(
      basic(
        1,
        bytes(FieldType.TWO_FACTOR_KEY, ...Array<number>(10).fill(1)),
        bytes(FieldType.TOTP_LENGTH, 8),
      ),
    )
    expect(e.flags.hasTotp).toBe(true)
    expect(e.flags.extraFieldCount).toBe(2)
    expect(e.editable).toBe(true)
    expect(one(basic(1, bytes(FieldType.TOTP_TIME_STEP, 30))).flags.hasTotp).toBe(false)
  })
})

describe('row 5: attachments, passkeys, credit cards, QR and custom fields are preserved with badges', () => {
  it.each([
    ['hasAttachment', FieldType.ATT_TITLE],
    ['hasAttachment', FieldType.ATT_MEDIA_TYPE],
    ['hasAttachment', FieldType.ATT_FILE_NAME],
    ['hasAttachment', FieldType.ATT_MOD_TIME],
    ['hasAttachment', FieldType.ATT_CONTENT],
    ['hasPasskey', FieldType.PASSKEY_CREDENTIAL_ID],
    ['hasPasskey', FieldType.PASSKEY_RELYING_PARTY_ID],
    ['hasPasskey', FieldType.PASSKEY_USER_HANDLE],
    ['hasPasskey', FieldType.PASSKEY_ALGORITHM_ID],
    ['hasPasskey', FieldType.PASSKEY_PRIVATE_KEY],
    ['hasPasskey', FieldType.PASSKEY_SIGN_COUNT],
    ['hasCreditCard', FieldType.CREDIT_CARD_NUMBER],
    ['hasCreditCard', FieldType.CREDIT_CARD_EXPIRATION],
    ['hasCreditCard', FieldType.CREDIT_CARD_CVV],
    ['hasCreditCard', FieldType.CREDIT_CARD_PIN],
    ['hasCustomFields', FieldType.CUSTOM_TEXT],
  ] as [keyof ReturnType<typeof one>['flags'], number][])('%s for type 0x%s', (flag, type) => {
    const e = one(basic(1, bytes(type, 1, 2, 3, 4)))
    expect(e.flags[flag]).toBe(true)
    expect(e.flags.extraFieldCount).toBe(1)
    expect(e.editable).toBe(true)
    // Zero-length means absent (§2.9.2): no badge.
    expect(one(basic(1, { type, data: new Uint8Array(0) })).flags[flag]).toBe(false)
  })
  it('QR code is an extra field', () => {
    expect(one(basic(1, text(FieldType.QR_CODE, 'otpauth://x'))).flags.extraFieldCount).toBe(1)
  })
})

describe('row 6: policy, autotype, run command, shortcuts and similar are preserved', () => {
  it.each([
    FieldType.AUTOTYPE,
    FieldType.PASSWORD_POLICY,
    FieldType.PASSWORD_EXPIRY_INTERVAL,
    FieldType.RUN_COMMAND,
    FieldType.DOUBLE_CLICK_ACTION,
    FieldType.OWN_SYMBOLS,
    FieldType.SHIFT_DOUBLE_CLICK_ACTION,
    FieldType.PASSWORD_POLICY_NAME,
    FieldType.KEYBOARD_SHORTCUT,
  ])('type 0x%s keeps the record editable and counts as extra', (type) => {
    const e = one(basic(1, bytes(type, 0, 1)))
    expect(e.editable).toBe(true)
    expect(e.flags.extraFieldCount).toBe(1)
  })
  it('protected entry 0x15 with a non-zero byte makes the record read-only', () => {
    const e = one(basic(1, bytes(FieldType.PROTECTED, 1)))
    expect(e.editable).toBe(false)
    expect(e.readOnlyReason).toBe(RecordReadOnlyReason.protected)
    expect(one(basic(1, bytes(FieldType.PROTECTED, 0))).editable).toBe(true)
    expect(one(basic(1, { type: FieldType.PROTECTED, data: new Uint8Array(0) })).editable).toBe(
      true,
    )
  })
})

describe('rows 7 and 8: unknown record and header fields are preserved', () => {
  it.each([0x0b, 0x1a, 0x31, 0xc0, 0xdf, 0xe0, 0xfe])(
    'record type 0x%s is kept through an edit',
    (type) => {
      const unknown = bytes(type, 9, 8, 7)
      const r = basic(1, unknown)
      const e = one(r)
      expect(e.editable).toBe(true)
      expect(e.flags.extraFieldCount).toBe(1)
      const out = unwrap(applyDraft(r, { title: 'new' }, indexRecords([r]), { now: 5 }))
      expect(out.fields[3]).toBe(unknown)
    },
  )
  // Header preservation is covered in format.test.ts and codec.test.ts round-trips.
})

describe('row 9: aliases and shortcuts', () => {
  const base = basic(1)
  const alias = rec(
    uuidField(2),
    text(FieldType.TITLE, 'A'),
    text(FieldType.PASSWORD, `[[${uuidHex(1).toUpperCase()}]]`),
  )
  const base2 = basic(3)
  const shortcut = rec(
    uuidField(4),
    text(FieldType.TITLE, 'S'),
    text(FieldType.PASSWORD, `[~${uuidHex(3)}~]`),
  )
  const all = [base, alias, base2, shortcut]
  const index = indexRecords(all)
  const entries = buildEntries(all)

  it('alias: kind, link to base, read-only; base: aliasBase, editable, delete blocked', () => {
    expect(entries[1]).toMatchObject({ kind: 'alias', baseUuid: uuidHex(1), editable: false })
    expect(entries[1]!.readOnlyReason).toBe(RecordReadOnlyReason.alias)
    expect(entries[0]).toMatchObject({ kind: 'aliasBase', editable: true })
    expect(hasDependants(base, index)).toBe(true)
    expect(hasDependants(alias, index)).toBe(false)
  })
  it('shortcut: kind, link to base, read-only; base: shortcutBase', () => {
    expect(entries[3]).toMatchObject({ kind: 'shortcut', baseUuid: uuidHex(3), editable: false })
    expect(entries[3]!.readOnlyReason).toBe(RecordReadOnlyReason.shortcut)
    expect(entries[2]).toMatchObject({ kind: 'shortcutBase', editable: true })
  })
  it('copy password resolves to the base password', () => {
    expect(resolvePassword(alias, index)).toBe('pw1')
    expect(resolvePassword(shortcut, index)).toBe('pw3')
    expect(resolvePassword(base, index)).toBe('pw1')
  })
  it('a link to a UUID not in the file is just an unusual password (§3.3 [3])', () => {
    const orphan = rec(
      uuidField(9),
      text(FieldType.TITLE, 'O'),
      text(FieldType.PASSWORD, `[[${uuidHex(77)}]]`),
    )
    const e = one(orphan, [base])
    expect(e).toMatchObject({ kind: 'normal', editable: true })
    expect(e.baseUuid).toBeUndefined()
  })
  it('editing an alias is refused with RECORD_READ_ONLY', () => {
    const r = applyDraft(alias, { title: 'x' }, index, { now: 1 })
    expect(r.ok ? 'ok' : r.error.code).toBe(ErrorCode.RECORD_READ_ONLY)
  })
})

describe('row 10: records that must stay read-only', () => {
  it.each([
    ['missing UUID', rec(text(FieldType.TITLE, 't'), text(FieldType.PASSWORD, 'p'))],
    [
      'malformed UUID',
      rec(bytes(FieldType.UUID, 1, 2), text(FieldType.TITLE, 't'), text(FieldType.PASSWORD, 'p')),
    ],
    ['missing title', rec(uuidField(1), text(FieldType.PASSWORD, 'p'))],
    ['missing password', rec(uuidField(1), text(FieldType.TITLE, 't'))],
  ])('%s', (_n, r) => {
    const e = one(r)
    expect(e.editable).toBe(false)
    expect(e.readOnlyReason).toMatch(/missing a required field/)
    const out = applyDraft(r, { notes: 'x' }, indexRecords([r]), { now: 1 })
    expect(out.ok ? 'ok' : out.error.code).toBe(ErrorCode.RECORD_READ_ONLY)
  })
  it('a record without a valid UUID gets a positional placeholder id', () => {
    const r = rec(text(FieldType.TITLE, 't'), text(FieldType.PASSWORD, 'p'))
    expect(buildEntries([basic(1), r])[1]!.uuid).toBe('#1')
  })
  it.each([
    FieldType.UUID,
    FieldType.GROUP,
    FieldType.TITLE,
    FieldType.USERNAME,
    FieldType.NOTES,
    FieldType.PASSWORD,
    FieldType.URL,
    FieldType.EMAIL,
  ])('duplicate field 0x%s', (type) => {
    const extra = type === FieldType.UUID ? uuidField(1) : text(type, 'dup')
    const r = basic(
      1,
      text(FieldType.USERNAME, 'u'),
      text(FieldType.GROUP, 'g'),
      text(FieldType.NOTES, 'n'),
      text(FieldType.URL, 'u'),
      text(FieldType.EMAIL, 'e'),
      extra,
    )
    const e = one(r)
    expect(e.editable).toBe(false)
    expect(e.readOnlyReason).toMatch(/more than one/)
  })
  it('duplicate non-editable fields do not block editing', () => {
    expect(one(basic(1, bytes(0xdf, 1), bytes(0xdf, 2))).editable).toBe(true)
  })
  it.each([
    FieldType.GROUP,
    FieldType.TITLE,
    FieldType.USERNAME,
    FieldType.NOTES,
    FieldType.PASSWORD,
    FieldType.URL,
    FieldType.EMAIL,
  ])('invalid UTF-8 in editable field 0x%s', (type) => {
    const r = rec(...basic(1).fields.filter((f) => f.type !== type), bytes(type, 0x41, 0xff, 0x42))
    const e = one(r)
    expect(e.editable).toBe(false)
    expect(e.readOnlyReason).toMatch(/not valid text/)
  })
  it('invalid UTF-8 in a non-editable text field does not block editing', () => {
    expect(one(basic(1, bytes(FieldType.AUTOTYPE, 0xff))).editable).toBe(true)
  })
})

describe('applyDraft: write-through preserving everything else', () => {
  const unknown = bytes(0xdf, 1, 2, 3)
  const history = text(FieldType.PASSWORD_HISTORY, '00000')
  const oddUsername = text(FieldType.USERNAME, 'café') // decomposed é: must survive untouched
  const r = rec(
    uuidField(1),
    text(FieldType.GROUP, 'G'),
    unknown,
    text(FieldType.TITLE, 'Old'),
    oddUsername,
    text(FieldType.PASSWORD, 'pw'),
    history,
    { type: FieldType.LAST_MOD_TIME, data: encodeTime(100) },
  )
  const index = indexRecords([r])

  it('replaces an edited field in place and keeps all other fields and their order', () => {
    const out = unwrap(
      applyDraft(r, { uuid: uuidHex(1), title: 'New', username: 'café' }, index, {
        now: 1_800_000_000,
      }),
    )
    expect(out).not.toBe(r)
    expect(out.fields.map((f) => f.type)).toEqual(r.fields.map((f) => f.type))
    expect(new TextDecoder().decode(out.fields[3]!.data)).toBe('New')
    for (const i of [0, 1, 2, 4, 5, 6]) expect(out.fields[i]).toBe(r.fields[i])
    expect(decodeTime(out.fields[7]!.data)).toBe(1_800_000_000)
    // Input untouched.
    expect(new TextDecoder().decode(r.fields[3]!.data)).toBe('Old')
  })

  it('appends newly set fields before END and adds 0x08 on a password change', () => {
    const out = unwrap(
      applyDraft(r, { url: 'https://n.example', password: 'pw2' }, index, { now: 7 }),
    )
    expect(out.fields.map((f) => f.type)).toEqual([
      ...r.fields.map((f) => f.type),
      FieldType.URL,
      FieldType.PASSWORD_MOD_TIME,
    ])
    expect(decodeTime(out.fields.at(-1)!.data)).toBe(7)
    expect(decodeTime(out.fields[7]!.data)).toBe(7)
  })

  it('no change returns the same record (no timestamps touched)', () => {
    const out = unwrap(applyDraft(r, { title: 'Old', group: 'G', email: '' }, index, { now: 9 }))
    expect(out).toBe(r)
  })

  it('clearing a field keeps the field with empty data in place', () => {
    const out = unwrap(applyDraft(r, { group: '' }, index, { now: 9 }))
    expect(out.fields[1]).toEqual({ type: FieldType.GROUP, data: new Uint8Array(0) })
    expect(out.fields).toHaveLength(r.fields.length)
  })

  it('refuses a uuid mismatch', () => {
    const out = applyDraft(r, { uuid: uuidHex(2), title: 'x' }, index, { now: 1 })
    expect(out.ok ? 'ok' : out.error.code).toBe(ErrorCode.INVALID_ARGUMENT)
  })

  it('buildEntry after the edit shows the new values', () => {
    const out = unwrap(applyDraft(r, { title: 'New' }, index, { now: 1 }))
    expect(buildEntry(out, indexRecords([out])).title).toBe('New')
  })
})

describe('createRecord', () => {
  it('writes UUID, Title and Password first, then set fields and times', () => {
    const out = unwrap(
      createRecord(
        { title: 'T', username: 'u', notes: '' },
        { now: 1_000, randomBytes: (n) => new Uint8Array(n).fill(0x11) },
      ),
    )
    expect(out.fields.map((f) => f.type)).toEqual([
      FieldType.UUID,
      FieldType.TITLE,
      FieldType.PASSWORD,
      FieldType.USERNAME,
      FieldType.CREATION_TIME,
      FieldType.PASSWORD_MOD_TIME,
      FieldType.LAST_MOD_TIME,
    ])
    const e = one(out)
    expect(e).toMatchObject({ title: 'T', username: 'u', kind: 'normal', editable: true })
    expect(e.uuid).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
  })
  it('refuses a draft with a uuid', () => {
    const out = createRecord(
      { uuid: uuidHex(1) },
      { now: 1, randomBytes: (n) => new Uint8Array(n) },
    )
    expect(out.ok ? 'ok' : out.error.code).toBe(ErrorCode.INVALID_ARGUMENT)
  })
})
