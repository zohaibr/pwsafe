// Small JSON files in the user-data folder (settings, recent files): read tolerantly, write
// atomically (temp file + rename) so a crash never leaves half a file.
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** The parsed JSON, or undefined when the file is missing or not valid JSON. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', 0o600)
}

/**
 * Writes `data` to `path` through `.<name>.<random>.tmp` in the same folder, created with `mode`
 * and O_EXCL, fsynced, then renamed over `path`. The temp file is removed on failure.
 */
export async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'wx', mode)
  try {
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
