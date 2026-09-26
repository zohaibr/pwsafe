// The WP9 user journey (docs/execution-plan.md §D WP9), shared by full-flow.spec.ts (the functional
// checks) and network.spec.ts (the same journey under the §E blocked-network recorders):
//   unlock → search → copy → add → edit → delete → save → reopen → export → Save As → restore
// Values are checked in the UI after reopening AND on disk with our own codec.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  chooseFile,
  clipboardHolds,
  decodeFile,
  editField,
  entryList,
  expectUnchanged,
  loadExpected,
  openFileMenu,
  saveAndWait,
  selectEntry,
  setDialogPaths,
  snapshot,
  unlock,
  type Setup,
} from './helpers'

const EXPECTED = loadExpected('cli-add')
const MASTER = EXPECTED.password
const ORIGINAL_COUNT = EXPECTED.entries.length

const ADDED = {
  title: 'WP9 added entry',
  group: 'WP9.Flow',
  username: 'wp9-user',
  password: 'wp9-added-Pw!42',
  url: 'https://wp9.example.test/',
  email: 'wp9@example.test',
  notes: 'Added by the WP9 end-to-end flow',
}
const EDITED = { title: 'Nested', username: 'wp9-edited-user' }
const DELETED = 'Minimal'
const COPIED = EXPECTED.entries.find((e) => e.title === 'Example Bank')!
const AFTER_SAVE_AS_EDIT = 'wp9-after-save-as'

/** Files the journey leaves next to the database (after quit, so no .plk). */
export const FLOW_FILES = [
  'copy.psafe3',
  'copy.psafe3.bak',
  'copy.psafe3.bak2',
  'export.xml',
  'vault.psafe3',
  'vault.psafe3.bak',
]

/** The value shown in the details pane for a field label. */
export async function detailValue(page: Page, label: string): Promise<string> {
  const row = page
    .locator('.detail .field-row')
    .filter({ has: page.getByText(label, { exact: true }) })
  return (await row.locator('.value').first().innerText()).trim()
}

