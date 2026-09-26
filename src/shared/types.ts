// Data model shared by all work packages (docs/execution-plan.md §A3).
// RawRecord is the source of truth; Entry is a view over it and is never used to rebuild a record.

/** One typed field exactly as stored in the file, in file order. */
export interface RawField {
  type: number
  data: Uint8Array
}

/** One record: its fields in file order. The END (0xff) field is implicit and not stored. */
export interface RawRecord {
  fields: RawField[]
}

/** V3 record field types (format spec v3.31 §3.3). Types not listed are preserved opaquely. */
export const FieldType = {
  UUID: 0x01,
  GROUP: 0x02,
  TITLE: 0x03,
  USERNAME: 0x04,
  NOTES: 0x05,
  PASSWORD: 0x06,
  CREATION_TIME: 0x07,
  PASSWORD_MOD_TIME: 0x08,
  LAST_ACCESS_TIME: 0x09,
  PASSWORD_EXPIRY_TIME: 0x0a,
  RESERVED_0B: 0x0b,
  LAST_MOD_TIME: 0x0c,
  URL: 0x0d,
  AUTOTYPE: 0x0e,
  PASSWORD_HISTORY: 0x0f,
  PASSWORD_POLICY: 0x10,
  PASSWORD_EXPIRY_INTERVAL: 0x11,
  RUN_COMMAND: 0x12,
  DOUBLE_CLICK_ACTION: 0x13,
  EMAIL: 0x14,
  PROTECTED: 0x15,
  OWN_SYMBOLS: 0x16,
  SHIFT_DOUBLE_CLICK_ACTION: 0x17,
  PASSWORD_POLICY_NAME: 0x18,
  KEYBOARD_SHORTCUT: 0x19,
  RESERVED_1A: 0x1a,
  TWO_FACTOR_KEY: 0x1b,
  CREDIT_CARD_NUMBER: 0x1c,
  CREDIT_CARD_EXPIRATION: 0x1d,
  CREDIT_CARD_CVV: 0x1e,
  CREDIT_CARD_PIN: 0x1f,
  QR_CODE: 0x20,
  TOTP_CONFIG: 0x21,
  TOTP_LENGTH: 0x22,
  TOTP_TIME_STEP: 0x23,
  TOTP_START_TIME: 0x24,
  ATT_TITLE: 0x25,
  ATT_MEDIA_TYPE: 0x26,
  ATT_FILE_NAME: 0x27,
  ATT_MOD_TIME: 0x28,
  ATT_CONTENT: 0x29,
  PASSKEY_CREDENTIAL_ID: 0x2a,
  PASSKEY_RELYING_PARTY_ID: 0x2b,
  PASSKEY_USER_HANDLE: 0x2c,
  PASSKEY_ALGORITHM_ID: 0x2d,
  PASSKEY_PRIVATE_KEY: 0x2e,
  PASSKEY_SIGN_COUNT: 0x2f,
  CUSTOM_TEXT: 0x30,
  END: 0xff,
} as const

/** V3 header field types (format spec v3.31 §3.2). */
export const HeaderFieldType = {
  VERSION: 0x00,
  UUID: 0x01,
  NON_DEFAULT_PREFS: 0x02,
  TREE_DISPLAY_STATUS: 0x03,
  LAST_SAVE_TIME: 0x04,
  WHO_LAST_SAVED_DEPRECATED: 0x05,
  WHAT_LAST_SAVED: 0x06,
  LAST_SAVED_BY_USER: 0x07,
  LAST_SAVED_ON_HOST: 0x08,
  DATABASE_NAME: 0x09,
  DATABASE_DESCRIPTION: 0x0a,
  DATABASE_FILTERS: 0x0b,
  RECENTLY_USED: 0x0f,
  NAMED_POLICIES: 0x10,
  EMPTY_GROUPS: 0x11,
  YUBICO: 0x12,
  LAST_MASTER_PASSWORD_CHANGE: 0x13,
  END: 0xff,
} as const

/** Record fields the v1 editor can change (§A3). Everything else is preserved as-is. */
export const EDITABLE_FIELD_TYPES: readonly number[] = [
  FieldType.GROUP,
  FieldType.TITLE,
  FieldType.USERNAME,
  FieldType.NOTES,
  FieldType.PASSWORD,
  FieldType.URL,
  FieldType.EMAIL,
]

export type EntryKind = 'normal' | 'alias' | 'shortcut' | 'aliasBase' | 'shortcutBase'

export interface EntryFlags {
  hasHistory: boolean
  hasTotp: boolean
  hasAttachment: boolean
  hasPasskey: boolean
  hasCreditCard: boolean
  hasCustomFields: boolean
  /** Count of fields not shown in the v1 UI (preserved on save). */
  extraFieldCount: number
}

/**
 * Display view of one record. Built in the main process from a RawRecord.
 * `password` is always '' in lists sent to the renderer; the real value only
 * crosses IPC in an explicit reveal (§A4.8).
 */
export interface Entry {
  uuid: string
  title: string
  /** Group path with '.' separators exactly as stored (escaped dots kept escaped). */
  group: string
  username: string
  password: string
  url: string
  email: string
  notes: string
  created?: string
  modified?: string
  passwordModified?: string
  expires?: string
  kind: EntryKind
  /** For alias/shortcut entries: the base entry's UUID, when it exists in this file. */
  baseUuid?: string
  flags: EntryFlags
  editable: boolean
  readOnlyReason?: string
}

/** Fields the renderer may send when adding or editing an entry. Omitted fields are unchanged. */
export interface EntryDraft {
  /** Absent for a new entry. */
  uuid?: string
  title?: string
  group?: string
  username?: string
  /** Absent means "keep the current password". */
  password?: string
  url?: string
  email?: string
  notes?: string
}

export type ReadOnlyReason =
  'newer-format' | 'locked-by-other' | 'lock-not-created' | 'windows-v1' | 'backup-preview'

export interface Banner {
  kind: 'info' | 'warning'
  /** Stable id so the renderer can dismiss it. */
  id: string
  text: string
}

export type VaultStatus = 'no-file' | 'locked' | 'unlocking' | 'open'

export interface VaultState {
  status: VaultStatus
  /** Display name only (basename). Full paths stay in main except where the user picked them. */
  fileName?: string
  readOnly?: { reason: ReadOnlyReason; text: string }
  /** Count of unsaved changes, including pending deletes. 0 when clean. */
  dirtyCount: number
  banners: Banner[]
  /** Present while status is 'unlocking' and the file is slow (§A1). 0..1 */
  unlockProgress?: number
}

export interface GroupNode {
  /** Full group path. */
  path: string
  /** Last path segment, unescaped for display. */
  name: string
  entryCount: number
  children: GroupNode[]
}

export interface BackupInfo {
  /** Opaque id the renderer passes back; not a path. */
  id: string
  /** '.bak' | '.bak2' | '.bak3' */
  generation: number
  modifiedAt: string
  sizeBytes: number
}

export interface Settings {
  idleLockMinutes: number
  lockOnMinimize: boolean
  generator: GeneratorOptions
}

export interface GeneratorOptions {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  avoidLookAlikes: boolean
  /** "Use at least one of each selected type" (§B1). */
  requireEachSelected: boolean
}

export type CopyableField = 'username' | 'password' | 'url' | 'email'

export interface ExportOptions {
  scope: { kind: 'all' } | { kind: 'group'; path: string }
}

export interface ExportResult {
  /** The file the user chose; shown so they can find and delete it. */
  filePath: string
  entryCount: number
  /** Entries that had fields with no XML equivalent (§A7). */
  entriesWithOmittedFields: number
}
