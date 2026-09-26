// §A2 independent oracle, direction 2: we open a pwsafe-cli fixture, edit entries (applyDraft),
// add entries (createRecord) and delete entries, save with our encoder, and pwsafe-cli 1.25.0 must
// open the result and export exactly the values we expect. The expected values are the fixture's
// JSON with the same edits applied to it, not our parser's output. Entries and fields we did not
// touch must come back unchanged, both in the CLI's own export and byte for byte in our decode.
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decode, encode } from '../../src/main/psafe3/codec'
import { SAVE_METADATA_HEADER_TYPES, stampHeaderForSave } from '../../src/main/psafe3/header'
import {
  applyDraft,
  buildEntries,
  createRecord,
  hasDependants,
  indexRecords,
  recordUuid,
} from '../../src/main/psafe3/views'
import { FieldType, type EntryDraft, type RawRecord } from '../../src/shared/types'
import {
  type ExpectedEntry,
  type Fixture,
  decodeFixture,
  deps,
  expectEntries,
  loadFixture,
  unwrap,
} from '../integration/support'
import {
  XSD_DIR,
  cliExport,
  cliStdout,
  expectCliMatches,
  expectNotesViaPrint,
  hasOracle,
  multiLine,
  useUtcForCli,
} from './oracleSupport'

const enabled = hasOracle && XSD_DIR !== ''
const why = !hasOracle ? 'PWSAFE_CLI is not set' : 'PWS_XMLDIR is not set'

/** Edit time, written to 0x0c (and 0x08 when the password changes). */
const NOW = 1_800_000_000
const NOW_ISO = new Date(NOW * 1000).toISOString()

interface Plan {
  /** Edits by the entry's (group, title) in the fixture. */
  edits: { group: string; title: string; draft: EntryDraft }[]
  deletes: { group: string; title: string }[]
  adds: EntryDraft[]
}

const ADDS: EntryDraft[] = [
  {
    title: 'Added by us',
    password: 'added, with; commas & <xml> ]]>',
    group: 'New.Nested\\.dot.Group',
    username: 'nuevo',
    url: 'https://added.example.org/',
    email: 'added@example.org',
    notes: 'first line\r\nsecond line ü 🔑',
  },
  { title: 'Added minimal', password: 'min' },
]

const PLANS: Record<string, Plan> = {
  'cli-add': {
    edits: [
      {
        group: 'Banking.Online',
        title: 'Example Bank',
        draft: {
          title: 'Example Bank (edited)',
          password: 'n3w pässword; with, commas',
          notes: 'now\r\nmulti-line',
        },
      },
      // History, 2FA and the extra fields of these records must survive the edit untouched.
      { group: '', title: 'With history', draft: { password: 'changed-current' } },
      { group: '', title: 'With 2FA', draft: { username: 'totp-user' } },
      {
        group: '',
        title: 'Extras',
        draft: { group: 'Moved.Here\\.too', email: 'extras@example.com' },
      },
      {
        group: 'Grüße.日本',
        title: 'Unicode ü 日本語 🔑',
        draft: { username: '', url: 'https://ünicode.example/路径' },
      },
    ],
    deletes: [
      { group: '', title: 'Minimal' },
      { group: 'Dup2', title: 'Same title' },
    ],
    adds: ADDS,
  },
  'cli-import': {
    edits: [
      {
        group: 'Notes.Multi',
        title: 'Multi line',
        draft: { notes: 'replaced\r\n\r\nnotes', group: 'Notes.Multi.Deeper' },
      },
      { group: 'Big', title: 'Very long notes', draft: { password: 'x'.repeat(500) } },
    ],
    deletes: [{ group: '', title: 'Empty username element' }],
    adds: ADDS,
  },
  'cli-many': {
    edits: [0, 125, 249].map((i) => {
      const n = String(i).padStart(3, '0')
      return {
        group: `Many.Group ${i % 10}.Sub ${i % 3}`,
        title: `Entry ${n}`,
        draft: { title: `Entry ${n} edited`, password: `new-${n}` },
      }
    }),
    deletes: Array.from({ length: 10 }, (_, k) => {
      const i = 100 + k
      return { group: `Many.Group ${i % 10}.Sub ${i % 3}`, title: `Entry ${i}` }
    }),
    adds: ADDS,
  },
}

