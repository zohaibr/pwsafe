// Regenerates the committed .psafe3 fixtures in test/fixtures/generated/ with the pinned pwsafe-cli
// oracle (Password Safe 1.25.0, Artistic License 2.0; see docs/references.md), plus one
// `<name>.expected.json` per file.
//
//   PWSAFE_CLI=.oracle/pwsafe-cli PWS_XMLDIR=$PWD/.oracle/xml/ node test/fixtures/make-generated.mjs [outDir]
//
// All content is made up; the passphrases are test-only strings. The passphrase is written to the
// CLI's stdin, never passed as --passphrase. Nothing here prints entry values.
//
// The expected values are written from the input tables below, not from our parser. Values the
// CLI chooses itself (UUIDs of entries made with --add) are read back from the CLI's own XML
// export, and every other value in that export is checked against the tables before anything is
// written. Salts, keys and padding are random, so the bytes differ on every run; the decoded
// values (and, for the imported fixtures, the UUIDs) are the same every time.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI = process.env.PWSAFE_CLI ? resolve(process.env.PWSAFE_CLI) : ''
const XMLDIR = process.env.PWS_XMLDIR ?? ''
if (!CLI || !XMLDIR) {
  console.error('Set PWSAFE_CLI (path to pwsafe-cli 1.25.0) and PWS_XMLDIR (dir with pwsafe.xsd, trailing slash).')
  process.exit(2)
}
const OUT = resolve(process.argv[2] ?? join(import.meta.dirname, 'generated'))

// ---------------------------------------------------------------------------------------------
// Input tables. Values given to --add cannot contain ',' or ';' (the CLI splits on them), cannot
// be empty, and cannot contain line breaks; those cases go through --import instead.

/** Entries of cli-add.psafe3, each added with one `--add=` call in this order. */
const ADD_ENTRIES = [
  {
    add: {
      Title: 'Example Bank',
      Username: 'jordan.example',
      Password: 'p&<>"q\'x!',
      Group: 'Banking.Online',
      URL: 'https://bank.example.com/login?a=1&b=2',
      'e-mail': 'jordan@example.com',
      Notes: 'Single line note with <xml> & "quotes"',
    },
  },
  { add: { Title: 'Nested', Password: 'nested-pw', Group: 'a.b.c', Username: 'deep' } },
  { add: { Title: 'Literal dot group', Password: 'dot-pw', Group: 'Dotted\\.Name.Sub' } },
  { add: { Title: 'Leading dot title .x', Password: 'x.y.z', Group: 'Top' } },
  {
    add: {
      Title: 'Unicode ü 日本語 🔑',
      Password: 'pä$$wörd🔐',
      Group: 'Grüße.日本',
      Username: 'Zoë',
      Notes: 'Ελληνικά עברית العربية',
    },
  },
  { add: { Title: 'Minimal', Password: 'only-password' } },
  {
    add: {
      Title: 'Times',
      Password: 'timed',
      'Created Time': '2024/01/02 03:04:05',
      'Password Modified Time': '2024/02/03 04:05:06',
      'Record Modified Time': '2024/03/04 05:06:07',
      'Password Expiry Date': '2030/05/06 07:08:09',
    },
    expect: {
      created: '2024-01-02T03:04:05.000Z',
      passwordModified: '2024-02-03T04:05:06.000Z',
      modified: '2024-03-04T05:06:07.000Z',
      expires: '2030-05-06T07:08:09.000Z',
    },
  },
  {
    add: { Title: 'With history', Password: 'current', History: '1030165f0a1b20004abcd' },
    expect: { hasHistory: true },
  },
  {
    add: {
      Title: 'With 2FA',
      Password: 'totp-pw',
      'Two Factor Key': 'JBSWY3DPEHPK3PXP',
      'Authentication Code Length': '8',
    },
    expect: { hasTotp: true },
  },
  {
    add: {
      Title: 'Extras',
      Password: 'extras-pw',
      'Run Command': 'echo hi',
      DCA: '3',
      Symbols: '#$',
      AutoType: '\\u\\t\\p\\n',
    },
  },
  { add: { Title: 'Protected entry', Password: 'prot-pw', Protected: '1' }, expect: { protected: true } },
  { add: { Title: 'Same title', Password: 'first', Group: 'Dup' } },
  { add: { Title: 'Same title', Password: 'second', Group: 'Dup2' } },
]

const LONG = 'Long value '.repeat(900) // 9,900 characters
const CRLF = '\r\n'

