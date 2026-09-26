// The real file-system layer on top of node:fs/promises. See ./types.ts.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import type { FileStat, FileSystem, FsTypeInfo, WritableFile } from './types'
import { mountTypeFor } from './fsType'

export interface NodeFileSystemOptions {
  /** Defaults to process.platform. Decides how fsyncDir and fsType work. */
  platform?: NodeJS.Platform
  /** macOS only: returns the output of `/sbin/mount` (injectable for tests). */
  readMountTable?: () => Promise<string>
}

function toStat(s: import('node:fs').BigIntStats): FileStat {
  return {
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    size: Number(s.size),
    mtimeMs: Number(s.mtimeMs),
    mode: Number(s.mode),
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
  }
}

const defaultReadMountTable = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/sbin/mount', [], { timeout: 3_000, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    )
  })

export function createNodeFileSystem(options: NodeFileSystemOptions = {}): FileSystem {
  const platform = options.platform ?? process.platform
  const readMountTable = options.readMountTable ?? defaultReadMountTable

  return {
    async readFile(path) {
      const b = await fsp.readFile(path)
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    },

    async createExclusive(path, mode): Promise<WritableFile> {
      const h = await fsp.open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        mode,
      )
      // open(2) applies the umask to `mode`; §A5 step 3 needs the database's exact bits.
      if (platform !== 'win32') {
        try {
          await h.chmod(mode)
        } catch (e) {
          await h.close()
          throw e
        }
      }
      return {
        async write(data) {
          let off = 0
          while (off < data.length) {
            const { bytesWritten } = await h.write(data, off, data.length - off)
            if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' })
            off += bytesWritten
          }
        },
        sync: () => h.sync(),
        close: () => h.close(),
      }
    },

    async fsyncFile(path) {
      // Read-only open is enough for fsync on macOS and Linux; Windows needs write access.
      const h = await fsp.open(path, platform === 'win32' ? 'r+' : 'r')
      try {
        await h.sync()
      } finally {
        await h.close()
      }
    },

    async fsyncDir(path) {
      // Windows cannot open or fsync a directory; renames there are made durable by the OS.
      if (platform === 'win32') return
      const h = await fsp.open(path, 'r')
      try {
        await h.sync()
      } finally {
        await h.close()
      }
    },

    rename: (from, to) => fsp.rename(from, to),
    link: (existing, newPath) => fsp.link(existing, newPath),
    unlink: (path) => fsp.unlink(path),
    lstat: async (path) => toStat(await fsp.lstat(path, { bigint: true })),
    realpath: (path) => fsp.realpath(path),
    copyFile: (src, dest) => fsp.copyFile(src, dest, constants.COPYFILE_EXCL),
    readdir: (path) => fsp.readdir(path),

    async fsType(path): Promise<FsTypeInfo> {
      try {
        if (platform === 'linux') {
          const s = await fsp.statfs(path)
          return { magic: Number(s.type) >>> 0 }
        }
        if (platform === 'darwin') {
          const real = await fsp.realpath(path)
          const name = mountTypeFor(await readMountTable(), real)
          return name === undefined ? {} : { name }
        }
      } catch {
        // Unknown: the caller treats it as a local volume.
      }
      return {}
    },
  }
}
