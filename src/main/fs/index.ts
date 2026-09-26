// Injectable file-system layer used by the vault and the lock file code (§A5, §A6).
export * from './types'
export { createNodeFileSystem, type NodeFileSystemOptions } from './nodeFs'
export { isNetworkFs, mountTypeFor, LINUX_NETWORK_MAGICS, MAC_NETWORK_TYPES } from './fsType'
export {
  readRegularFile,
  MAX_BACKUP_BYTES,
  MAX_JOURNAL_BYTES,
  MAX_LOCK_FILE_BYTES,
} from './bounded'
