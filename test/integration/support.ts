// Shared helpers for the WP8 integration and oracle suites: the committed fixtures in
// test/fixtures/generated/ with their expected values, a codec setup with real Twofish, and the
// comparison of decoded values against the expected-values JSON (docs/execution-plan.md §A2).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { createTwofish } from '../../src/main/crypto/twofish/twofish'
import { type CodecDeps, type DecodedVault, decode } from '../../src/main/psafe3/codec'
import { type StretchFn, stretchKeySync } from '../../src/main/psafe3/stretch'
import { buildEntries } from '../../src/main/psafe3/views'
import type { Result } from '../../src/shared/errors'
import type { RawRecord } from '../../src/shared/types'

export const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/generated')

/** One entry of an `*.expected.json` file, written by test/fixtures/make-generated.mjs. */
export interface ExpectedEntry {
  /** null when the CLI gives no way to read it back (alias and shortcut entries). */
  uuid: string | null
  group: string
  title: string
  username: string
  password: string
  url: string
  email: string
  notes: string
  created?: string
  passwordModified?: string
  modified?: string
  expires?: string
  kind?: string
  baseUuid?: string
  hasHistory?: boolean
  hasTotp?: boolean
  protected?: boolean
}

export interface ExpectedFile {
  file: string
  password: string
  formatVersion: string
  iterations: number
  entryCount: number
  entries: ExpectedEntry[]
}

export interface Fixture {
  name: string
  path: string
  bytes: Uint8Array
  expected: ExpectedFile
  password: Uint8Array
}

/** Every committed fixture: each `*.psafe3` in test/fixtures/generated with its JSON. */
export const FIXTURE_NAMES: string[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.psafe3'))
  .map((f) => f.slice(0, -'.psafe3'.length))
  .sort()

export function loadFixture(name: string, dir = FIXTURE_DIR): Fixture {
  const path = join(dir, `${name}.psafe3`)
  const expected = JSON.parse(
    readFileSync(join(dir, `${name}.expected.json`), 'utf8'),
  ) as ExpectedFile
  return {
    name,
    path,
    bytes: new Uint8Array(readFileSync(path)),
    expected,
    password: new TextEncoder().encode(expected.password),
  }
}

const stretchCache = new Map<string, Uint8Array>()

/**
 * The reference key stretch on the calling thread, memoised by (password, salt, iterations).
 * Tampered copies of a fixture keep its salt, so the corpus pays for each real stretch once and
 * the < 2 s budget per case measures the parser, not SHA-256 rounds. A copy is returned because
 * the codec wipes P' after use.
 */
export const cachedStretch: StretchFn = async (password, salt, iterations) => {
  const key = createHash('sha256')
    .update(password)
    .update(salt)
    .update(String(iterations))
    .digest('hex')
  let p = stretchCache.get(key)
  if (!p) {
    p = stretchKeySync(password, salt, iterations)
    stretchCache.set(key, p)
  }
  return p.slice()
}

export const deps: CodecDeps = { cipherFactory: createTwofish, stretch: cachedStretch }

export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}

export async function decodeFixture(f: Fixture): Promise<DecodedVault> {
  return unwrap(await decode(f.bytes, f.password, deps))
}

/** Our decoded values in the shape of the expected JSON (only the keys the JSON uses). */
export function actualEntries(
  records: readonly RawRecord[],
  like: readonly ExpectedEntry[],
): ExpectedEntry[] {
  const entries = buildEntries(records, { includePassword: true })
  const usesKind = like.some((e) => e.kind !== undefined)
  return entries.map((e) => {
    const out: ExpectedEntry = {
      uuid: e.uuid,
      group: e.group,
      title: e.title,
      username: e.username,
      password: e.password,
      url: e.url,
      email: e.email,
      notes: e.notes,
    }
    for (const k of ['created', 'passwordModified', 'modified', 'expires', 'baseUuid'] as const) {
      if (e[k] !== undefined) out[k] = e[k]
    }
    if (usesKind) out.kind = e.kind
    if (e.flags.hasHistory) out.hasHistory = true
    if (e.flags.hasTotp) out.hasTotp = true
    if (!e.editable && e.readOnlyReason?.includes('protected')) out.protected = true
    return out
  })
}

const sortKey = (e: ExpectedEntry) => `${e.uuid ?? '~'}\u0000${e.group}\u0000${e.title}`

/**
 * Asserts that decoded records hold exactly the expected entries (compared as a set: the CLI
 * orders records itself). Entries whose UUID the JSON leaves null match on group and title.
 */
export function expectEntries(records: readonly RawRecord[], expected: ExpectedEntry[]): void {
  const actual = actualEntries(records, expected)
  expect(actual).toHaveLength(expected.length)
  const withUuid = expected.filter((e) => e.uuid !== null)
  const known = new Set(withUuid.map((e) => e.uuid))
  const actualKnown = actual.filter((a) => known.has(a.uuid))
  const sort = (xs: ExpectedEntry[]) =>
    xs.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
  expect(sort(actualKnown)).toEqual(sort(withUuid))
  const rest = actual.filter((a) => !known.has(a.uuid))
  const restExpected = expected.filter((e) => e.uuid === null)
  expect(rest).toHaveLength(restExpected.length)
  for (const e of restExpected) {
    const a = rest.find((x) => x.title === e.title && x.group === e.group)
    expect(a, e.title).toBeDefined()
    expect(a!.uuid).toMatch(/^[0-9a-f]{32}$/)
    expect({ ...a, uuid: null }).toEqual(e)
  }
}
