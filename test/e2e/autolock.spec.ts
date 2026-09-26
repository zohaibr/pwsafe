// §B2/§B3/§B5 and §E: auto-lock with unsaved changes writes nothing to disk, keeps the changes in
// memory (still unsaved after unlock), and clears the clipboard only if it still holds our value.
//
// Idle: the setting is set to its minimum (1 minute) through the Settings dialog, and main's
// timer is scaled so that one minute passes in 1.5 s (only delays of exactly 60 s are shortened;
// the idle timer is the only such timer). Sleep, screen lock and minimise are the real handlers
// in main, triggered by emitting the events Electron would send.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { detailValue } from './flow'
import {
  WINDOWS_READ_ONLY,
  acquireClipboard,
  clipboardHolds,
  editField,
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
  expectUnchanged,
  status,
  unlock,
  type Setup,
} from './helpers'

const EXPECTED = loadExpected('cli-add')
const MASTER = EXPECTED.password
const TARGET = EXPECTED.entries.find((e) => e.title === 'Times')!
const EDITED_USERNAME = 'wp9-autolock-user'
const FOREIGN_CLIPBOARD = 'copied-by-another-app'

let setup: Setup | undefined
test.beforeEach(async () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  await acquireClipboard()
  setup = makeSetup('cli-add')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

/**
 * Records, in main, each clipboard write the app makes from now on ('' for a clear, 'value'
 * otherwise; the value itself is never kept), so "left alone" is checked on what the app did.
 */
async function spyOnClipboardWrites(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as { __wp9ClipWrites?: string[] }
    g.__wp9ClipWrites = []
    const original = clipboard.writeText.bind(clipboard)
    clipboard.writeText = ((text: string) => {
      g.__wp9ClipWrites!.push(text === '' ? '' : 'value')
      return original(text)
    }) as typeof clipboard.writeText
  })
}

const clipboardWrites = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __wp9ClipWrites?: string[] }).__wp9ClipWrites ?? ['missing'])

/** One idle minute in main takes 1.5 s from now on. */
async function shortenIdleMinute(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as { setTimeout: typeof setTimeout; __wp9Scaled?: boolean }
    if (g.__wp9Scaled) return
    g.__wp9Scaled = true
    const original = g.setTimeout
    g.setTimeout = ((fn: () => void, ms?: number) =>
      original(fn, ms === 60_000 ? 1_500 : ms)) as typeof setTimeout
  })
}

async function setSettings(
  page: Page,
  opts: { idleMinutes?: number; lockOnMinimize?: boolean },
): Promise<void> {
  await openFileMenu(page, 'Settings…')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (opts.idleMinutes !== undefined) {
    await dialog.getByLabel('Lock after being idle for').fill(String(opts.idleMinutes))
  }
  if (opts.lockOnMinimize !== undefined) {
    await dialog.getByLabel('Lock when the window is minimised').setChecked(opts.lockOnMinimize)
  }
  await dialog.getByRole('button', { name: 'Save settings' }).click()
  await expect(dialog).toHaveCount(0)
}

/** Edits the target entry (1 unsaved change) and copies its password. */
async function editAndCopy(app: ElectronApplication, page: Page): Promise<void> {
  await selectEntry(page, TARGET.title)
  await editField(page, 'username', EDITED_USERNAME)
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')
  await page.getByRole('button', { name: 'Copy password' }).click()
  await expect.poll(() => clipboardHolds(app, TARGET.password)).toBe(true)
}

/** After an auto-lock: nothing written, then unlock brings the unsaved change back. */
async function expectChangesKept(page: Page, s: Setup, before: ReturnType<typeof snapshot>) {
  await expect(page.getByLabel('Master password')).toBeVisible()
  expectUnchanged(s.db, before)
  // Only the lock file is next to the database: no backup, staged, journal or temp file.
  expect(siblings(s)).toEqual(['vault.plk', 'vault.psafe3'])
  await unlock(page, MASTER)
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')
  await selectEntry(page, TARGET.title)
  expect(await detailValue(page, 'Username')).toBe(EDITED_USERNAME)
  expectUnchanged(s.db, before)
}

async function quitWithoutSaving(app: ElectronApplication, page: Page): Promise<void> {
  const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
  await app.evaluate(({ app: a }) => a.quit())
  await page
    .getByRole('button', { name: "Don't save" })
    .click()
    .catch(() => {})
  await exited
}

test('idle auto-lock with unsaved changes writes nothing and keeps the changes', async () => {
  const s = setup!
  const before = snapshot(s.db)
  const app = await launch(s)
  const page = await openAndUnlock(app, MASTER)
  await editAndCopy(app, page)
  await shortenIdleMinute(app)
  await spyOnClipboardWrites(app)
  await setSettings(page, { idleMinutes: 1 })

  // No input from here on: the idle timer fires.
  await expect(status(page)).toHaveText('Status: locked', { timeout: 15_000 })
  // Our value was still on the clipboard, so it is cleared (§B5).
  await expect.poll(() => clipboardWrites(app)).toEqual([''])
  expect(await clipboardHolds(app, TARGET.password)).toBe(false)
  await expectChangesKept(page, s, before)
  await quitWithoutSaving(app, page)
  expectUnchanged(s.db, before)
})

test('screen lock and sleep auto-lock keep the changes and leave a foreign clipboard alone', async () => {
  const s = setup!
  const before = snapshot(s.db)
  const app = await launch(s)
  const page = await openAndUnlock(app, MASTER)
  await editAndCopy(app, page)
  // Another app copies something after us: lock must not clear it.
  await app.evaluate(({ clipboard }, v) => clipboard.writeText(v), FOREIGN_CLIPBOARD)
  await spyOnClipboardWrites(app)

  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
  await expect(status(page)).toHaveText('Status: locked')
  await expectChangesKept(page, s, before)

  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
  await expect(status(page)).toHaveText('Status: locked')
  await expectChangesKept(page, s, before)
  // The app never touched the clipboard: the other app's value was left alone.
  expect(await clipboardWrites(app)).toEqual([])
  await quitWithoutSaving(app, page)
  expectUnchanged(s.db, before)
})

test('minimise locks only when the setting is on, and keeps the changes', async () => {
  const s = setup!
  const before = snapshot(s.db)
  const app = await launch(s)
  const page = await openAndUnlock(app, MASTER)
  await editAndCopy(app, page)
  const minimise = () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.emit('minimize')
    })

  // Default: off.
  await minimise()
  await page.waitForTimeout(300)
  await expect(status(page)).toHaveText('Status: open')

  await setSettings(page, { lockOnMinimize: true })
  await minimise()
  await expect(status(page)).toHaveText('Status: locked')
  await expectChangesKept(page, s, before)
  await quitWithoutSaving(app, page)
  expectUnchanged(s.db, before)
})
