// In-memory FileSystem with fault injection, for tests (docs/execution-plan.md §A5 fault-injection
// suite). Every call (including each write, sync and close on an open file) is one numbered
// operation. A hook can make any single operation fail with an errno, or simulate a process death:
// the operation does not happen (or, for a write, only half of it lands) and every later operation
// of that "process" fails too, so the disk is frozen exactly as the dying process left it.
// `revive()` starts a new "process" on the same disk.
import { basename, dirname, resolve } from 'node:path'
import type { FileStat, FileSystem, FsTypeInfo, WritableFile } from './types'
import { fsError } from './types'

/** Thrown by every operation once a simulated process death has happened. */
export class SimulatedCrash extends Error {
  override name = 'SimulatedCrash'
}

export interface FsOp {
  /** 0-based position in this process's operation sequence. */
  index: number
  name: string
  path: string
  path2?: string
  /** `name:basename(path)[->basename(path2)]`, stable across runs with the same random tags. */
  label: string
}

export type FaultAction =
  | { kind: 'fail'; code: string }
  | { kind: 'crash' }
  /** Writes only: the first half of the data lands, then the process dies. */
  | { kind: 'torn-crash' }

interface FileNode {
  kind: 'file'
  data: Uint8Array
  ino: number
  mode: number
  mtimeMs: number
}

interface LinkNode {
  kind: 'symlink'
  target: string
  ino: number
}

type Node = FileNode | LinkNode

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export interface MemoryFsSnapshotEntry {
  kind: 'file' | 'symlink'
  data?: Uint8Array
  target?: string
  mode?: number
}

