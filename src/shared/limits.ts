// Numeric limits from the execution plan (docs/execution-plan.md §A1, §A4, §A5, §B).
// Changing any value here needs lead review and matching test and message updates.

/** Smallest key-stretch iteration count accepted on read (original V3 minimum). */
export const MIN_ITERATIONS_READ = 2_048

/** Largest key-stretch iteration count accepted on read (§A1). Above this: UNSUPPORTED_FORMAT. */
export const MAX_ITERATIONS_READ = 2 ** 24

/** Iteration floor applied on save, matching Password Safe 3.68+ (format 0x030F). */
export const MIN_ITERATIONS_WRITE = 262_144

/** Iteration count above which the unlock screen shows progress and Cancel. */
export const SLOW_UNLOCK_THRESHOLD = 2 ** 20

/** Smallest possible valid V3 file, in bytes. */
export const MIN_FILE_BYTES = 232

/** Largest file we will open, in bytes. */
export const MAX_FILE_BYTES = 128 * 1024 * 1024

/** Largest single field payload, in bytes. */
export const MAX_FIELD_BYTES = 16 * 1024 * 1024

/** Most fields allowed in one record or in the header. */
export const MAX_FIELDS_PER_RECORD = 1_024

/** Most records allowed in one file. */
export const MAX_RECORDS = 200_000

/** Supported V3 format: major byte and the highest minor we can write (0x0311). */
export const FORMAT_MAJOR = 0x03
export const FORMAT_MAX_WRITABLE_MINOR = 0x11

/** Number of backup generations kept next to the database (.bak, .bak2, .bak3). */
export const BACKUP_GENERATIONS = 3

/** Clipboard auto-clear delay after a copy, in milliseconds. */
export const CLIPBOARD_CLEAR_MS = 30_000

/** Idle auto-lock: default and allowed range, in minutes. */
export const IDLE_LOCK_DEFAULT_MIN = 5
export const IDLE_LOCK_MIN_MIN = 1
export const IDLE_LOCK_MAX_MIN = 60

/** Minimum window size and the width below which the groups sidebar collapses. */
export const WINDOW_MIN_WIDTH = 960
export const WINDOW_MIN_HEIGHT = 620
export const SIDEBAR_COLLAPSE_WIDTH = 1_180

/** Password generator defaults. */
export const GENERATOR_DEFAULT_LENGTH = 20
export const GENERATOR_MIN_LENGTH = 8
export const GENERATOR_MAX_LENGTH = 64