/** A counter-based byte source, so the UUIDs of added records are known in advance. */
function scriptedRandom(seed: number) {
  let n = seed
  return (len: number) => Uint8Array.from({ length: len }, () => n++ & 0xff)
}

const key = (group: string, title: string) => `${group}\u0000${title}`

/** Applies the plan to the fixture's JSON: the independent expectation. */
function expectedAfter(f: Fixture, plan: Plan, addedUuids: string[]): ExpectedEntry[] {
  const deleted = new Set(plan.deletes.map((d) => key(d.group, d.title)))
  const out: ExpectedEntry[] = []
  for (const e of f.expected.entries) {
    if (deleted.has(key(e.group, e.title))) continue
    const edit = plan.edits.find((x) => key(x.group, x.title) === key(e.group, e.title))
    if (!edit) {
      out.push(e)
      continue
    }
    const next: ExpectedEntry = { ...e, ...edit.draft, uuid: e.uuid, modified: NOW_ISO }
    if (edit.draft.password !== undefined) next.passwordModified = NOW_ISO
    out.push(next)
  }
  plan.adds.forEach((a, i) => {
    out.push({
      uuid: addedUuids[i]!,
      group: a.group ?? '',
      title: a.title ?? '',
      username: a.username ?? '',
      password: a.password ?? '',
      url: a.url ?? '',
      email: a.email ?? '',
      notes: a.notes ?? '',
      created: NOW_ISO,
      passwordModified: NOW_ISO,
      modified: NOW_ISO,
    })
  })
  return out
}

/** Our edit of the decoded fixture, through the same view functions the app uses. */
function applyPlan(records: RawRecord[], plan: Plan) {
  const index = indexRecords(records)
  const entries = buildEntries(records)
  const find = (group: string, title: string) => {
    const hits = entries.flatMap((e, i) => (e.group === group && e.title === title ? [i] : []))
    expect(hits, `${group} / ${title}`).toHaveLength(1)
    return hits[0]!
  }
  const next: (RawRecord | undefined)[] = records.slice()
  const edited = new Map<string, EntryDraft>()
  for (const e of plan.edits) {
    const i = find(e.group, e.title)
    next[i] = unwrap(applyDraft(records[i]!, e.draft, index, { now: NOW }))
    edited.set(recordUuid(records[i]!)!, e.draft)
  }
  for (const d of plan.deletes) {
    const i = find(d.group, d.title)
    expect(hasDependants(records[i]!, index)).toBe(false)
    next[i] = undefined
  }
  const random = scriptedRandom(0x40)
  const added = plan.adds.map((a) => unwrap(createRecord(a, { now: NOW, randomBytes: random })))
  const out = [...next.filter((r): r is RawRecord => r !== undefined), ...added]
  return { records: out, edited, addedUuids: added.map((r) => recordUuid(r)!) }
}

/** CLI XML element names for the draft keys, plus the times an edit rewrites. */
const ELEMENTS: Record<string, string> = {
  group: 'group',
  title: 'title',
  username: 'username',
  password: 'password',
  url: 'url',
  email: 'email',
  notes: 'notes',
}
const DRAFT_TYPES: Record<string, number> = {
  group: FieldType.GROUP,
  title: FieldType.TITLE,
  username: FieldType.USERNAME,
  password: FieldType.PASSWORD,
  url: FieldType.URL,
  email: FieldType.EMAIL,
  notes: FieldType.NOTES,
}

/** An entry's XML block without the lines of the given elements. */
const without = (block: string, names: string[]) =>
  block
    .split('\n')
    .filter((l) => !names.some((n) => l.trimStart().startsWith(`<${n}>`)))
    .join('\n')

