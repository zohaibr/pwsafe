// App bugs found by the WP9 end-to-end suite, each shown by a test marked `test.fail` until the
// fix lands in src (a fixed bug makes its test pass unexpectedly, which fails CI: then delete the
// `test.fail` line).
import { expect, test } from '@playwright/test'
import {
  entryList,
  launch,
  loadExpected,
  makeSetup,
  openAndUnlock,
  removeSetup,
  type Setup,
} from './helpers'

const MASTER = loadExpected('cli-many').password

let setup: Setup | undefined
test.beforeEach(() => {
  setup = makeSetup('cli-many')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

// Bug: clicking an entry in a scrolled list selects the FIRST entry instead, whenever no visible
// entry is selected (after Restore from backup, or when search hides the selected entry).
// Cause (src/renderer/src/screens/EntryList.tsx): mouse-down focuses the listbox; its onFocus
// selects entries[0], and the selection effect scrolls that entry into view, so the list moves
// under the pointer before mouse-up and the click never reaches the option that was pressed.
// Seen on the macOS CI runner in the full flow (smaller window, so the 13-entry list scrolls).
test('clicking an entry in a scrolled list selects that entry', async () => {
  test.fail(true, 'EntryList onFocus selects and scrolls to the first entry (see WP9 PR)')
  const app = await launch(setup!)
  const page = await openAndUnlock(app, MASTER)
  await expect(page.locator('#detail-title')).toHaveText('Entry 000') // selected on open

  // Hide the selected entry; focus stays in the search box.
  await page.getByLabel('Search entries').fill('Entry 1')
  const target = entryList(page).getByRole('option', { name: /^Entry 150/ })
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await expect(page.locator('#detail-title')).toHaveText('Entry 150', { timeout: 3_000 })
  await app.close()
})
