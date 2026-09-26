// §A6 and §E (Windows): v1 opens every vault read-only on Windows. The UI says why and disables
// editing, and no write path is reachable even when called directly through the preload API:
// save, saveEntry (edit and add), deleteEntry, Save As and restore are all refused with READ_ONLY,
// no .plk is created, and the file and its backup are byte-for-byte unchanged.
// Runs only on Windows (the Windows CI job); browse, copy and export still work there.
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  acquireClipboard,
  clipboardHolds,
  entryList,
  expectUnchanged,
  isWindows,
  launch,
  loadExpected,
  makeSetup,
  openAndUnlock,
  openFileMenu,
  removeSetup,
  selectEntry,
  siblings,
  snapshot,
  type Setup,
} from './helpers'

const EXPECTED = loadExpected('cli-add')
const MASTER = EXPECTED.password

let setup: Setup | undefined
test.beforeEach(() => {
  setup = makeSetup('cli-add')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

/** The preload API as the renderer sees it (this file is type-checked without the DOM lib). */
interface Api {
  save(): Promise<{ ok: boolean; error?: { code: string } }>
  saveAs(): Promise<{ ok: boolean; error?: { code: string } }>
  saveEntry(d: Record<string, string>): Promise<{ ok: boolean; error?: { code: string } }>
  deleteEntry(uuid: string): Promise<{ ok: boolean; error?: { code: string } }>
  listBackups(): Promise<{ ok: boolean; value?: { id: string }[] }>
  restoreBackup(id: string): Promise<{ ok: boolean; error?: { code: string } }>
}

test('Windows opens the vault read-only and refuses every write path', async () => {
  test.skip(!isWindows, 'Windows only (§A6: v1 is read-only on Windows)')
  await acquireClipboard()
  const s = setup!
  const backup = `${s.db}.bak`
  copyFileSync(s.db, backup)
  const saveAsPath = join(s.dir, 'copy.psafe3')
  const exportPath = join(s.dir, 'export.xml')
  const before = snapshot(s.db)
  const beforeBak = snapshot(backup)

  const app = await launch(s, { PSAFE_E2E_SAVE_AS: saveAsPath, PSAFE_E2E_EXPORT: exportPath })
  const page = await openAndUnlock(app, MASTER)

  // The UI: banner with the reason, editing controls disabled.
  await expect(page.getByTestId('readonly-banner')).toBeVisible()
  await expect(page.getByTestId('readonly-banner')).toContainText('Read-only.')
  await expect(page.getByRole('button', { name: 'New entry' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const entry = EXPECTED.entries.find((e) => e.title === 'Example Bank')!
  await selectEntry(page, entry.title)
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()

  // Browse and copy still work.
  await expect(entryList(page).getByRole('option')).toHaveCount(EXPECTED.entries.length)
  await page.getByRole('button', { name: 'Copy password' }).click()
  await expect.poll(() => clipboardHolds(app, entry.password)).toBe(true)

  // Every write path, called directly, is refused.
  const codes = await page.evaluate(async (uuid) => {
    const api = (globalThis as unknown as { psafe: Api }).psafe
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'OK' : r.error!.code)
    const backups = await api.listBackups()
    const id = backups.value?.[0]?.id
    return {
      backupListed: id !== undefined,
      save: code(await api.save()),
      edit: code(await api.saveEntry({ uuid, username: 'windows-edit' })),
      add: code(await api.saveEntry({ title: 'windows-add', password: 'windows-add-pw' })),
      delete: code(await api.deleteEntry(uuid)),
      saveAs: code(await api.saveAs()),
      restore: id === undefined ? 'NO_BACKUP' : code(await api.restoreBackup(id)),
    }
  }, entry.uuid!)
  expect(codes).toEqual({
    backupListed: true,
    save: 'READ_ONLY',
    edit: 'READ_ONLY',
    add: 'READ_ONLY',
    delete: 'READ_ONLY',
    saveAs: 'READ_ONLY',
    restore: 'READ_ONLY',
  })
  await expect(page.getByTestId('dirty-count')).toHaveCount(0)

  // Export is allowed in read-only mode.
  await openFileMenu(page, 'Export XML…')
  await page.getByRole('checkbox', { name: /I understand/ }).check()
  await page.getByRole('button', { name: 'Export…' }).click()
  await expect.poll(() => existsSync(exportPath)).toBe(true)
  expect(statSync(exportPath).size).toBeGreaterThan(0)

  await app.close()
  expectUnchanged(s.db, before)
  expectUnchanged(backup, beforeBak)
  expect(existsSync(saveAsPath)).toBe(false)
  expect(siblings(s)).toEqual(['export.xml', 'vault.psafe3', 'vault.psafe3.bak'])
})
