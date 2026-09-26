// WP7 evidence against the real built app (docs/execution-plan.md WP7, §A4.8, §B3):
// - renderer hardening: no require/process, no remote navigation, no window.open, no fetch;
// - the full app opens, edits, saves and exports a COPY of a committed fixture, and our codec reads
//   the edit back from disk, with a .bak next to it and the .plk released on quit;
// - the §A4.8 IPC spy: no password value crosses to the renderer except in a revealPassword
//   response; after lock the renderer shows no entry data and the clipboard is cleared;
// - quit with unsaved changes asks first and loses nothing on Cancel.
//
// Native dialogs are stubbed through the test-mode variables documented in
// src/main/ipc/testMode.ts (ignored by packaged builds). Secrets are never printed: assertions
// compare booleans and counts, not values.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createTwofish } from '../../src/main/crypto/twofish/twofish'
import { decode } from '../../src/main/psafe3/codec'
import { stretchKeySync } from '../../src/main/psafe3/stretch'
import { buildEntries } from '../../src/main/psafe3/views'

const FIXTURE = resolve('test/fixtures/generated/cli-add.psafe3')
const EXPECTED = JSON.parse(
  readFileSync(resolve('test/fixtures/generated/cli-add.expected.json'), 'utf8'),
) as {
  password: string
  entries: { title: string; username: string; password: string; group: string }[]
}
const MASTER = EXPECTED.password
const PASSWORDS = EXPECTED.entries.map((e) => e.password)
const TITLES = EXPECTED.entries.map((e) => e.title)
const EDITED_USERNAME = 'wp7-e2e-edited-user'
const windows = process.platform === 'win32'

interface Setup {
  dir: string
  db: string
  userData: string
}

let setup: Setup | undefined

test.beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'psafe-wp7-e2e-'))
  const db = join(dir, 'vault.psafe3')
  copyFileSync(FIXTURE, db)
  setup = { dir, db, userData: join(dir, 'user-data') }
})

test.afterEach(() => {
  if (setup) rmSync(setup.dir, { recursive: true, force: true })
  setup = undefined
})

async function launch(s: Setup, extra: Record<string, string> = {}): Promise<ElectronApplication> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return electron.launch({
    args: [resolve('out/main/index.js'), ...(process.env['CI'] ? ['--no-sandbox'] : [])],
    env: {
      ...env,
      PSAFE_E2E: '1',
      PSAFE_E2E_USER_DATA: s.userData,
      PSAFE_E2E_OPEN: s.db,
      PSAFE_E2E_IPC_SPY: '1',
      ...extra,
    },
  })
}

async function openAndUnlock(app: ElectronApplication) {
  const page = await app.firstWindow()
  await expect(page.getByTestId('status')).toHaveText('Status: no-file')
  await page.getByRole('button', { name: /Open a file/ }).click()
  await expect(page.getByTestId('status')).toHaveText('Status: locked')
  await page.getByLabel('Master password').fill(MASTER)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByTestId('status')).toHaveText('Status: open', { timeout: 30_000 })
  return page
}

/** The few renderer globals the probes use (this file is type-checked without the DOM lib). */
interface Dom {
  location: { href: string }
  open(url: string): unknown
  document: {
    body: { innerText: string }
    querySelector(sel: string): { textContent: string | null } | null
    querySelectorAll(sel: string): ArrayLike<{ value?: string }>
  }
}

type SpyRecord = { channel: string; payload: unknown }
const readSpy = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __psafeIpcSpy?: SpyRecord[] }).__psafeIpcSpy ?? [])

/** Every string leaf in a payload, plus whether any `password` property holds a non-empty value. */
function scan(value: unknown, strings: string[], state: { entryPasswordSet: boolean }): void {
  if (typeof value === 'string') strings.push(value)
  else if (Array.isArray(value)) value.forEach((v) => scan(v, strings, state))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'password' && typeof v === 'string' && v !== '') state.entryPasswordSet = true
      scan(v, strings, state)
    }
  }
}

