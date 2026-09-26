// Recent files (§B). Paths stay in the main process; the renderer only ever sees an opaque id
// (random per launch), the file name and its folder for display.
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { RecentFile } from '../../shared/ipc'
import { readJson, writeJsonAtomic } from './jsonFile'

export const RECENT_FILE = 'recent-files.json'
export const MAX_RECENT = 10

export class RecentFiles {
  private paths: string[] = []
  private readonly ids = new Map<string, string>()
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, RECENT_FILE)
  }

  async load(): Promise<void> {
    const raw = await readJson(this.file)
    const list = Array.isArray(raw) ? raw : []
    this.paths = list
      .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096)
      .slice(0, MAX_RECENT)
  }

  private idFor(path: string): string {
    for (const [id, p] of this.ids) if (p === path) return id
    const id = `r-${randomBytes(9).toString('hex')}`
    this.ids.set(id, path)
    return id
  }

  /** Files that still exist, newest first. */
  async list(): Promise<RecentFile[]> {
    const out: RecentFile[] = []
    for (const p of this.paths) {
      try {
        if (!(await stat(p)).isFile()) continue
      } catch {
        continue
      }
      out.push({ id: this.idFor(p), fileName: basename(p), folder: dirname(p) })
    }
    return out
  }

  /** The path behind an id we handed out, or undefined. */
  pathFor(id: string): string | undefined {
    const p = this.ids.get(id)
    return p !== undefined && this.paths.includes(p) ? p : undefined
  }

  /** Moves `path` to the top and saves the list. */
  async add(path: string): Promise<void> {
    const abs = resolve(path)
    this.paths = [abs, ...this.paths.filter((p) => p !== abs)].slice(0, MAX_RECENT)
    await writeJsonAtomic(this.file, this.paths)
  }
}
