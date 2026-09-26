// WP9 (docs/execution-plan.md §D WP9, §E): the whole journey against the real built app on a copy
// of a committed fixture (see flow.ts for the steps and what each one checks).
import { expect, test } from '@playwright/test'
import { FLOW_FILES, runFullFlow } from './flow'
import {
  WINDOWS_READ_ONLY,
  isWindows,
  launch,
  makeSetup,
  removeSetup,
  siblings,
  type Setup,
} from './helpers'

let setup: Setup | undefined
test.beforeEach(() => {
  setup = makeSetup('cli-add')
})
test.afterEach(() => {
  removeSetup(setup)
  setup = undefined
})

test('unlock → search → copy → add → edit → delete → save → reopen → export → Save As → restore', async () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  test.setTimeout(120_000)
  const s = setup!
  const app = await launch(s)
  await runFullFlow(app, s)
  await app.close()
  // Quit released the lock; no staged, journal or temp files were left behind.
  expect(siblings(s)).toEqual([...FLOW_FILES].sort())
})
