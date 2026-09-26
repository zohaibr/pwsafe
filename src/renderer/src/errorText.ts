// A designed message state for every error code (§A4, §A5, §A6). The body text comes from main
// (`AppError.message`, never secret); the title and tone are the renderer's.
import type { AppError, ErrorCode } from '@shared/errors'

export interface ErrorPresentation {
  title: string
  tone: 'error' | 'warning' | 'info'
}

export const ERROR_PRESENTATION: Record<ErrorCode, ErrorPresentation> = {
  UNSUPPORTED_FORMAT: { title: "Can't open this file", tone: 'error' },
  CORRUPT_FILE: { title: 'This file is damaged', tone: 'error' },
  TOO_LARGE: { title: 'This file is too large', tone: 'error' },
  WRONG_PASSWORD: { title: 'Wrong master password', tone: 'error' },
  INTEGRITY_FAILED: { title: 'Integrity check failed', tone: 'error' },
  LOCKED_BY_OTHER: { title: 'File is in use', tone: 'warning' },
  FILE_CHANGED_ON_DISK: { title: 'The file changed on disk', tone: 'warning' },
  SAVE_FAILED: { title: 'Save failed', tone: 'error' },
  SAVED_DURABILITY_UNCONFIRMED: { title: 'Saved, but not confirmed on disk', tone: 'warning' },
  READ_ONLY: { title: 'This file is read-only', tone: 'info' },
  RECORD_READ_ONLY: { title: 'This entry is read-only', tone: 'info' },
  VAULT_LOCKED: { title: 'The file is locked', tone: 'info' },
  CANCELLED: { title: 'Cancelled', tone: 'info' },
  INVALID_ARGUMENT: { title: 'Something went wrong', tone: 'error' },
  IO_ERROR: { title: "Couldn't read or write the file", tone: 'error' },
}

export function presentError(error: AppError): ErrorPresentation & { body: string } {
  const p = ERROR_PRESENTATION[error.code]
  const body = error.detail ? `${error.message} ${error.detail}` : error.message
  return { ...p, body }
}
