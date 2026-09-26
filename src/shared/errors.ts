// Error codes shared by the main process and the renderer (docs/execution-plan.md §A4, §A5, §A6).
// Each code has one user-facing message; none of them may carry decrypted data.

export const ErrorCode = {
  /** Not a V3 file (no PWS3 tag, V4, V1/V2), or iterations outside the accepted range. */
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  /** Framing, block alignment, EOF or bounds check failed. */
  CORRUPT_FILE: 'CORRUPT_FILE',
  /** File is larger than MAX_FILE_BYTES. */
  TOO_LARGE: 'TOO_LARGE',
  /** SHA-256(P') did not match H(P'). */
  WRONG_PASSWORD: 'WRONG_PASSWORD',
  /** HMAC over the field data did not match. */
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  /** Another app holds the .plk lock. */
  LOCKED_BY_OTHER: 'LOCKED_BY_OTHER',
  /** The file on disk changed since we read it (or its path now points elsewhere). */
  FILE_CHANGED_ON_DISK: 'FILE_CHANGED_ON_DISK',
  /** A save step before the commit failed; database and backups are unchanged. */
  SAVE_FAILED: 'SAVE_FAILED',
  /** The new database is in place but the directory fsync failed. Not a failed save. */
  SAVED_DURABILITY_UNCONFIRMED: 'SAVED_DURABILITY_UNCONFIRMED',
  /** The vault is open read-only (newer format, lock not taken, Windows v1, read-only volume). */
  READ_ONLY: 'READ_ONLY',
  /** The record cannot be edited or deleted (alias, protected, dependents, etc.). */
  RECORD_READ_ONLY: 'RECORD_READ_ONLY',
  /** Operation needs an unlocked vault. */
  VAULT_LOCKED: 'VAULT_LOCKED',
  /** The user cancelled (for example a slow unlock). */
  CANCELLED: 'CANCELLED',
  /** Invalid arguments reached the main process over IPC. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** Any other file-system error. */
  IO_ERROR: 'IO_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface AppError {
  code: ErrorCode
  /** User-facing message. Never contains secrets. */
  message: string
  /** Optional non-secret detail, for example which save step failed or who holds a lock. */
  detail?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const fail = <T = never>(code: ErrorCode, message: string, detail?: string): Result<T> => ({
  ok: false,
  error: detail === undefined ? { code, message } : { code, message, detail },
})

/** Default user-facing messages (§A1, §A4, §A5). Callers may add a non-secret `detail`. */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  UNSUPPORTED_FORMAT:
    'This is not a Password Safe V3 file, or it uses settings this app does not support. V4 files are not supported.',
  CORRUPT_FILE: 'This file is damaged and cannot be opened. It was not changed.',
  TOO_LARGE: 'This file is too large to open.',
  WRONG_PASSWORD:
    "Wrong master password. The file was not changed. If this file uses a YubiKey, this version can't open it.",
  INTEGRITY_FAILED:
    'This file failed its integrity check, so it may have been damaged or tampered with. It was not changed.',
  LOCKED_BY_OTHER: 'This file is open in another app.',
  FILE_CHANGED_ON_DISK: 'The file was changed by another app since you opened it.',
  SAVE_FAILED:
    'Save failed. Your file and backups were not changed, and your edits are still here.',
  SAVED_DURABILITY_UNCONFIRMED:
    "Saved, but the system couldn't confirm the save is fully written to disk. Your previous version is in the backups.",
  READ_ONLY: 'This file is open read-only.',
  RECORD_READ_ONLY: 'This entry cannot be changed in this app.',
  VAULT_LOCKED: 'Unlock the file first.',
  CANCELLED: 'Cancelled.',
  INVALID_ARGUMENT: 'Something went wrong. Please try again.',
  IO_ERROR: 'The file could not be read or written.',
}
