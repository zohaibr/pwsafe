import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isNetworkFs, mountTypeFor } from './fsType'
import { MemoryFileSystem, SimulatedCrash } from './memoryFs'
import { createNodeFileSystem } from './nodeFs'
import { errnoOf, type FileSystem } from './types'

const bytes = (s: string) => new TextEncoder().encode(s)

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (e) {
    return errnoOf(e) ?? (e as Error).name
  }
}

/** The same behaviour contract, run against both implementations. */
function contract(name: string, make: () => { fs: FileSystem; dir: string; cleanup(): void }) {
  describe(`${name}: FileSystem contract`, () => {
    let ctx: ReturnType<typeof make>
    afterEach(() => ctx?.cleanup())

    it('createExclusive refuses an existing file; write, sync, close, read back', async () => {
      ctx = make()
      const { fs, dir } = ctx
      const p = join(dir, 'a.bin')
      const f = await fs.createExclusive(p, 0o600)
      await f.write(bytes('hello'))
      await f.sync()
      await f.close()
      expect(await fs.readFile(p)).toEqual(bytes('hello'))
      expect(await code(fs.createExclusive(p, 0o600))).toBe('EEXIST')
      const st = await fs.lstat(p)
      expect(st.isFile).toBe(true)
      expect(st.size).toBe(5)
      if (process.platform !== 'win32' || name === 'memory') expect(st.mode & 0o777).toBe(0o600)
    })

    it('rename replaces the destination; link and copyFile never clobber', async () => {
      ctx = make()
      const { fs, dir } = ctx
      const a = join(dir, 'a')
      const b = join(dir, 'b')
      for (const [p, s] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const f = await fs.createExclusive(p, 0o600)
        await f.write(bytes(s))
        await f.close()
      }
      expect(await code(fs.link(a, b))).toBe('EEXIST')
      expect(await code(fs.copyFile(a, b))).toBe('EEXIST')
      await fs.copyFile(a, join(dir, 'c'))
      await fs.fsyncFile(join(dir, 'c'))
      await fs.link(a, join(dir, 'd'))
      expect((await fs.lstat(join(dir, 'd'))).ino).toBe((await fs.lstat(a)).ino)
      await fs.rename(a, b)
      expect(await fs.readFile(b)).toEqual(bytes('A'))
      expect(await code(fs.readFile(a))).toBe('ENOENT')
      await fs.fsyncDir(dir)
      expect((await fs.readdir(dir)).sort()).toEqual(['b', 'c', 'd'])
      await fs.unlink(join(dir, 'd'))
      expect(await code(fs.unlink(join(dir, 'd')))).toBe('ENOENT')
      expect(await code(fs.lstat(join(dir, 'zz')))).toBe('ENOENT')
    })

    it('realpath resolves a file symlink; lstat does not follow it', async () => {
      ctx = make()
      const { fs, dir } = ctx
      const target = join(dir, 'target')
      const f = await fs.createExclusive(target, 0o600)
      await f.close()
      const link = join(dir, 'link')
      try {
        if (fs instanceof MemoryFileSystem) fs.setSymlink(link, 'target')
        else symlinkSync(target, link)
      } catch {
        return // symlinks need privileges on some Windows runners
      }
      expect(await fs.realpath(link)).toBe(await fs.realpath(target))
      expect((await fs.lstat(link)).isSymbolicLink).toBe(true)
    })
  })
}

contract('memory', () => {
  const fs = new MemoryFileSystem()
  fs.mkdirp('/m')
  return { fs, dir: MemoryFileSystem.norm('/m'), cleanup: () => {} }
})

contract('node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp6-fs-'))
  return {
    fs: createNodeFileSystem(),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
})

