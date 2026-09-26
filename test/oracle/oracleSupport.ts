// Helpers for the WP8 oracle suites: run the pinned pwsafe-cli (via the lead-owned pwsafeCli.ts),
// read its XML export, and compare it with our decoded values. Passphrases go to the CLI's stdin;
// nothing here prints entry values, and exported XML stays in the test's temp directory.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'
import { parseExport } from '../../src/main/export/xmlExport.testutil'
import type { ExpectedEntry } from '../integration/support'
import { ORACLE_CLI, hasOracle, runCli } from './pwsafeCli'

export { hasOracle }
export const XSD_DIR = process.env['PWS_XMLDIR'] ?? ''

/** CLI runs exit 0, or the test fails with the CLI's stderr (which carries no entry values). */
export function cliOk(dir: string, args: string[], password: string, times = 1): void {
  const run = runCli(args, Array<string>(times).fill(password), dir)
  expect(run.status, `pwsafe-cli ${args.slice(1).join(' ').slice(0, 40)}: ${run.stderr}`).toBe(0)
}

/** Runs the CLI and returns stdout (test data only; never printed). */
export function cliStdout(dir: string, args: string[], password: string): string {
  const res = spawnSync(ORACLE_CLI, args, {
    cwd: dir,
    input: `${password}\n`,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    timeout: 60_000,
  })
  expect(res.status, `pwsafe-cli ${args[1] ?? ''}`).toBe(0)
  return res.stdout ?? ''
}

/**
 * pwsafe-cli writes times in local time without a zone. Run it with TZ=UTC for the duration of a
 * test file (runCli passes process.env through).
 */
export function useUtcForCli(): void {
  const saved = process.env['TZ']
  beforeAll(() => {
    process.env['TZ'] = 'UTC'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ']
    else process.env['TZ'] = saved
  })
}

export interface CliExport {
  xml: string
  entries: Record<string, string>[]
  byUuid: Map<string, Record<string, string>>
  /** Raw `<entry>` blocks by UUID, with the running `id` attribute removed. */
  blocks: Map<string, string>
}

/** `pwsafe-cli <file> --export=<file>.xml --xml`, parsed. */
export function cliExport(dir: string, file: string, password: string): CliExport {
  cliOk(dir, [file, `--export=${file}.xml`, '--xml'], password)
  const xml = readFileSync(join(dir, `${file}.xml`), 'utf8')
  const entries = parseExport(xml).entries
  const byUuid = new Map(entries.map((e) => [e['uuid'] ?? '', e]))
  const blocks = new Map<string, string>()
  for (const m of xml.matchAll(/<entry id="\d+">([\s\S]*?)<\/entry>/g)) {
    const uuid = /<uuid><!\[CDATA\[([0-9a-f]{32})\]\]><\/uuid>/.exec(m[1]!)?.[1]
    if (uuid) blocks.set(uuid, m[1]!)
  }
  expect(blocks.size).toBe(entries.length)
  return { xml, entries, byUuid, blocks }
}

/** An ISO time from our model as pwsafe-cli prints it under TZ=UTC. */
export const cliTime = (iso: string) => iso.slice(0, 19)

/**
 * What the CLI's XML export shows for an entry with these values: it exports with
 * delimiter=" ", so line breaks in notes come out as spaces; absent elements read as ''.
 */
export function cliView(e: ExpectedEntry): Record<string, string> {
  const out: Record<string, string> = {
    uuid: e.uuid ?? '',
    group: e.group,
    title: e.title,
    username: e.username,
    password: e.password,
    url: e.url,
    email: e.email,
    notes: e.notes.replace(/\r\n|\r|\n/g, ' '),
  }
  if (e.created) out['ctimex'] = cliTime(e.created)
  if (e.passwordModified) out['pmtimex'] = cliTime(e.passwordModified)
  if (e.modified) out['rmtimex'] = cliTime(e.modified)
  if (e.expires) out['xtimex'] = cliTime(e.expires)
  return out
}

const VIEW_KEYS = ['group', 'title', 'username', 'password', 'url', 'email', 'notes']
const TIME_KEYS = ['ctimex', 'pmtimex', 'rmtimex', 'xtimex']

/** The same keys read from one entry of a CLI export. */
export function fromCli(c: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { uuid: c['uuid'] ?? '' }
  for (const k of VIEW_KEYS) out[k] = c[k] ?? ''
  for (const k of TIME_KEYS) if (c[k] !== undefined) out[k] = c[k]
  return out
}

/** Every expected entry appears in the CLI export with the same values, and nothing else. */
export function expectCliMatches(exp: CliExport, expected: ExpectedEntry[]): void {
  expect(exp.entries).toHaveLength(expected.length)
  for (const e of expected) {
    const c = exp.byUuid.get(e.uuid ?? '')
    expect(c, `entry ${e.uuid} in the CLI export`).toBeDefined()
    expect(fromCli(c!), `entry ${e.uuid}`).toEqual(cliView(e))
  }
}

/** Entries whose notes have line breaks, which the CLI's XML export flattens. */
export const multiLine = (entries: ExpectedEntry[]) => entries.filter((e) => /\r|\n/.test(e.notes))

/**
 * Checks the stored notes (with their CRLFs) through `--search=<title> --print=Notes`, since the
 * CLI's XML export turns line breaks into spaces.
 */
export function expectNotesViaPrint(
  dir: string,
  file: string,
  password: string,
  entries: ExpectedEntry[],
): void {
  for (const e of entries) {
    const out = cliStdout(dir, [file, `--search=${e.title}`, '--print=Notes'], password)
    expect(out.includes(`Notes: ${e.notes}\n`), `notes of ${e.uuid} via --print`).toBe(true)
  }
}
