import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('app launches, shows its window and keeps the renderer sandboxed', async () => {
  const app = await electron.launch({
    args: [resolve('out/main/index.js'), ...(process.env['CI'] ? ['--no-sandbox'] : [])],
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'psafe3 Opener' })).toBeVisible()
    await expect(page.getByTestId('status')).toHaveText('Status: no-file')

    const exposure = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      psafe: typeof (globalThis as { psafe?: unknown }).psafe,
    }))
    expect(exposure).toEqual({ require: 'undefined', process: 'undefined', psafe: 'object' })
  } finally {
    await app.close()
  }
})