/** Names of channels whose payload carried a password (compared, never printed). */
function channelsLeakingPasswords(spy: SpyRecord[]): string[] {
  const out = new Set<string>()
  for (const rec of spy) {
    const strings: string[] = []
    const state = { entryPasswordSet: false }
    scan(rec.payload, strings, state)
    const leaked =
      state.entryPasswordSet ||
      strings.some((s) =>
        PASSWORDS.some((pw) => s === pw || (pw.length >= 8 && s.includes(pw)) || s === MASTER),
      )
    if (leaked) out.add(rec.channel)
  }
  return [...out]
}

test('renderer has no Node, no remote navigation, no new windows, no network', async () => {
  const app = await launch(setup!)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('status')).toHaveText('Status: no-file')
    const startUrl = page.url()
    expect(startUrl.startsWith('file:')).toBe(true)

    const probe = await page.evaluate(async () => {
      const g = globalThis as Record<string, unknown>
      let fetchBlocked = false
      try {
        await fetch('https://example.com/')
      } catch {
        fetchBlocked = true
      }
      const opened = (globalThis as unknown as Dom).open('https://example.com/')
      const api = g['psafe'] as Record<string, unknown>
      return {
        require: typeof g['require'],
        process: typeof g['process'],
        module: typeof g['module'],
        Buffer: typeof g['Buffer'],
        ipcRenderer: typeof g['ipcRenderer'],
        windowOpen: opened === null,
        fetchBlocked,
        apiFrozen: Object.isFrozen(api),
        apiHasGenericInvoke: 'invoke' in api || 'send' in api,
      }
    })
    expect(probe).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      Buffer: 'undefined',
      ipcRenderer: 'undefined',
      windowOpen: true,
      fetchBlocked: true,
      apiFrozen: true,
      apiHasGenericInvoke: false,
    })

    // Remote navigation is refused: the page stays on the bundled file.
    await page.evaluate(() => {
      ;(globalThis as unknown as Dom).location.href = 'https://example.com/'
    })
    await page.waitForTimeout(500)
    expect(page.url()).toBe(startUrl)
    expect(app.windows()).toHaveLength(1)
    // (Playwright's locators keep waiting for the cancelled navigation, so read the DOM directly.)
    const still = await page.evaluate(() => {
      const dom = globalThis as unknown as Dom
      return {
        href: dom.location.href,
        status: dom.document.querySelector('[data-testid="status"]')?.textContent,
      }
    })
    expect(still).toEqual({ href: startUrl, status: 'Status: no-file' })

    const devTools = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) =>
        // Present at runtime, not in Electron's typings.
        (
          w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
        ).getLastWebPreferences(),
      ),
    )
    expect(devTools[0]).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    })
  } finally {
    await app.close()
  }
})

