// Files handed to us by the OS on the command line (Windows/Linux double-click, second instance).
import { resolve } from 'node:path'

/** The last argument that names a .psafe3 file, resolved; undefined when there is none. */
export function fileFromArgv(argv: readonly string[], cwd?: string): string | undefined {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (a === undefined || a.startsWith('-')) continue
    if (/\.psafe3$/i.test(a)) return cwd ? resolve(cwd, a) : resolve(a)
  }
  return undefined
}
