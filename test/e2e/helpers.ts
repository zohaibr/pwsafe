// Shared plumbing for the WP9 end-to-end flows (docs/execution-plan.md §D WP9, §E).
//
// Every test works on a COPY of a committed fixture in its own temp folder, drives the real built
// app (out/main/index.js) in the test mode of src/main/ipc/testMode.ts, and reads results back with
// our own codec. Secrets are never printed: assertions compare values or booleans, and failures
// only name titles, counts and error codes.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createTwofish } from '../../src/main/crypto/twofish/twofish'
import { decode } from '../../src/main/psafe3/codec'
import { stretchKeySync } from '../../src/main/psafe3/stretch'
import { buildEntries } from '../../src/main/psafe3/views'
import type { Entry } from '../../src/shared/types'

export const isWindows = process.platform === 'win32'
export const WINDOWS_READ_ONLY = 'v1 opens every vault read-only on Windows (§A6)'

export interface ExpectedEntry {
  uuid: string | null
  group: string
  title: string
  username: string
  password: string
  url: string
  email: string
  notes: string
}

export interface Expected {
  password: string
  entryCount: number
  entries: ExpectedEntry[]
}

export type FixtureName = 'cli-add' | 'cli-import' | 'cli-links' | 'cli-many'

export function fixturePath(name: FixtureName): string {
  return resolve(`test/fixtures/generated/${name}.psafe3`)
}

export function loadExpected(name: FixtureName): Expected {
  return JSON.parse(
    readFileSync(resolve(`test/fixtures/generated/${name}.expected.json`), 'utf8'),
  ) as Expected
}

export interface Setup {
  dir: string
  db: string
  userData: string
}

/** A fresh temp folder with a copy of the fixture as `vault.psafe3`. */
export function makeSetup(name: FixtureName = 'cli-add'): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'psafe-wp9-e2e-'))
  const db = join(dir, 'vault.psafe3')
  copyFileSync(fixturePath(name), db)
  return { dir, db, userData: join(dir, 'user-data') }
}

export function removeSetup(s: Setup | undefined): void {
  killLaunched()
  releaseClipboard()
  if (s) rmSync(s.dir, { recursive: true, force: true })
}

/** Files next to the database, excluding the app's user-data folder. */
export function siblings(s: Setup): string[] {
  return readdirSync(s.dir)
    .filter((f) => f !== 'user-data')
    .sort()
}

const launched: ElectronApplication[] = []

/**
 * Kills any app a test launched and did not close (a failed test can leave one waiting on a
 * "Save changes?" dialog, which would stall the worker). Call from afterEach.
 */
export function killLaunched(): void {
  for (const app of launched.splice(0)) {
    try {
      const proc = app.process()
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    } catch {
      // Already closed: Playwright has let go of the process.
    }
  }
}

export async function launch(
  s: Setup,
  extra: Record<string, string> = {},
  args: string[] = [],
): Promise<ElectronApplication> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  const app = await electron.launch({
    args: [resolve('out/main/index.js'), ...(process.env['CI'] ? ['--no-sandbox'] : []), ...args],
    env: {
      ...env,
      PSAFE_E2E: '1',
      PSAFE_E2E_USER_DATA: s.userData,
      PSAFE_E2E_OPEN: s.db,
      ...extra,
    },
  })
  launched.push(app)
  return app
}

/** Points the stubbed native dialogs at new paths (read by main when the dialog would open). */
export async function setDialogPaths(
  app: ElectronApplication,
  paths: { open?: string; saveAs?: string; export?: string },
): Promise<void> {
  await app.evaluate((_electron, p) => {
    if (p.open !== undefined) process.env['PSAFE_E2E_OPEN'] = p.open
    if (p.saveAs !== undefined) process.env['PSAFE_E2E_SAVE_AS'] = p.saveAs
    if (p.export !== undefined) process.env['PSAFE_E2E_EXPORT'] = p.export
  }, paths)
}

export const status = (page: Page) => page.getByTestId('status')

/** Start screen → Open a file… (stubbed dialog) → locked screen. */
export async function chooseFile(page: Page): Promise<void> {
  await expect(status(page)).toHaveText('Status: no-file')
  await page.getByRole('button', { name: /Open a file/ }).click()
}

export async function unlock(page: Page, password: string): Promise<void> {
  await expect(status(page)).toHaveText('Status: locked')
  await page.getByLabel('Master password').fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(status(page)).toHaveText('Status: open', { timeout: 30_000 })
}