describe.skipIf(!enabled)(`our encoder -> pwsafe-cli${enabled ? '' : ` (skipped: ${why})`}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp8-ours-to-cli-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  useUtcForCli()

  describe.each(Object.keys(PLANS))('%s', (name) => {
    const f = loadFixture(name)
    const plan = PLANS[name]!
    const pass = f.expected.password

    it('after edits, adds and deletes, pwsafe-cli exports exactly the expected values, and untouched data survives', async () => {
      const original = await decodeFixture(f)
      const { records, edited, addedUuids } = applyPlan(original.records, plan)
      const header = stampHeaderForSave(original.header, {
        now: NOW,
        application: 'psafe3 Opener test',
      })
      const bytes = unwrap(
        await encode({ header, records }, f.password, deps, {
          iterations: original.meta.iterations,
        }),
      )
      writeFileSync(join(dir, `${name}.ours.psafe3`), bytes)
      copyFileSync(f.path, join(dir, `${name}.psafe3`))

      // 1. The CLI opens our file and its export holds exactly the expected values.
      const expected = expectedAfter(f, plan, addedUuids)
      const ours = cliExport(dir, `${name}.ours.psafe3`, pass)
      expectCliMatches(ours, expected)
      expectNotesViaPrint(dir, `${name}.ours.psafe3`, pass, multiLine(expected).slice(0, 6))

      // 2. In the CLI's own export, untouched entries are identical to the original file's,
      //    including elements we do not decode (history, run command, DCA, symbols, autotype,
      //    protected, 2FA); edited entries differ only in the edited elements and times.
      const theirs = cliExport(dir, `${name}.psafe3`, pass)
      let untouched = 0
      for (const [uuid, block] of theirs.blocks) {
        const mine = ours.blocks.get(uuid)
        if (mine === undefined) continue // deleted
        const draft = edited.get(uuid)
        if (!draft) {
          expect(mine, `untouched entry ${uuid}`).toBe(block)
          untouched++
          continue
        }
        const names = [...Object.keys(draft).map((k) => ELEMENTS[k]!), 'rmtimex', 'pmtimex']
        expect(without(mine, names), `edited entry ${uuid}`).toBe(without(block, names))
      }
      expect(untouched).toBe(f.expected.entries.length - plan.edits.length - plan.deletes.length)

      // 3. Byte for byte: header fields other than the save metadata, every field of untouched
      //    records, and every field we did not edit, in the same order.
      const back = unwrap(await decode(bytes, f.password, deps))
      expectEntries(back.records, expected)
      const strip = (h: typeof header) =>
        h.filter((x) => !SAVE_METADATA_HEADER_TYPES.includes(x.type))
      expect(strip(back.header)).toEqual(strip(original.header))
      const origByUuid = new Map(original.records.map((r) => [recordUuid(r)!, r]))
      for (const r of back.records) {
        const uuid = recordUuid(r)!
        const before = origByUuid.get(uuid)
        if (!before) continue // added
        const draft = edited.get(uuid)
        if (!draft) {
          expect(r, `record ${uuid}`).toEqual(before)
          continue
        }
        const changed = new Set([
          ...Object.keys(draft).map((k) => DRAFT_TYPES[k]!),
          FieldType.LAST_MOD_TIME,
          FieldType.PASSWORD_MOD_TIME,
        ])
        const keep = (x: RawRecord) => x.fields.filter((fl) => !changed.has(fl.type))
        expect(keep(r), `unedited fields of ${uuid}`).toEqual(keep(before))
      }
    }, 120_000)
  })

  it('cli-links: an edit next to aliases and shortcuts keeps the links, as the CLI sees them', async () => {
    const f = loadFixture('cli-links')
    const original = await decodeFixture(f)
    const { records } = applyPlan(original.records, {
      edits: [{ group: 'Links', title: 'Alias base', draft: { username: 'ab-edited' } }],
      deletes: [],
      adds: [{ title: 'Links added', password: 'la', group: 'Links' }],
    })
    const bytes = unwrap(
      await encode(
        {
          header: stampHeaderForSave(original.header, { now: NOW, application: 't' }),
          records,
        },
        f.password,
        deps,
        { iterations: original.meta.iterations },
      ),
    )
    writeFileSync(join(dir, 'links.ours.psafe3'), bytes)
    const print = (title: string) =>
      cliStdout(
        dir,
        ['links.ours.psafe3', `--search=${title}`, '--print=Username,Password'],
        f.expected.password,
      )
    expect(print('Alias base')).toContain('Username: ab-edited\n')
    expect(print('Alias base')).toContain('Password: alias-base-pw\n')
    expect(print('The alias')).toContain('Password: [Alias]\n')
    expect(print('The shortcut')).toContain('Password: [Shortcut]\n')
    expect(print('Links added')).toContain('Password: la\n')
    // The alias and shortcut records are unchanged byte for byte.
    const back = unwrap(await decode(bytes, f.password, deps))
    for (const t of ['The alias', 'The shortcut']) {
      const i = buildEntries(original.records).findIndex((e) => e.title === t)
      const j = buildEntries(back.records).findIndex((e) => e.title === t)
      expect(back.records[j]).toEqual(original.records[i])
    }
  }, 60_000)
})
