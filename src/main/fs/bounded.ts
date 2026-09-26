// Bounded reads of files next to the vault (docs/security-review.md F6). The `.plk`, the backup
// journal and backup files are written by us or by Password Safe, but anyone who can write to the
// vault's folder can put something else under those names. A FIFO would block a read forever and
// a huge file would be loaded whole, so these reads refuse anything that is not a regular file
// (symlinks are not followed) and anything over a size cap.
import { MAX_FILE_BYTES } from '../../shared/limits'
import { fsError, type FileSystem } from './types'

/** `.plk`: "user@host:pid" in UTF-32LE is about 2 KB at most; allow plenty. */
export const MAX_LOCK_FILE_BYTES = 16 * 1024
/** Backup rotation journal: a few base names and hashes as JSON. */
export const MAX_JOURNAL_BYTES = 64 * 1024
/**
 * Backups and staged copies. Our own are at most MAX_FILE_BYTES (we never open or write a larger
 * vault), but Save As over an existing file keeps that file as its `.bak` whatever it is, so the
 * cap only stops absurd sizes (Node cannot read a file over 2 GB in one call anyway).
 */
export const MAX_BACKUP_BYTES = 8 * MAX_FILE_BYTES

/**
 * Reads `path` if it is a regular file of at most `maxBytes`. Throws a Node-style error: the
 * lstat error (ENOENT etc.), EINVAL for anything that is not a regular file (FIFO, device,
 * directory, symlink), EFBIG when it is too large (also if it grew while being read).
 */
export async function readRegularFile(
  fs: FileSystem,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const st = await fs.lstat(path)
  if (!st.isFile) throw fsError('EINVAL', 'read', path)
  if (st.size > maxBytes) throw fsError('EFBIG', 'read', path)
  const bytes = await fs.readFile(path)
  if (bytes.length > maxBytes) throw fsError('EFBIG', 'read', path)
  return bytes
}