/** Entries of cli-import.psafe3, imported from XML (delimiter '^' becomes a CRLF in notes). */
const IMPORT_ENTRIES = [
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0001',
    group: 'Notes.Multi',
    title: 'Multi line',
    username: 'multi',
    password: 'ml-pw',
    notes: ['line one', 'line two', '', 'line four'].join(CRLF),
  },
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0002',
    title: 'Commas, semicolons; and ]]> end',
    password: 'a,b;c]]>d',
    username: 'x]]>y',
    url: 'https://example.com/?q=1,2;3',
    email: 'first.last+tag@example.org',
    notes: 'Contains ]]> and <tags> & ampersands' + CRLF + 'and a second line',
  },
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0003',
    title: 'Empty username element',
    password: 'no-user',
    username: '',
  },
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0004',
    group: 'Big',
    title: 'Very long notes',
    password: 'long-pw',
    notes: LONG,
  },
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0005',
    group: 'Émoji.🔒 Locked',
    title: 'Emoji and CJK 🎉 中文',
    password: '🔑🗝️ key',
    username: 'ユーザー',
    notes: ['第一行', 'second 🎈', 'naïve café'].join(CRLF),
  },
  {
    uuid: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0006',
    group: 'x\\.y.z',
    title: 'Imported literal dot',
    password: 'dot2',
  },
]

/** Entries of cli-many.psafe3: 250 generated entries in nested groups, imported from XML. */
const MANY_ENTRIES = Array.from({ length: 250 }, (_, i) => {
  const n = String(i).padStart(3, '0')
  const e = {
    uuid: `4d414e59${'0'.repeat(20)}${i.toString(16).padStart(4, '0')}`,
    group: `Many.Group ${i % 10}.Sub ${i % 3}`,
    title: `Entry ${n}`,
    password: `pw-${n}-${(i * 7919) % 10007}`,
  }
  if (i % 2 === 0) e.username = `user${n}`
  if (i % 5 === 0) e.url = `https://site${n}.example.net/`
  if (i % 7 === 0) e.notes = `Note for ${n}` + CRLF + 'second line'
  if (i % 11 === 0) e.email = `u${n}@example.net`
  return e
})

const FIXTURES = [
  { name: 'cli-add', password: 'wp8-fixture-add', kind: 'add' },
  { name: 'cli-import', password: 'wp8-fixture-import', kind: 'import', entries: IMPORT_ENTRIES },
  { name: 'cli-many', password: 'wp8-fixture-many', kind: 'import', entries: MANY_ENTRIES },
  { name: 'cli-links', password: 'wp8-fixture-links', kind: 'links' },
]

// ---------------------------------------------------------------------------------------------

function cli(dir, args, password, times = 1) {
  const res = spawnSync(CLI, args, {
    cwd: dir,
    input: `${password}\n`.repeat(times),
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC', PWS_XMLDIR: XMLDIR },
    timeout: 120_000,
  })
  if (res.status !== 0) {
    // args may hold made-up fixture values only; still, print just the flag name.
    throw new Error(`pwsafe-cli ${args[1]?.split('=')[0]} failed with status ${res.status}`)
  }
}

