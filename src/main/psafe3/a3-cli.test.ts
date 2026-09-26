// §A3 table checked row by row against files made at test time by the pinned pwsafe-cli 1.25.0
// (docs/references.md). Runs only when PWSAFE_CLI is set; nothing generated here is committed.
// Rows the CLI cannot produce (attachments, passkeys, credit cards, custom fields, unknown 0xdf,
// records missing mandatory fields, duplicates, invalid UTF-8) are covered in views.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasOracle, runCli } from '../../../test/oracle/pwsafeCli'
import { createTwofish } from '../crypto/twofish/twofish'
import type { Result } from '../../shared/errors'
import type { Entry } from '../../shared/types'
import { FieldType } from '../../shared/types'
import { decode, encode, type DecodedVault } from './codec'
import { stampHeaderForSave } from './header'
import { syncStretch } from './testing/files'
import { applyDraft, buildEntries, indexRecords, resolvePassword } from './views'

const PASS = 'a3-oracle-pass'
const password = new TextEncoder().encode(PASS)
const deps = { cipherFactory: createTwofish, stretch: syncStretch }

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.detail ?? ''}`)
  return r.value
}

describe.skipIf(!hasOracle)('§A3 against pwsafe-cli 1.25.0 files', () => {
  let dir = ''
  const cli = (args: string[], stdin: string[] = [PASS]) => {
    const run = runCli(args, stdin, dir)
    expect(run.status, run.stderr).toBe(0)
  }
  const add = (file: string, fields: string) => cli([file, `--add=${fields}`])
  const open = async (file: string): Promise<DecodedVault> =>
    unwrap(await decode(new Uint8Array(readFileSync(join(dir, file))), password, deps))
  const byTitle = (entries: Entry[], title: string) => {
    const e = entries.find((x) => x.title === title)
    expect(e, title).toBeDefined()
    return e!
  }

  let main: DecodedVault
  let mainEntries: Entry[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wp2-a3-'))
    cli(['main.psafe3', '--create'], [PASS, PASS])
    add(
      'main.psafe3',
      'Title=Example,Username=jordan,Password=p&<>"q,Group=Banking.Online,URL=https://bank.example.com,e-mail=j@example.com,Notes=line one',
    )
    add(
      'main.psafe3',
      'Title=Times,Password=x,Created Time=2024/01/02 03:04:05,Password Modified Time=2024/02/03 04:05:06,Record Modified Time=2024/03/04 05:06:07,Password Expiry Date=2030/05/06 07:08:09',
    )
    add('main.psafe3', 'Title=Hist,Password=x,History=1030165f0a1b20004abcd')
    add(
      'main.psafe3',
      'Title=Totp,Password=x,Two Factor Key=JBSWY3DPEHPK3PXP,Authentication Code Length=8',
    )
    add('main.psafe3', 'Title=Prot,Password=x,Protected=1')
    add(
      'main.psafe3',
      'Title=Misc,Password=x,Run Command=echo hi,DCA=3,Symbols=#$,AutoType=\\u\\t\\p',
    )
    main = await open('main.psafe3')
    mainEntries = buildEntries(main.records)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('a new CLI safe is format 0x0311', () => {
    expect(main.meta.formatVersion).toBe(0x0311)
    expect(main.meta.readOnlyReason).toBeUndefined()
    expect(mainEntries).toHaveLength(6)
  })

  it('row 1: the main fields are shown with the values the CLI stored, and editable', () => {
    const e = byTitle(mainEntries, 'Example')
    expect(e).toMatchObject({
      username: 'jordan',
      group: 'Banking.Online',
      url: 'https://bank.example.com',
      email: 'j@example.com',
      notes: 'line one',
      kind: 'normal',
      editable: true,
      password: '',
    })
    expect(e.uuid).toMatch(/^[0-9a-f]{32}$/)
    const rec = main.records[mainEntries.indexOf(e)]!
    expect(resolvePassword(rec, indexRecords(main.records))).toBe('p&<>"q')
  })

  it('row 2: times are shown', () => {
    const e = byTitle(mainEntries, 'Times')
    expect(e.created).toBe('2024-01-02T03:04:05.000Z')
    expect(e.passwordModified).toBe('2024-02-03T04:05:06.000Z')
    expect(e.modified).toBe('2024-03-04T05:06:07.000Z')
    expect(e.expires).toBe('2030-05-06T07:08:09.000Z')
  })

  it('row 3: history is flagged', () => {
    expect(byTitle(mainEntries, 'Hist').flags.hasHistory).toBe(true)
    expect(byTitle(mainEntries, 'Example').flags.hasHistory).toBe(false)
  })

  it('row 4: 2FA is flagged and the record stays editable', () => {
    const e = byTitle(mainEntries, 'Totp')
    expect(e.flags.hasTotp).toBe(true)
    expect(e.flags.extraFieldCount).toBeGreaterThanOrEqual(2)
    expect(e.editable).toBe(true)
  })

  it('row 6: protected is read-only; run command, DCA, symbols, autotype are extra and editable', () => {
    const p = byTitle(mainEntries, 'Prot')
    expect(p.editable).toBe(false)
    expect(p.readOnlyReason).toMatch(/protected/)
    const m = byTitle(mainEntries, 'Misc')
    expect(m.editable).toBe(true)
    expect(m.flags.extraFieldCount).toBeGreaterThanOrEqual(4)
  })

  it('row 9: aliases and shortcuts made with the CLI', async () => {
    cli(['links.psafe3', '--create'], [PASS, PASS])
    add('links.psafe3', 'Title=Base,Password=basepw')
    add('links.psafe3', 'Title=Base2,Password=base2pw')
    const bases = buildEntries((await open('links.psafe3')).records)
    const b1 = byTitle(bases, 'Base').uuid
    const b2 = byTitle(bases, 'Base2').uuid
    add('links.psafe3', `Title=Alias,Password=[[${b1}]]`)
    add('links.psafe3', `Title=Short,Password=[~${b2}~]`)
    const v = await open('links.psafe3')
    const entries = buildEntries(v.records)
    const index = indexRecords(v.records)
    expect(byTitle(entries, 'Alias')).toMatchObject({
      kind: 'alias',
      baseUuid: b1,
      editable: false,
    })
    expect(byTitle(entries, 'Short')).toMatchObject({
      kind: 'shortcut',
      baseUuid: b2,
      editable: false,
    })
    expect(byTitle(entries, 'Base')).toMatchObject({ kind: 'aliasBase', editable: true })
    expect(byTitle(entries, 'Base2')).toMatchObject({ kind: 'shortcutBase', editable: true })
    const aliasRec = v.records[entries.indexOf(byTitle(entries, 'Alias'))]!
    expect(resolvePassword(aliasRec, index)).toBe('basepw')
  })

  it('an edit written by us is read back by the CLI with every other value intact', async () => {
    const index = indexRecords(main.records)
    const i = mainEntries.indexOf(byTitle(mainEntries, 'Example'))
    const edited = unwrap(
      applyDraft(main.records[i]!, { title: 'Example edited', password: 'n3w' }, index, {
        now: 1_800_000_000,
      }),
    )
    const records = main.records.slice()
    records[i] = edited
    const header = stampHeaderForSave(main.header, {
      now: 1_800_000_000,
      application: 'psafe3 Opener V0.1.0',
    })
    const bytes = unwrap(
      await encode({ header, records }, password, deps, { iterations: main.meta.iterations }),
    )
    writeFileSync(join(dir, 'ours.psafe3'), bytes)
    cli(['ours.psafe3', '--export=ours.xml', '--xml'])
    cli(['main.psafe3', '--export=main.xml', '--xml'])
    const ours = readFileSync(join(dir, 'ours.xml'), 'utf8')
    const theirs = readFileSync(join(dir, 'main.xml'), 'utf8')
    expect(ours).toContain('<title><![CDATA[Example edited]]></title>')
    expect(ours).toContain('<password><![CDATA[n3w]]></password>')
    // Everything except the edited entry is identical in the CLI's own export.
    const entryBlocks = (xml: string) => xml.match(/<entry[\s\S]*?<\/entry>/g) ?? []
    const oursBlocks = entryBlocks(ours)
    const theirBlocks = entryBlocks(theirs)
    expect(oursBlocks).toHaveLength(theirBlocks.length)
    let differing = 0
    for (let k = 0; k < theirBlocks.length; k++) if (oursBlocks[k] !== theirBlocks[k]) differing++
    expect(differing).toBe(1)
    // Fields of the edited entry that we did not touch are still there.
    const editedBlock = oursBlocks.find((b) => b.includes('Example edited'))!
    for (const s of [
      'jordan',
      'Banking.Online',
      'https://bank.example.com',
      'j@example.com',
      'line one',
    ]) {
      expect(editedBlock).toContain(s)
    }
    expect(edited.fields.some((f) => f.type === FieldType.LAST_MOD_TIME)).toBe(true)
  })
})
