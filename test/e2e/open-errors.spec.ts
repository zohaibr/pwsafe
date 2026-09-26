// §E: files the app must refuse. Each case shows its own message and leaves the file's bytes and
// modification time exactly as they were, and no lock file or other sidecar is left behind.
// Runs on every platform (nothing here writes).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  chooseFile,
  launch,
  loadExpected,
  makeSetup,
  removeSetup,
  siblings,
  snapshot,
  expectUnchanged,
  status,
  type Setup,
} from './helpers'

const MASTER = loadExpected('cli-add').password

let setup: Setup | undefined
test.beforeEach(() => {
  setup = makeSetup('cli-add')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

/** Rewrites the copy and gives it an old, fixed mtime so any later write would show. */
function rewrite(s: Setup, bytes: Uint8Array): void {
  writeFileSync(s.db, bytes)
  const old = new Date('2024-01-02T03:04:05Z')
  utimesSync(s.db, old, old)
}

interface Outcome {
  code: string | null
  text: string
}

async function alertOn(page: Page): Promise<Outcome> {
  const alert = page.locator('.alert[data-code]').first()
  await expect(alert).toBeVisible({ timeout: 30_000 })
  return { code: await alert.getAttribute('data-code'), text: (await alert.innerText()).trim() }
}

/** Open → (unlock with `password` if the app gets that far) → the alert the app shows. */
async function tryOpen(s: Setup, password: string): Promise<{ outcome: Outcome; plk: boolean }> {
  const app = await launch(s)
  try {
    const page = await app.firstWindow()
    await chooseFile(page)
    // Formats refused before the password (tag) stay on the start screen; the rest need a
    // password first.
    const locked = status(page).filter({ hasText: 'Status: locked' })
    const refused = page.locator('.alert[data-code]')
    await expect(locked.or(refused).first()).toBeVisible({ timeout: 10_000 })
    if (await locked.isVisible()) {
      await page.getByLabel('Master password').fill(password)
      await page.getByRole('button', { name: 'Unlock' }).click()
    }
    const outcome = await alertOn(page)
    await expect(status(page)).not.toHaveText('Status: open')
    const plk = existsSync(join(s.dir, 'vault.plk'))
    return { outcome, plk }
  } finally {
    await app.close()
  }
}

const seen = new Map<string, string>()

async function expectRefused(
  label: string,
  s: Setup,
  password: string,
  code: string,
  opts: { plkWhileOpen?: boolean } = {},
): Promise<void> {
  const before = snapshot(s.db)
  const { outcome, plk } = await tryOpen(s, password)
  expect(outcome.code, label).toBe(code)
  expect(outcome.text.length).toBeGreaterThan(10)
  if (opts.plkWhileOpen === false) expect(plk, `${label}: no .plk for a refused format`).toBe(false)
  expectUnchanged(s.db, before)
  expect(siblings(s)).toEqual(['vault.psafe3'])
  seen.set(label, outcome.text)
}

test('wrong password shows WRONG_PASSWORD and leaves the file untouched', async () => {
  const s = setup!
  rewrite(s, readFileSync(s.db))
  await expectRefused('wrong password', s, 'not-the-password', 'WRONG_PASSWORD')
})

test('corrupted file (damaged HMAC) shows INTEGRITY_FAILED and leaves the file untouched', async () => {
  const s = setup!
  const bytes = new Uint8Array(readFileSync(s.db))
  // The last 32 bytes are the HMAC; flipping one bit there is corruption only integrity can see.
  bytes[bytes.length - 5]! ^= 0x10
  rewrite(s, bytes)
  await expectRefused('corrupted', s, MASTER, 'INTEGRITY_FAILED')
})

test('truncated file shows CORRUPT_FILE and leaves the file untouched', async () => {
  const s = setup!
  const bytes = readFileSync(s.db)
  // Cut at a block boundary in the middle of the records: no EOF block remains.
  const cut = 152 + 16 * Math.floor((bytes.length - 152) / 32)
  rewrite(s, bytes.subarray(0, cut))
  await expectRefused('truncated', s, MASTER, 'CORRUPT_FILE')
})

test('over-cap key stretching is refused with UNSUPPORTED_FORMAT before stretching', async () => {
  const s = setup!
  const bytes = new Uint8Array(readFileSync(s.db))
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(36, 2 ** 24 + 1, true)
  rewrite(s, bytes)
  await expectRefused('over-cap iterations', s, MASTER, 'UNSUPPORTED_FORMAT', {
    plkWhileOpen: false,
  })
})

test('a V4 file is refused with UNSUPPORTED_FORMAT; bytes, mtime and folder unchanged', async () => {
  const s = setup!
  // V4-style header: no PWS3 tag.
  const bytes = new Uint8Array(readFileSync(s.db))
  bytes.set(new TextEncoder().encode('PWS4'), 0)
  rewrite(s, bytes)
  await expectRefused('V4', s, MASTER, 'UNSUPPORTED_FORMAT', { plkWhileOpen: false })
})

test('a random non-psafe file is refused with UNSUPPORTED_FORMAT; untouched', async () => {
  const s = setup!
  const bytes = randomBytes(4096)
  bytes.write('RAND', 0) // never starts with PWS3 by chance
  rewrite(s, bytes)
  await expectRefused('random', s, MASTER, 'UNSUPPORTED_FORMAT', { plkWhileOpen: false })
})

test.afterAll(() => {
  // When the whole file ran in one worker, the refusals that differ in cause differ in message.
  const texts = ['wrong password', 'corrupted', 'truncated', 'over-cap iterations', 'V4']
    .map((k) => seen.get(k))
    .filter((t): t is string => t !== undefined)
  expect(new Set(texts).size).toBe(texts.length)
})