const cdata = (s) => `<![CDATA[${s.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

function importXml(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<passwordsafe delimiter="^" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="pwsafe.xsd">',
  ]
  entries.forEach((e, i) => {
    lines.push(`<entry id="${i + 1}">`)
    for (const k of ['group', 'title', 'username', 'password', 'url', 'notes']) {
      if (e[k] === undefined) continue
      const v = k === 'notes' ? e[k].replaceAll(CRLF, '^') : e[k]
      if (v.includes('^') && k !== 'notes') throw new Error('delimiter inside a value')
      lines.push(`<${k}>${cdata(v)}</${k}>`)
    }
    lines.push(`<uuid>${cdata(e.uuid)}</uuid>`)
    if (e.email !== undefined) lines.push(`<email>${cdata(e.email)}</email>`)
    lines.push('</entry>')
  })
  lines.push('</passwordsafe>', '')
  return lines.join('\n')
}

/** Minimal reader for the CLI's own XML export: element name -> text, per entry. */
function readCliExport(xml) {
  const entries = []
  for (const m of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)) {
    const e = {}
    for (const f of m[1].matchAll(/<(\w+)>((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/\1>/g)) {
      e[f[1]] = [...f[2].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('')
    }
    entries.push(e)
  }
  return entries
}

function exportXml(dir, file, password) {
  cli(dir, [file, `--export=${file}.xml`, '--xml'], password)
  const xml = readFileSync(join(dir, `${file}.xml`), 'utf8')
  rmSync(join(dir, `${file}.xml`))
  return readCliExport(xml)
}

const TEXT_KEYS = ['group', 'title', 'username', 'password', 'url', 'email', 'notes']

/** The expected-values record for one entry, with every text field present ('' when absent). */
function expected(e) {
  const out = { uuid: e.uuid }
  for (const k of TEXT_KEYS) out[k] = e[k] ?? ''
  for (const k of ['created', 'passwordModified', 'modified', 'expires', 'kind', 'baseUuid']) {
    if (e[k] !== undefined) out[k] = e[k]
  }
  for (const k of ['hasHistory', 'hasTotp', 'protected']) if (e[k]) out[k] = true
  return out
}

/** Checks the CLI's own export against the table (CLI exports line breaks in notes as spaces). */
function checkAgainstCli(cliEntries, want) {
  if (cliEntries.length !== want.length) {
    throw new Error(`CLI export has ${cliEntries.length} entries, expected ${want.length}`)
  }
  for (const w of want) {
    const c = cliEntries.find((x) => x.uuid === w.uuid)
    if (!c) throw new Error(`entry ${w.uuid} missing from the CLI export`)
    for (const k of TEXT_KEYS) {
      const v = k === 'notes' ? w[k].replace(/\r\n/g, ' ') : w[k]
      if ((c[k] ?? '') !== v) throw new Error(`entry ${w.uuid}: ${k} differs in the CLI export`)
    }
  }
}

const fromAdd = (a, extra = {}) => ({
  group: a.Group,
  title: a.Title,
  username: a.Username,
  password: a.Password,
  url: a.URL,
  email: a['e-mail'],
  notes: a.Notes,
  ...extra,
})

const addArg = (fields) =>
  '--add=' +
  Object.entries(fields)
    .map(([k, v]) => {
      if (/[,;]/.test(v) || v === '') throw new Error(`--add cannot carry ${k}`)
      return `${k}=${v}`
    })
    .join(',')

function makeAdd(dir, file, password) {
  cli(dir, [file, '--create'], password, 2)
  for (const e of ADD_ENTRIES) cli(dir, [file, addArg(e.add)], password)
  const exported = exportXml(dir, file, password)
  const want = ADD_ENTRIES.map((e) => {
    const x = fromAdd(e.add, e.expect)
    const match = exported.filter((c) => c.title === x.title && (c.group ?? '') === (x.group ?? ''))
    if (match.length !== 1) throw new Error(`cannot find ${x.title} in the CLI export`)
    return expected({ ...x, uuid: match[0].uuid })
  })
  checkAgainstCli(exported, want)
  return want
}

function makeImport(dir, file, password, entries) {
  cli(dir, [file, '--create'], password, 2)
  writeFileSync(join(dir, `${file}.in.xml`), importXml(entries))
  cli(dir, [file, `--import=${file}.in.xml`, '--xml'], password)
  rmSync(join(dir, `${file}.in.xml`))
  const want = entries.map(expected)
  checkAgainstCli(exportXml(dir, file, password), want)
  return want
}

/** Aliases and shortcuts. The CLI's export crashes once they exist, so bases are read first. */
function makeLinks(dir, file, password) {
  cli(dir, [file, '--create'], password, 2)
  const bases = [
    { Title: 'Alias base', Password: 'alias-base-pw', Username: 'ab', Group: 'Links' },
    { Title: 'Shortcut base', Password: 'shortcut-base-pw', Username: 'sb', Group: 'Links' },
    { Title: 'Plain', Password: 'plain-pw', Group: 'Links' },
  ]
  for (const b of bases) cli(dir, [file, addArg(b)], password)
  const exported = exportXml(dir, file, password)
  const want = bases.map((b) => {
    const c = exported.find((x) => x.title === b.Title)
    return fromAdd(b, { uuid: c.uuid })
  })
  want[0].kind = 'aliasBase'
  want[1].kind = 'shortcutBase'
  want[2].kind = 'normal'
  checkAgainstCli(exported, want.map(expected))
  const alias = { Title: 'The alias', Password: `[[${want[0].uuid}]]`, Group: 'Links' }
  const shortcut = { Title: 'The shortcut', Password: `[~${want[1].uuid}~]`, Group: 'Links' }
  cli(dir, [file, addArg(alias)], password)
  cli(dir, [file, addArg(shortcut)], password)
  // UUIDs of the alias and shortcut cannot be read back through the CLI (its export crashes and
  // --print has no UUID field), so the expected JSON leaves them out.
  return [
    ...want.map(expected),
    { ...expected(fromAdd(alias, { kind: 'alias', baseUuid: want[0].uuid })), uuid: null },
    { ...expected(fromAdd(shortcut, { kind: 'shortcut', baseUuid: want[1].uuid })), uuid: null },
  ]
}

mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'wp8-make-'))
try {
  for (const f of FIXTURES) {
    const file = `${f.name}.psafe3`
    const entries =
      f.kind === 'add'
        ? makeAdd(work, file, f.password)
        : f.kind === 'links'
          ? makeLinks(work, file, f.password)
          : makeImport(work, file, f.password, f.entries)
    const bytes = readFileSync(join(work, file))
    const json = {
      file,
      madeWith: 'pwsafe-cli, Password Safe 1.25.0 (da4460325ac41ccd798a52d9b250ef4d5c768abc)',
      password: f.password,
      formatVersion: '0x0311',
      // Stored little-endian at offset 36 (format spec §2.4); the CLI's default.
      iterations: bytes.readUInt32LE(36),
      entryCount: entries.length,
      entries,
    }
    copyFileSync(join(work, file), join(OUT, file))
    writeFileSync(join(OUT, `${f.name}.expected.json`), JSON.stringify(json, null, 2) + '\n')
    if (!process.env.MAKE_GENERATED_QUIET) console.warn(`wrote ${file} (${bytes.length} bytes)`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
