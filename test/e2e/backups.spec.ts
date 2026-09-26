// §A5 retention and §E: after several saves exactly three backup generations exist (.bak newest,
// .bak3 oldest), each an encrypted copy of the file as it was before the matching save, and no
// staged, journal or temp file is left behind.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  WINDOWS_READ_ONLY,
  decodeFile,
  editField,
  isWindows,
  launch,
  loadExpected,
  makeSetup,
  openAndUnlock,
  removeSetup,
  saveAndWait,
  selectEntry,
  siblings,
  type Setup,
} from './helpers'

const EXPECTED = loadExpected('cli-add')
const MASTER = EXPECTED.password
const TITLE = 'Nested'
const ORIGINAL_USERNAME = EXPECTED.entries.find((e) => e.title === TITLE)!.username

let setup: Setup | undefined
test.beforeEach(() => {
  setup = makeSetup('cli-add')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

test('three backup generations rotate over four saves', async () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  test.setTimeout(120_000)
  const s = setup!
  const original = readFileSync(s.db)
  const app = await launch(s)
  const page = await openAndUnlock(app, MASTER)

  // Save n writes username "gen-n"; before it, the file held "gen-(n-1)" (gen-0 = the fixture).
  for (let n = 1; n <= 4; n++) {
    await selectEntry(page, TITLE)
    await editField(page, 'username', `gen-${n}`)
    await saveAndWait(page)
  }
  await app.close()

  const usernameIn = async (path: string) =>
    (await decodeFile(path, MASTER)).find((e) => e.title === TITLE)?.username
  expect(await usernameIn(s.db)).toBe('gen-4')
  expect(await usernameIn(`${s.db}.bak`)).toBe('gen-3')
  expect(await usernameIn(`${s.db}.bak2`)).toBe('gen-2')
  expect(await usernameIn(`${s.db}.bak3`)).toBe('gen-1')
  // The fixture itself (gen-0) has rotated out after the fourth save.
  expect(ORIGINAL_USERNAME).not.toBe('gen-1')
  for (const g of ['.bak', '.bak2', '.bak3']) {
    expect(readFileSync(`${s.db}${g}`).equals(original)).toBe(false)
  }
  expect(siblings(s)).toEqual([
    'vault.psafe3',
    'vault.psafe3.bak',
    'vault.psafe3.bak2',
    'vault.psafe3.bak3',
  ])
})