describe('MemoryFileSystem fault injection', () => {
  it('numbers every operation and fails exactly the chosen one', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile('/d/x', bytes('x'))
    fs.onOp = (op) => (op.index === 1 ? { kind: 'fail', code: 'EIO' } : undefined)
    await fs.readFile('/d/x')
    expect(await code(fs.readFile('/d/x'))).toBe('EIO')
    await fs.readFile('/d/x')
    expect(fs.ops.map((o) => o.label)).toEqual(['readFile:x', 'readFile:x', 'readFile:x'])
  })

  it('a simulated crash stops the operation and every later one until revive', async () => {
    const fs = new MemoryFileSystem()
    fs.mkdirp('/d')
    fs.onOp = (op) => (op.name === 'rename' ? { kind: 'crash' } : undefined)
    const f = await fs.createExclusive('/d/a', 0o600)
    await f.write(bytes('A'))
    await f.close()
    await expect(fs.rename('/d/a', '/d/b')).rejects.toBeInstanceOf(SimulatedCrash)
    await expect(fs.unlink('/d/a')).rejects.toBeInstanceOf(SimulatedCrash)
    expect(fs.crashed).toBe(true)
    expect(fs.list('/d')).toEqual(['a'])
    fs.revive()
    await fs.rename('/d/a', '/d/b')
    expect(fs.list('/d')).toEqual(['b'])
  })

  it('a torn write lands half the data, then the process dies', async () => {
    const fs = new MemoryFileSystem()
    fs.mkdirp('/d')
    fs.onOp = (op) => (op.name === 'write' ? { kind: 'torn-crash' } : undefined)
    const f = await fs.createExclusive('/d/a', 0o600)
    await expect(f.write(bytes('ABCDEFGH'))).rejects.toBeInstanceOf(SimulatedCrash)
    expect(fs.peek('/d/a')).toEqual(bytes('ABCD'))
  })

  it('read-only folders refuse new entries with EACCES', async () => {
    const fs = new MemoryFileSystem()
    fs.setFile('/ro/a', bytes('a'))
    fs.setReadOnlyDir('/ro')
    expect(await code(fs.createExclusive('/ro/b', 0o600))).toBe('EACCES')
    expect(await code(fs.unlink('/ro/a'))).toBe('EACCES')
  })

  it('clone copies the disk independently', () => {
    const fs = new MemoryFileSystem()
    fs.setFile('/d/a', bytes('a'))
    const c = fs.clone()
    c.setFile('/d/b', bytes('b'))
    expect(fs.list('/d')).toEqual(['a'])
    expect(c.list('/d')).toEqual(['a', 'b'])
  })
})

describe('network volume detection', () => {
  it.each([
    [{ magic: 0x6969 }, true],
    [{ magic: 0xff534d42 }, true],
    [{ magic: 0xfe534d42 }, true],
    [{ magic: 0x517b }, true],
    [{ magic: 0x65735546 }, true],
    [{ magic: 0xef53 }, false],
    [{ magic: 0x9123683e }, false],
    [{ name: 'smbfs' }, true],
    [{ name: 'afpfs' }, true],
    [{ name: 'nfs' }, true],
    [{ name: 'webdav' }, true],
    [{ name: 'apfs' }, false],
    [{ name: 'hfs' }, false],
    [{}, false],
  ])('%j → %s', (info, expected) => expect(isNetworkFs(info)).toBe(expected))

  it('finds the longest macOS mount point holding a path', () => {
    const table = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
      '//alex@nas._smb._tcp.local/Vaults on /Volumes/Vaults (smbfs, nodev, nosuid, mounted by alex)',
      'nas:/export on /Volumes/NFS Share (nfs, asynchronous)',
    ].join('\n')
    expect(mountTypeFor(table, '/Volumes/Vaults/p.psafe3')).toBe('smbfs')
    expect(mountTypeFor(table, '/Volumes/NFS Share/p.psafe3')).toBe('nfs')
    expect(mountTypeFor(table, '/Volumes/VaultsX/p.psafe3')).toBe('apfs')
    expect(mountTypeFor(table, '/System/Volumes/Data/Users/a/p.psafe3')).toBe('apfs')
    expect(mountTypeFor('', '/x')).toBeUndefined()
  })

  // Uses the host's real paths as mount points, which only have macOS-style '/' paths on POSIX
  // hosts. The Windows build never takes this code path (fsType is darwin/linux only).
  it.runIf(process.platform !== 'win32')(
    'the macOS implementation reads the mount table',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wp6-mt-'))
      try {
        // The mount table lists real paths (e.g. /private/var rather than /var on macOS).
        const real = realpathSync(dir)
        const fs = createNodeFileSystem({
          platform: 'darwin',
          readMountTable: async () =>
            `//u@h/s on ${real} (smbfs, nodev)\n/dev/x on / (apfs, local)`,
        })
        expect(await fs.fsType(dir)).toEqual({ name: 'smbfs' })
        expect(await fs.fsType(tmpdir())).toEqual({ name: 'apfs' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'linux')('Linux statfs reports a magic number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp6-sf-'))
    try {
      writeFileSync(join(dir, 'f'), 'x')
      const info = await createNodeFileSystem().fsType(dir)
      expect(typeof info.magic).toBe('number')
      expect(statSync(dir).isDirectory()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
