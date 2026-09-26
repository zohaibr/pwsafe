// TEST ONLY. Paths and password of the pypwsafe test safes (fetched by `npm run fixtures:pypwsafe`,
// git-ignored, never committed) and a small synthetic-vault builder.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FieldType, HeaderFieldType, type RawField, type RawRecord } from '../../../shared/types'
import type { VaultModel } from '../codec'
import { encodeText, encodeTime } from '../fields'

export const PYPWSAFE_DIR = resolve(import.meta.dirname, '../../../../test/fixtures/pypwsafe')
export const PYPWSAFE_PASSWORD = 'bogus12345'
export const PYPWSAFE_FILES = [
  'EmptyGroupTest.psafe3',
  'LastSaveUserTest.psafe3',
  'NonDefaultPrefsTest.psafe3',
  'RecentEntriesTest.psafe3',
  'VersionTest.psafe3',
  'passwordPolicyTest.psafe3',
  'simple.psafe3',
  'unknown-record-prop-1.psafe3',
] as const

export const hasPypwsafe = PYPWSAFE_FILES.every((f) => existsSync(join(PYPWSAFE_DIR, f)))

export const text = (type: number, value: string): RawField => ({ type, data: encodeText(value) })
export const bytes = (type: number, ...b: number[]): RawField => ({
  type,
  data: Uint8Array.from(b),
})

export function uuidField(n: number): RawField {
  const data = new Uint8Array(16)
  data[15] = n
  data[0] = 0xab
  return { type: FieldType.UUID, data }
}

export const uuidHex = (n: number): string =>
  'ab' + '00'.repeat(14) + n.toString(16).padStart(2, '0')

export function versionField(version = 0x0311): RawField {
  return { type: HeaderFieldType.VERSION, data: Uint8Array.from([version & 0xff, version >> 8]) }
}

/** A synthetic vault exercising every field category of §A3, including unknown types. */
export function sampleModel(): VaultModel {
  const header: RawField[] = [
    versionField(),
    { type: HeaderFieldType.UUID, data: new Uint8Array(16).fill(7) },
    text(HeaderFieldType.NON_DEFAULT_PREFS, 'B 24 1 '),
    text(HeaderFieldType.DATABASE_NAME, 'Synthetic test vault'),
    text(HeaderFieldType.EMPTY_GROUPS, 'Empty.One'),
    text(HeaderFieldType.EMPTY_GROUPS, 'Empty.Two'),
    bytes(0xe5, 1, 2, 3), // unknown header field, preserved opaquely
  ]
  const long = 'x'.repeat(100)
  const records: RawRecord[] = [
    {
      fields: [
        uuidField(1),
        text(FieldType.GROUP, 'Banking.Online'),
        text(FieldType.TITLE, 'Example Bank'),
        text(FieldType.USERNAME, 'jordan'),
        text(FieldType.PASSWORD, 'p&<>"q ü 🔑'),
        text(FieldType.NOTES, `line one\r\nline two ${long}`),
        text(FieldType.URL, 'https://bank.example.com'),
        text(FieldType.EMAIL, 'j@example.com'),
        { type: FieldType.CREATION_TIME, data: encodeTime(1_700_000_000) },
        { type: FieldType.LAST_MOD_TIME, data: encodeTime(1_700_000_100) },
        text(FieldType.PASSWORD_HISTORY, '10301655f00000004bold'),
        bytes(FieldType.TWO_FACTOR_KEY, ...new Array<number>(10).fill(9)),
        bytes(FieldType.TOTP_LENGTH, 6),
        bytes(0xdf, 0xde, 0xad), // "unknown (testing)" field type
      ],
    },
    {
      fields: [
        uuidField(2),
        text(FieldType.TITLE, 'Alias'),
        text(FieldType.PASSWORD, `[[${uuidHex(1)}]]`),
      ],
    },
    { fields: [uuidField(3), text(FieldType.TITLE, ''), text(FieldType.PASSWORD, '')] },
    {
      fields: [
        uuidField(4),
        text(FieldType.TITLE, 'Card'),
        text(FieldType.PASSWORD, 'pw'),
        text(FieldType.CREDIT_CARD_NUMBER, '4111 1111 1111 1111'),
        text(FieldType.ATT_MEDIA_TYPE, 'text/plain'),
        { type: FieldType.ATT_CONTENT, data: new Uint8Array(40).fill(0x41) },
        text(FieldType.CUSTOM_TEXT, '010004Name020005Value'),
        bytes(FieldType.PROTECTED, 1),
        { type: 0xfe, data: new Uint8Array(0) },
      ],
    },
  ]
  return { header, records }
}