test('opens, edits, saves and exports a copy of a fixture; no password crosses IPC except reveal', async () => {
  test.skip(windows, 'v1 opens every vault read-only on Windows (§A6)')
  const s = setup!
  const exportPath = join(s.dir, 'export.xml')
  const app = await launch(s, { PSAFE_E2E_EXPORT: exportPath })
  let closed = false
  try {
    const page = await openAndUnlock(app)
    const list = page.getByRole('listbox')
    await expect(list.getByRole('option')).toHaveCount(EXPECTED.entries.length)

    // Reveal: the one call allowed to carry a password.
    await list.getByRole('option', { name: /^Minimal/ }).click()
    await page.getByRole('button', { name: 'Show password' }).click()
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible()

    // Copy happens in main; the value reaches the clipboard, not the renderer.
    await page.getByRole('button', { name: 'Copy password' }).click()
    const pw = EXPECTED.entries.find((e) => e.title === 'Minimal')!.password
    const onClipboard = await app.evaluate(
      async ({ clipboard }, expected) => (await clipboard.readText()) === expected,
      pw,
    )
    expect(onClipboard).toBe(true)

    // Edit and save through the real vault.
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.locator('#edit-username').fill(EDITED_USERNAME)
    await page.getByRole('button', { name: 'Save entry' }).click()
    await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('dirty-count')).toHaveCount(0, { timeout: 30_000 })

    // Export: dialog stubbed, file written owner-only.
    await page.getByRole('button', { name: 'File' }).click()
    await page.getByText('Export XML…').click()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Export…' }).click()
    await expect.poll(() => existsSync(exportPath), { timeout: 10_000 }).toBe(true)
    if (process.platform !== 'win32') expect(statSync(exportPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(exportPath, 'utf8')).toContain(EDITED_USERNAME)

    // Lock: renderer drops all entry data (§A4.8) and our clipboard value is cleared (§B5).
    await page.getByRole('button', { name: 'Lock' }).click()
    await expect(page.getByTestId('status')).toHaveText('Status: locked')
    const rendererAfterLock = await page.evaluate(
      ({ titles, user }) => {
        const { document } = globalThis as unknown as Dom
        const text = document.body.innerText
        const values = Array.from(document.querySelectorAll('input, textarea')).map(
          (el) => el.value ?? '',
        )
        return {
          titlesShown: titles.filter((t) => t.length > 3 && text.includes(t)).length,
          editedUserShown: text.includes(user),
          nonEmptyInputs: values.filter((v) => v !== '').length,
          options: document.querySelectorAll('[role="option"]').length,
        }
      },
      { titles: TITLES, user: EDITED_USERNAME },
    )
    expect(rendererAfterLock).toEqual({
      titlesShown: 0,
      editedUserShown: false,
      nonEmptyInputs: 0,
      options: 0,
    })
    const clipboardCleared = await app.evaluate(
      async ({ clipboard }, expected) => (await clipboard.readText()) !== expected,
      pw,
    )
    expect(clipboardCleared).toBe(true)

    // §A4.8 IPC spy over everything main sent to the renderer in this session.
    const spy = await readSpy(app)
    expect(spy.length).toBeGreaterThan(10)
    const leaking = channelsLeakingPasswords(spy)
    expect(leaking).toEqual(['psafe:revealPassword'])

    await app.close()
    closed = true
  } finally {
    if (!closed) await app.close()
  }

  // The saved file, read back by our codec, has the edit; a backup and no lock file remain.
  const bytes = new Uint8Array(readFileSync(s.db))
  const decoded = await decode(bytes, new TextEncoder().encode(MASTER), {
    cipherFactory: createTwofish,
    stretch: async (p, salt, it) => stretchKeySync(p, salt, it),
  })
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) return
  const entries = buildEntries(decoded.value.records)
  expect(entries).toHaveLength(EXPECTED.entries.length)
  expect(entries.find((e) => e.title === 'Minimal')?.username).toBe(EDITED_USERNAME)
  // Everything else is unchanged.
  const byTitle = (list: { title: string; group: string; username: string }[]) =>
    list
      .filter((e) => e.title !== 'Minimal')
      .map((e) => `${e.group}/${e.title}/${e.username}`)
      .sort()
  expect(byTitle(entries)).toEqual(byTitle(EXPECTED.entries))
  expect(existsSync(`${s.db}.bak`)).toBe(true)
  expect(readFileSync(`${s.db}.bak`).equals(readFileSync(FIXTURE))).toBe(true)
  expect(existsSync(join(s.dir, 'vault.plk'))).toBe(false)
})

test('quit with unsaved changes asks first; Cancel keeps them, Don’t save quits', async () => {
  test.skip(windows, 'v1 opens every vault read-only on Windows (§A6)')
  const s = setup!
  const before = readFileSync(s.db)
  const app = await launch(s)
  const page = await openAndUnlock(app)
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /^Minimal/ })
    .click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.locator('#edit-username').fill(EDITED_USERNAME)
  await page.getByRole('button', { name: 'Save entry' }).click()
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')
  expect(existsSync(join(s.dir, 'vault.plk'))).toBe(true)

  await app.evaluate(({ app: a }) => a.quit())
  await expect(
    page.getByRole('alertdialog', { name: 'Save changes before quitting?' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('dirty-count')).toHaveText('Unsaved changes (1)')
  expect(app.windows()).toHaveLength(1)

  const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
  await app.evaluate(({ app: a }) => a.quit())
  // The app quits while the click is still settling, so the click itself may report "closed".
  await page
    .getByRole('button', { name: "Don't save" })
    .click()
    .catch(() => {})
  await exited
  expect(readFileSync(s.db).equals(before)).toBe(true)
  expect(existsSync(join(s.dir, 'vault.plk'))).toBe(false)
})
