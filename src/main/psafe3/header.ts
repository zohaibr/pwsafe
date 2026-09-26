// Save-time header metadata (docs/execution-plan.md §A2.1): the only header fields a save changes
// are last-save time 0x04, last-save application 0x06 and, only when already present, last-saved
// user 0x07 and host 0x08. Every other header field keeps its bytes and position.
import { HeaderFieldType, type RawField } from '../../shared/types'
import { encodeText, encodeTime } from './fields'

export interface SaveStamp {
  /** Save time in seconds since the epoch. */
  now: number
  /** Written to 0x06, e.g. "psafe3 Opener V0.1.0". */
  application: string
  /** Written to 0x07 only if the header already has it. */
  user?: string
  /** Written to 0x08 only if the header already has it. */
  host?: string
}

function setField(fields: RawField[], type: number, data: Uint8Array, addIfMissing: boolean): void {
  const i = fields.findIndex((f) => f.type === type)
  if (i >= 0) fields[i] = { type, data }
  else if (addIfMissing) fields.push({ type, data })
}

/** Returns a new header list with the save metadata applied; the input is not modified. */
export function stampHeaderForSave(header: readonly RawField[], stamp: SaveStamp): RawField[] {
  const out = header.slice()
  setField(out, HeaderFieldType.LAST_SAVE_TIME, encodeTime(stamp.now), true)
  setField(out, HeaderFieldType.WHAT_LAST_SAVED, encodeText(stamp.application), true)
  if (stamp.user !== undefined) {
    setField(out, HeaderFieldType.LAST_SAVED_BY_USER, encodeText(stamp.user), false)
  }
  if (stamp.host !== undefined) {
    setField(out, HeaderFieldType.LAST_SAVED_ON_HOST, encodeText(stamp.host), false)
  }
  return out
}

/** Header field types a save may change; round-trip comparisons ignore these (§A2.1). */
export const SAVE_METADATA_HEADER_TYPES: readonly number[] = [
  HeaderFieldType.LAST_SAVE_TIME,
  HeaderFieldType.WHAT_LAST_SAVED,
  HeaderFieldType.LAST_SAVED_BY_USER,
  HeaderFieldType.LAST_SAVED_ON_HOST,
]
