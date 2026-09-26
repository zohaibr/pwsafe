// Launch smoke test for a packaged or installed app (release workflow, docs/execution-plan.md WP5).
// Usage: node build/smoke-packaged.mjs <path to the app executable> [extra Electron args...]
// Starts the real binary, waits for the main window to render the app, then closes it and
// checks the process exited cleanly. Needs a display (xvfb-run on Linux).
import { existsSync } from 'node:fs'
import { _electron as electron } from '@playwright/test'

const [executablePath, ...args] = process.argv.slice(2)
if (!executablePath || !existsSync(executablePath)) {
  console.error(`smoke: executable not found: ${executablePath ?? '(none given)'}`)
  process.exit(2)
}

const app = await electron.launch({ executablePath, args, timeout: 60_000 })
const proc = app.process()
const exited = new Promise((resolve) =>
  proc.once('exit', (code, signal) => resolve({ code, signal })),
)
try {
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'psafe3 Opener' }).waitFor({ timeout: 30_000 })
  const title = await page.title()
  console.error(`smoke: window up (title "${title}"), closing`)
} catch (err) {
  console.error('smoke: app did not show its window')
  await app.close().catch(() => {})
  throw err
}
await app.close()
const { code, signal } = await exited
if (code !== 0) {
  console.error(`smoke: app exited with code ${code} signal ${signal}`)
  process.exit(1)
}
console.error('smoke: launched and exited cleanly')