export async function openAndUnlock(app: ElectronApplication, password: string): Promise<Page> {
  const page = await app.firstWindow()
  await chooseFile(page)
  await unlock(page, password)
  return page
}

export const entryList = (page: Page) => page.getByRole('listbox')

/** Selects the entry whose accessible name starts with `title`. */
export async function selectEntry(page: Page, title: string): Promise<void> {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await entryList(page)
    .getByRole('option', { name: new RegExp(`^${escaped}`) })
    .click()
  await expect(page.locator('#detail-title')).toHaveText(title)
}

export async function openFileMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByText(item, { exact: true }).click()
}

export async function saveAndWait(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('dirty-count')).toHaveCount(0, { timeout: 30_000 })
}

/** Edits one text field of the selected entry through the editor and waits for the dirty badge. */
export async function editField(
  page: Page,
  field: 'username' | 'url' | 'email' | 'notes' | 'title' | 'group',
  value: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator(`#edit-${field}`).fill(value)
  await page.getByRole('button', { name: 'Save entry' }).click()
  await expect(page.locator('#editor-title')).toHaveCount(0)
}

/** Decodes a file on disk with our codec and returns its entries (throws with the code only). */
export async function decodeFile(path: string, password: string): Promise<Entry[]> {
  const bytes = new Uint8Array(readFileSync(path))
  const r = await decode(bytes, new TextEncoder().encode(password), {
    cipherFactory: createTwofish,
    stretch: async (p, salt, it) => stretchKeySync(p, salt, it),
  })
  if (!r.ok) throw new Error(`decode failed: ${r.error.code}`)
  return buildEntries(r.value.records, { includePassword: true })
}

export interface Snapshot {
  bytes: Buffer
  mtimeMs: number
  size: number
}

export function snapshot(path: string): Snapshot {
  const st: Stats = statSync(path)
  return { bytes: readFileSync(path), mtimeMs: st.mtimeMs, size: st.size }
}

/** The file's bytes and modification time are exactly as in `before`. */
export function expectUnchanged(path: string, before: Snapshot): void {
  const now = snapshot(path)
  expect(now.size).toBe(before.size)
  expect(now.mtimeMs).toBe(before.mtimeMs)
  expect(now.bytes.equals(before.bytes)).toBe(true)
}

/** Whether the system clipboard holds exactly `expected` (compared in main, never returned). */
export function clipboardHolds(app: ElectronApplication, expected: string): Promise<boolean> {
  return app.evaluate(
    async ({ clipboard }, value) => (await clipboard.readText()) === value,
    expected,
  )
}

// ── System clipboard mutex ────────────────────────────────────────────────
// Every app instance shares the one system clipboard, and Playwright runs spec files in parallel
// workers (separate processes). A test that copies, clears or reads the clipboard takes this
// cross-process lock for its whole run, so no two such tests ever overlap. The lock is a
// directory (mkdir is atomic) holding the owner's pid; a lock whose owner died is taken over.

const CLIPBOARD_LOCK = join(tmpdir(), 'psafe3-opener-e2e-clipboard.lock')
const STALE_WITHOUT_PID_MS = 60_000
let holdingClipboard = false

function lockIsStale(): boolean {
  try {
    const pid = Number(readFileSync(join(CLIPBOARD_LOCK, 'pid'), 'utf8'))
    try {
      process.kill(pid, 0)
      return false
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    // No pid yet: the owner is between mkdir and write, unless it died there long ago.
    try {
      return Date.now() - statSync(CLIPBOARD_LOCK).mtimeMs > STALE_WITHOUT_PID_MS
    } catch {
      return false
    }
  }
}

/**
 * Waits for exclusive use of the system clipboard (call first thing in a test or beforeAll).
 * The time spent waiting is added to the test's timeout. Released by removeSetup().
 */
export async function acquireClipboard(): Promise<void> {
  if (holdingClipboard) return
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(CLIPBOARD_LOCK)
      writeFileSync(join(CLIPBOARD_LOCK, 'pid'), String(process.pid))
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (lockIsStale()) rmSync(CLIPBOARD_LOCK, { recursive: true, force: true })
      else await new Promise((r) => setTimeout(r, 100))
    }
  }
  holdingClipboard = true
  const info = test.info()
  info.setTimeout(info.timeout + (Date.now() - started))
}

export function releaseClipboard(): void {
  if (!holdingClipboard) return
  holdingClipboard = false
  rmSync(CLIPBOARD_LOCK, { recursive: true, force: true })
}