export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, Node>()
  private dirs = new Set<string>()
  private readOnlyDirs = new Set<string>()
  private fsTypes = new Map<string, FsTypeInfo>()
  private nextIno = 100
  private clock = 1_700_000_000_000
  private dead = false
  private opIndex = 0

  /** Every operation of the current process, in order. */
  ops: FsOp[] = []
  /** Decides the fate of each operation; return undefined to let it run. */
  onOp: ((op: FsOp) => FaultAction | undefined) | undefined

  /** Normalises a path the same way on every OS (so tests may use POSIX-looking paths). */
  static norm(p: string): string {
    return resolve(p)
  }

  // ── Test setup helpers (not operations; never faulted) ────────────────────
  mkdirp(dir: string): void {
    let d = resolve(dir)
    for (;;) {
      this.dirs.add(d)
      const up = dirname(d)
      if (up === d) break
      d = up
    }
  }

  setFile(path: string, data: Uint8Array, mode = 0o600): void {
    const p = resolve(path)
    this.mkdirp(dirname(p))
    this.files.set(p, {
      kind: 'file',
      data: data.slice(),
      ino: this.nextIno++,
      mode: S_IFREG | (mode & 0o7777),
      mtimeMs: this.tick(),
    })
  }

  setSymlink(path: string, target: string): void {
    const p = resolve(path)
    this.mkdirp(dirname(p))
    this.files.set(p, { kind: 'symlink', target, ino: this.nextIno++ })
  }

  /** Makes creating, renaming or deleting entries in `dir` fail with EACCES. */
  setReadOnlyDir(dir: string, readOnly = true): void {
    if (readOnly) this.readOnlyDirs.add(resolve(dir))
    else this.readOnlyDirs.delete(resolve(dir))
  }

  setFsType(dir: string, info: FsTypeInfo): void {
    this.fsTypes.set(resolve(dir), info)
  }

  /** Content of a file (following nothing), or undefined. */
  peek(path: string): Uint8Array | undefined {
    const n = this.files.get(resolve(path))
    return n?.kind === 'file' ? n.data.slice() : undefined
  }

  exists(path: string): boolean {
    return this.files.has(resolve(path))
  }

  /** Sorted entry names in a directory. */
  list(dir: string): string[] {
    const d = resolve(dir)
    const out: string[] = []
    for (const p of this.files.keys()) if (dirname(p) === d) out.push(basename(p))
    return out.sort()
  }

  /** A deep copy of the whole disk. */
  snapshot(): Map<string, MemoryFsSnapshotEntry> {
    const out = new Map<string, MemoryFsSnapshotEntry>()
    for (const [p, n] of this.files) {
      out.set(
        p,
        n.kind === 'file'
          ? { kind: 'file', data: n.data.slice(), mode: n.mode }
          : { kind: 'symlink', target: n.target },
      )
    }
    return out
  }

  /** A new file system with an independent copy of this disk (same directories and settings). */
  clone(): MemoryFileSystem {
    const c = new MemoryFileSystem()
    for (const [p, n] of this.files) {
      c.files.set(p, n.kind === 'file' ? { ...n, data: n.data.slice() } : { ...n })
    }
    c.dirs = new Set(this.dirs)
    c.readOnlyDirs = new Set(this.readOnlyDirs)
    c.fsTypes = new Map(this.fsTypes)
    c.nextIno = this.nextIno
    c.clock = this.clock
    return c
  }

  get crashed(): boolean {
    return this.dead
  }

  /** Starts a new "process": clears the crash, the op log and the hook. The disk is kept. */
  revive(): void {
    this.dead = false
    this.opIndex = 0
    this.ops = []
    this.onOp = undefined
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private tick(): number {
    this.clock += 1_000
    return this.clock
  }

  /** Runs the fault hook for one operation. Returns true for a torn write. */
  private begin(name: string, path: string, path2?: string): boolean {
    if (this.dead) throw new SimulatedCrash('process is dead')
    const label = `${name}:${basename(path)}` + (path2 === undefined ? '' : `->${basename(path2)}`)
    const op: FsOp = { index: this.opIndex++, name, path: resolve(path), label }
    if (path2 !== undefined) op.path2 = resolve(path2)
    this.ops.push(op)
    const action = this.onOp?.(op)
    if (!action) return false
    if (action.kind === 'fail') throw fsError(action.code, name, path)
    if (action.kind === 'crash') {
      this.dead = true
      throw new SimulatedCrash(`crash before ${label}`)
    }
    return true
  }

  private dieAfterTornWrite(label: string): never {
    this.dead = true
    throw new SimulatedCrash(`crash during ${label}`)
  }

  private requireDir(path: string, syscall: string): void {
    const d = dirname(path)
    if (!this.dirs.has(d)) throw fsError('ENOENT', syscall, path)
  }

  private requireWritableDir(path: string, syscall: string): void {
    this.requireDir(path, syscall)
    if (this.readOnlyDirs.has(dirname(path))) throw fsError('EACCES', syscall, path)
  }

  /** Follows symlinks (up to 16) to a file node. */
  private resolveNode(path: string, syscall: string): { path: string; node: FileNode } {
    let p = resolve(path)
    for (let i = 0; i < 16; i++) {
      const n = this.files.get(p)
      if (!n) {
        if (this.dirs.has(p)) throw fsError('EISDIR', syscall, path)
        throw fsError('ENOENT', syscall, path)
      }
      if (n.kind === 'file') return { path: p, node: n }
      p = resolve(dirname(p), n.target)
    }
    throw fsError('ELOOP', syscall, path)
  }

  // ── FileSystem ────────────────────────────────────────────────────────────
  async readFile(path: string): Promise<Uint8Array> {
    this.begin('readFile', path)
    return this.resolveNode(path, 'open').node.data.slice()
  }

  async createExclusive(path: string, mode: number): Promise<WritableFile> {
    this.begin('createExclusive', path)
    const p = resolve(path)
    this.requireWritableDir(p, 'open')
    if (this.files.has(p) || this.dirs.has(p)) throw fsError('EEXIST', 'open', path)
    const node: FileNode = {
      kind: 'file',
      data: new Uint8Array(0),
      ino: this.nextIno++,
      mode: S_IFREG | (mode & 0o7777),
      mtimeMs: this.tick(),
    }
    this.files.set(p, node)
    let closed = false
    return {
      write: async (data) => {
        const torn = this.begin('write', path)
        if (closed) throw fsError('EBADF', 'write', path)
        const chunk = torn ? data.subarray(0, Math.floor(data.length / 2)) : data
        const next = new Uint8Array(node.data.length + chunk.length)
        next.set(node.data, 0)
        next.set(chunk, node.data.length)
        node.data = next
        node.mtimeMs = this.tick()
        if (torn) this.dieAfterTornWrite(`write:${basename(path)}`)
      },
      sync: async () => {
        this.begin('fsync', path)
        if (closed) throw fsError('EBADF', 'fsync', path)
      },
      close: async () => {
        this.begin('close', path)
        closed = true
      },
    }
  }

  async fsyncFile(path: string): Promise<void> {
    this.begin('fsyncFile', path)
    this.resolveNode(path, 'open')
  }

  async fsyncDir(path: string): Promise<void> {
    this.begin('fsyncDir', path)
    if (!this.dirs.has(resolve(path))) throw fsError('ENOENT', 'open', path)
  }

  async rename(from: string, to: string): Promise<void> {
    this.begin('rename', from, to)
    const f = resolve(from)
    const t = resolve(to)
    this.requireWritableDir(f, 'rename')
    this.requireWritableDir(t, 'rename')
    const n = this.files.get(f)
    if (!n) throw fsError('ENOENT', 'rename', from)
    if (this.dirs.has(t)) throw fsError('EISDIR', 'rename', to)
    if (f === t) return
    this.files.delete(f)
    this.files.set(t, n)
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.begin('link', existingPath, newPath)
    const f = resolve(existingPath)
    const t = resolve(newPath)
    this.requireWritableDir(t, 'link')
    const n = this.files.get(f)
    if (!n) throw fsError('ENOENT', 'link', existingPath)
    if (this.files.has(t) || this.dirs.has(t)) throw fsError('EEXIST', 'link', newPath)
    this.files.set(t, n)
  }

  async unlink(path: string): Promise<void> {
    this.begin('unlink', path)
    const p = resolve(path)
    this.requireWritableDir(p, 'unlink')
    if (!this.files.has(p)) throw fsError(this.dirs.has(p) ? 'EISDIR' : 'ENOENT', 'unlink', path)
    this.files.delete(p)
  }

  async lstat(path: string): Promise<FileStat> {
    this.begin('lstat', path)
    const p = resolve(path)
    const n = this.files.get(p)
    if (!n) {
      if (this.dirs.has(p)) {
        return {
          dev: '1',
          ino: '1',
          size: 0,
          mtimeMs: 0,
          mode: S_IFDIR | 0o755,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        }
      }
      throw fsError('ENOENT', 'lstat', path)
    }
    if (n.kind === 'symlink') {
      return {
        dev: '1',
        ino: String(n.ino),
        size: n.target.length,
        mtimeMs: 0,
        mode: S_IFLNK | 0o777,
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
      }
    }
    return {
      dev: '1',
      ino: String(n.ino),
      size: n.data.length,
      mtimeMs: n.mtimeMs,
      mode: n.mode,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }
  }

  async realpath(path: string): Promise<string> {
    this.begin('realpath', path)
    const p = resolve(path)
    if (this.dirs.has(p)) return p
    return this.resolveNode(p, 'realpath').path
  }

  async copyFile(src: string, dest: string): Promise<void> {
    this.begin('copyFile', src, dest)
    const from = this.resolveNode(src, 'copyfile').node
    const t = resolve(dest)
    this.requireWritableDir(t, 'copyfile')
    if (this.files.has(t) || this.dirs.has(t)) throw fsError('EEXIST', 'copyfile', dest)
    this.files.set(t, {
      kind: 'file',
      data: from.data.slice(),
      ino: this.nextIno++,
      mode: from.mode,
      mtimeMs: this.tick(),
    })
  }

  async readdir(path: string): Promise<string[]> {
    this.begin('readdir', path)
    const d = resolve(path)
    if (!this.dirs.has(d)) throw fsError('ENOENT', 'scandir', path)
    return this.list(d)
  }

  async fsType(path: string): Promise<FsTypeInfo> {
    this.begin('fsType', path)
    let d = resolve(path)
    for (;;) {
      const t = this.fsTypes.get(d)
      if (t) return { ...t }
      const up = dirname(d)
      if (up === d) return {}
      d = up
    }
  }
}

/** Operation names that change the disk. */
export const MUTATING_OPS: ReadonlySet<string> = new Set([
  'createExclusive',
  'write',
  'rename',
  'link',
  'unlink',
  'copyFile',
])

export const FILE_MODE_REGULAR = S_IFREG
