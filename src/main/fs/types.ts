// Injectable file-system layer (docs/execution-plan.md §A5, §A6, §C WP6).
// The vault and the lock file code only touch the disk through this interface, so the save
// pipeline can be run against an in-memory implementation with a failure or a simulated process
// death injected at any single operation. Errors are Node-style: an Error with a string `code`
// (ENOENT, EEXIST, EACCES, EPERM, EBUSY, EROFS, ENOSPC, EIO, ...).

export interface FileStat {
  /** Device id, as a decimal string (64-bit ids do not fit a JS number exactly). */
  dev: string
  /** Inode / file id, as a decimal string. */
  ino: string
  size: number
  mtimeMs: number
  /** Permission bits and file type, as in `stat.st_mode`. */
  mode: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** A file opened for writing by `createExclusive`. */
export interface WritableFile {
  write(data: Uint8Array): Promise<void>
  /** fsync(2) of the file. */
  sync(): Promise<void>
  close(): Promise<void>
}

/** What the OS reports about the file system holding a path (for network-volume detection). */
export interface FsTypeInfo {
  /** Linux `statfs.f_type` magic number. */
  magic?: number
  /** File system type name (macOS: from the mount table, e.g. "apfs", "smbfs"). */
  name?: string
}

export interface FileSystem {
  /** Reads a whole file, following symlinks. */
  readFile(path: string): Promise<Uint8Array>
  /** open(2) with O_CREAT | O_EXCL | O_WRONLY and the given permission bits. EEXIST if present. */
  createExclusive(path: string, mode: number): Promise<WritableFile>
  /** Opens an existing file, fsyncs it and closes it. */
  fsyncFile(path: string): Promise<void>
  /** fsync of a directory, so renames and new names in it are durable. No-op where unsupported. */
  fsyncDir(path: string): Promise<void>
  /** rename(2): replaces the destination directory entry atomically; does not follow a symlink at `to`. */
  rename(from: string, to: string): Promise<void>
  /** link(2): fails with EEXIST if `newPath` exists, so it never clobbers a file. */
  link(existingPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  lstat(path: string): Promise<FileStat>
  realpath(path: string): Promise<string>
  /** Copies `src` to a new file `dest` (fails with EEXIST if `dest` exists), keeping the mode. */
  copyFile(src: string, dest: string): Promise<void>
  /** Names (not paths) of the entries of a directory. */
  readdir(path: string): Promise<string[]>
  /** File system type of the volume holding `path`. Resolves `{}` when unknown. */
  fsType(path: string): Promise<FsTypeInfo>
}

/** The `code` of a Node-style file-system error, if any. */
export function errnoOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

export function isNotFound(e: unknown): boolean {
  const code = errnoOf(e)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Creates a Node-style error. */
export function fsError(code: string, syscall: string, path: string): Error & { code: string } {
  const e = new Error(`${code}: ${syscall} '${path}'`) as Error & {
    code: string
    syscall: string
    path: string
  }
  e.code = code
  e.syscall = syscall
  e.path = path
  return e
}

/** Short, non-secret description of an I/O error for a "Save failed at step N" message. */
export function describeIoError(e: unknown): string {
  switch (errnoOf(e)) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'the disk is full'
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EROFS':
      return 'the drive is read-only'
    case 'ENOENT':
      return 'a file or folder is missing'
    case 'EEXIST':
      return 'a file with that name already exists'
    case 'EBUSY':
      return 'the file is busy'
    case 'EIO':
      return 'a disk error occurred'
    case undefined:
      return 'an unexpected error occurred'
    default:
      return `the system reported ${errnoOf(e)}`
  }
}
