// Vault service (WP6): see README.md in this folder for the API WP7 wires to IPC.
export {
  Vault,
  READ_ONLY_TEXT,
  NETWORK_BANNER,
  DEPENDANTS_TEXT,
  LOCKED_DESTINATION_TEXT,
} from './vault'
export type { VaultDeps } from './vault'
export { recoverSidecars, ROTATION_UNFINISHED_TEXT, type RecoveryReport } from './rotation'
export type { DiskState } from './commit'