/** Runs the whole journey on `s` (a copy of cli-add) in a freshly launched app. */
export async function runFullFlow(app: ElectronApplication, s: Setup): Promise<void> {
  const exportPath = join(s.dir, 'export.xml')
  const saveAsPath = join(s.dir, 'copy.psafe3')
  const original = snapshot(s.db)

  const page = await app.firstWindow()
  await chooseFile(page)
  await unlock(page, MASTER)
  await expect(entryList(page).getByRole('option')).toHaveCount(ORIGINAL_COUNT)

  // ── Search ────────────────────────────────────────────────────────────
  const search = page.getByLabel('Search entries')
  await search.fill('bank')
  await expect(entryList(page).getByRole('option')).toHaveCount(1)
  await expect(entryList(page).getByRole('option').first()).toContainText(COPIED.title)

  // ── Copy (happens in main; the value lands on the clipboard) ──────────
  await selectEntry(page, COPIED.title)
  await page.getByRole('button', { name: 'Copy password' }).click()
  await expect.poll(() => clipboardHolds(app, COPIED.password)).toBe(true)
  await search.fill('')
  await expect(entryList(page).getByRole('option')).toHaveCount(ORIGINAL_COUNT)

  // ── Add ───────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'New entry' }).click()
  await page.locator('#edit-title').fill(ADDED.title)
  await page.locator('#edit-group').fill(ADDED.group)
  await page.locator('#edit-username').fill(ADDED.username)
  await page.locator('#edit-password').fill(ADDED.password)
  await page.locator('#edit-url').fill(ADDED.url)
  await page.locator('#edit-email').fill(ADDED.email)
  await page.locator('#edit-notes').fill(ADDED.notes)
  await page.getByRole('button', { name: 'Add entry' }).click()
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')

  // ── Edit ──────────────────────────────────────────────────────────────
  await selectEntry(page, EDITED.title)
  await editField(page, 'username', EDITED.username)
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (2)')

  // ── Delete ────────────────────────────────────────────────────────────
  await selectEntry(page, DELETED)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const del = page.getByRole('alertdialog', { name: `Delete “${DELETED}”?` })
  await expect(del).toContainText('previous 3 versions as backups')
  await del.getByRole('button', { name: 'Delete entry' }).click()
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (3)')
  await expect(entryList(page).getByRole('option')).toHaveCount(ORIGINAL_COUNT)

  // Nothing is on disk until Save.
  expectUnchanged(s.db, original)

  // ── Save ──────────────────────────────────────────────────────────────
  await saveAndWait(page)
  expect(readFileSync(`${s.db}.bak`).equals(original.bytes)).toBe(true)

  // ── Reopen: close the file, open it again, check the values in the UI ─
  await openFileMenu(page, 'Close file')
  await chooseFile(page)
  await unlock(page, MASTER)
  await expect(entryList(page).getByRole('option')).toHaveCount(ORIGINAL_COUNT)
  await expect(
    entryList(page).getByRole('option', { name: new RegExp(`^${DELETED}`) }),
  ).toHaveCount(0)
  await selectEntry(page, EDITED.title)
  expect(await detailValue(page, 'Username')).toBe(EDITED.username)
  await selectEntry(page, ADDED.title)
  expect(await detailValue(page, 'Username')).toBe(ADDED.username)
  expect(await detailValue(page, 'Email')).toBe(ADDED.email)
  expect(await detailValue(page, 'Notes')).toBe(ADDED.notes)
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(page.getByTestId('password-value')).toHaveText(ADDED.password)
  await page.getByRole('button', { name: 'Hide password' }).click()

  // ...and on disk with our codec.
  const onDisk = await decodeFile(s.db, MASTER)
  expect(onDisk).toHaveLength(ORIGINAL_COUNT)
  const added = onDisk.find((e) => e.title === ADDED.title)
  expect(added).toMatchObject({
    group: ADDED.group,
    username: ADDED.username,
    password: ADDED.password,
    url: ADDED.url,
    email: ADDED.email,
    notes: ADDED.notes,
  })
  expect(onDisk.find((e) => e.title === DELETED)).toBeUndefined()
  expect(onDisk.find((e) => e.title === EDITED.title)?.username).toBe(EDITED.username)
  // Every other entry is exactly as the fixture says.
  for (const exp of EXPECTED.entries) {
    if (exp.title === DELETED || exp.title === EDITED.title) continue
    const got = onDisk.find((e) => e.uuid === exp.uuid)
    expect(got, exp.title).toMatchObject({
      title: exp.title,
      group: exp.group,
      username: exp.username,
      password: exp.password,
      url: exp.url,
      email: exp.email,
      notes: exp.notes,
    })
  }
  const afterSave = snapshot(s.db)

  // ── Export: warning shown, checkbox required, file 0600 ───────────────
  await setDialogPaths(app, { export: exportPath })
  await openFileMenu(page, 'Export XML…')
  await expect(page.getByText('The exported file is not encrypted')).toBeVisible()
  const exportButton = page.getByRole('button', { name: 'Export…' })
  await expect(exportButton).toBeDisabled()
  await page.getByRole('checkbox', { name: /I understand/ }).check()
  await exportButton.click()
  await expect(page.getByText(`Exported ${ORIGINAL_COUNT} entries`)).toBeVisible()
  expect(existsSync(exportPath)).toBe(true)
  if (process.platform !== 'win32') expect(statSync(exportPath).mode & 0o777).toBe(0o600)
  const xml = readFileSync(exportPath, 'utf8')
  expect(xml).toContain(ADDED.title)
  expect(xml).toContain(EDITED.username)
  expect(xml.includes(`<title><![CDATA[${DELETED}]]></title>`)).toBe(false)

  // ── Save As: the copy becomes the active file, the original is left alone
  await setDialogPaths(app, { saveAs: saveAsPath })
  await openFileMenu(page, 'Save As…')
  await expect(page.getByText('Saved as copy.psafe3')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('h1.file-name')).toHaveText('copy.psafe3')
  expect(existsSync(join(s.dir, 'copy.plk'))).toBe(true)
  expect(existsSync(join(s.dir, 'vault.plk'))).toBe(false)
  expectUnchanged(s.db, afterSave)
  const copy = await decodeFile(saveAsPath, MASTER)
  expect(copy.map((e) => e.uuid).sort()).toEqual(onDisk.map((e) => e.uuid).sort())
  expect(copy.find((e) => e.title === ADDED.title)?.password).toBe(ADDED.password)

  // ── Restore from backup: change the copy, save, then restore the .bak ──
  await selectEntry(page, EDITED.title)
  await editField(page, 'username', AFTER_SAVE_AS_EDIT)
  await saveAndWait(page)
  expect(
    (await decodeFile(saveAsPath, MASTER)).find((e) => e.title === EDITED.title)?.username,
  ).toBe(AFTER_SAVE_AS_EDIT)
  await openFileMenu(page, 'Restore from backup…')
  const restore = page.getByRole('dialog', { name: 'Restore from backup' })
  await expect(restore.getByRole('radio')).toHaveCount(1)
  await restore.getByLabel('Master password of this backup').fill(MASTER)
  await restore.getByRole('button', { name: 'Preview' }).click()
  await expect(restore.getByText(`(${ORIGINAL_COUNT} entries)`)).toBeVisible({ timeout: 30_000 })
  await expect(restore.getByRole('cell', { name: EDITED.username })).toBeVisible()
  await restore.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.getByText('Restored the backup.')).toBeVisible({ timeout: 30_000 })
  // Restore clears the selection. Clicking an entry in a scrolled list right now hits a known app
  // bug (app-bugs.spec.ts: the list selects and scrolls to its first entry on mouse-down, so the
  // click lands elsewhere), so narrow the list with search first; the bug has its own test.
  await page.getByLabel('Search entries').fill(EDITED.title)
  await selectEntry(page, EDITED.title)
  expect(await detailValue(page, 'Username')).toBe(EDITED.username)
  // On disk: the file is the restored version; what it replaced is now the newest backup.
  const restored = await decodeFile(saveAsPath, MASTER)
  expect(restored.find((e) => e.title === EDITED.title)?.username).toBe(EDITED.username)
  const bak = await decodeFile(`${saveAsPath}.bak`, MASTER)
  expect(bak.find((e) => e.title === EDITED.title)?.username).toBe(AFTER_SAVE_AS_EDIT)
  expect(existsSync(`${saveAsPath}.bak2`)).toBe(true)
}
