// Public surface of the psafe3 codec (WP2). See docs/execution-plan.md §A1–§A4.
export {
  decode,
  encode,
  wipeModel,
  type CodecDeps,
  type DecodeOptions,
  type DecodedVault,
  type EncodeOptions,
  type VaultMeta,
  type VaultModel,
} from './codec'
export { stampHeaderForSave, SAVE_METADATA_HEADER_TYPES, type SaveStamp } from './header'
export {
  stretchKeyInWorker,
  stretchKeySync,
  StretchCancelledError,
  type StretchFn,
  type StretchOptions,
} from './stretch'
export {
  applyDraft,
  buildEntries,
  buildEntry,
  createRecord,
  hasDependants,
  indexRecords,
  readOnlyReasonOf,
  recordUuid,
  resolvePassword,
  RecordReadOnlyReason,
  type ApplyDraftOptions,
  type BuildEntryOptions,
  type CreateRecordOptions,
  type RecordIndex,
} from './views'
