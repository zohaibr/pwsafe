// Launch smoke test for a packaged or installed app (release workflow, docs/execution-plan.md WP5).
// Usage: node build/smoke-packaged.mjs <path to the app executable> [extra Electron args...]
// Needs a display (xvfb-run on Linux).
//
// 1. Fuses (docs/security-review.md F1): reads the fuse wire from the binary and checks every
//    fuse electron-builder.yml sets (skipped with a notice for an AppImage, whose binary is
//    compressed), then checks the behaviour: with ELECTRON_RUN_AS_NODE=1 the binary must start the
//    app, not run a Node script.
// 2. Starts the real binary with --inspect=0, waits for the main window to render the app, checks
//    that no Node debugger started, then closes it and checks the process exited cleanly.
//    (NODE_OPTIONS is not tested by behaviour: Electron already ignores almost all of it in a
//    packaged app, so only the fuse wire shows that fuse.)
//
// The fuses turn off --inspect, so Playwright's Electron launcher (which needs it) can't be used.
// The window is reached over Chromium's DevTools protocol (--remote-debugging-port) instead.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getCurrentFuseWire } from '@electron/fuses'
import { chromium } from '@playwright/test'

const [executablePath, ...args] = process.argv.slice(2)
if (!executablePath || !existsSync(executablePath)) {
  console.error(`smoke: executable not found: ${executablePath ?? '(none given)'}`)
  process.exit(2)
}

// Rosetta translates an x64 build on its first launch, which can take minutes on an arm64 runner,
// so the workflow raises this for that case.
const timeout = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 60_000)
const RUN_AS_NODE_MARKER = 'SMOKE-RAN-AS-NODE'
const DEVTOOLS_RE = /DevTools listening on (ws:\/\/\S+)/

function fail(message) {
  console.error(`smoke: ${message}`)
  process.exit(1)
}

/** Starts the app; `ready` resolves once its DevTools endpoint is up, or with the exit if it ends first. */
function start(extraArgs, extraEnv) {
  const proc = spawn(executablePath, [...extraArgs, ...args, '--remote-debugging-port=0'], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (d) => (stdout += d))
  const exited = new Promise((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  )
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no window within ${timeout} ms`)), timeout)
    proc.stderr.on('data', (d) => {
      stderr += d
      const m = DEVTOOLS_RE.exec(stderr)
      if (m) {
        clearTimeout(timer)
        resolve({ ws: m[1] })
      }
    })
    void exited.then((e) => {
      clearTimeout(timer)
      resolve({ exit: e })
    })
  })
  return { proc, exited, ready, out: () => stdout, err: () => stderr }
}

/** Waits for the DevTools endpoint; kills the app on a timeout. */
async function ready(app) {
  try {
    return await app.ready
  } catch (err) {
    app.proc.kill()
    throw err
  }
}

/**
 * Quits the app and waits for the process to end. Browser.close (DevTools protocol) closes the
 * window, which quits the app on Windows and Linux; on macOS the app stays running with no window
 * (normal for a Mac app), so there it then gets SIGTERM, which Electron handles as a normal quit.
 */
async function quit(browser, app) {
  const within = (ms) =>
    Promise.race([app.exited, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))])
  const session = await browser.newBrowserCDPSession()
  // The connection drops as the app quits, so this call may never answer.
  void session.send('Browser.close').catch(() => {})
  let outcome = await within(process.platform === 'darwin' ? 5_000 : timeout)
  if (!outcome && process.platform !== 'win32') {
    app.proc.kill('SIGTERM')
    outcome = await within(timeout)
  }
  if (!outcome) {
    app.proc.kill('SIGKILL')
    fail('app did not quit')
  }
  return outcome
}

// ── 1. Fuses ────────────────────────────────────────────────────────────────────────────────────
// Fuse wire indexes (@electron/fuses FuseV1Options) and the state electron-builder.yml asks for.
const ENABLE = 49
const DISABLE = 48
const EXPECTED_FUSES = {
  0: ['RunAsNode', DISABLE],
  1: ['EnableCookieEncryption', ENABLE],
  2: ['EnableNodeOptionsEnvironmentVariable', DISABLE],
  3: ['EnableNodeCliInspectArguments', DISABLE],
  4: ['EnableEmbeddedAsarIntegrityValidation', ENABLE],
  5: ['OnlyLoadAppFromAsar', ENABLE],
}
if (/\.AppImage$/i.test(executablePath)) {
  console.error('smoke: fuse wire not readable inside an AppImage; checking behaviour only')
} else {
  const wire = await getCurrentFuseWire(executablePath)
  for (const [index, [name, want]] of Object.entries(EXPECTED_FUSES)) {
    if (wire[index] !== want) {
      fail(
        `fuse ${name} is ${wire[index] === ENABLE ? 'enabled' : 'not disabled'}; expected ${want === ENABLE ? 'enabled' : 'disabled'}`,
      )
    }
  }
  console.error('smoke: fuses set as configured')
}

{
  const script = `process.stdout.write(${JSON.stringify(RUN_AS_NODE_MARKER)}); process.exit(0)`
  const app = start(['-e', script], { ELECTRON_RUN_AS_NODE: '1' })
  const r = await ready(app)
  if (app.out().includes(RUN_AS_NODE_MARKER)) fail('ELECTRON_RUN_AS_NODE=1 ran a Node script')
  // (A binary that runs as Node also rejects --remote-debugging-port and exits early.)
  if (r.exit) fail(`with ELECTRON_RUN_AS_NODE=1 it ran as Node (exited, code ${r.exit.code})`)
  const browser = await chromium.connectOverCDP(r.ws)
  const { code } = await quit(browser, app)
  if (app.out().includes(RUN_AS_NODE_MARKER)) fail('ELECTRON_RUN_AS_NODE=1 ran a Node script')
  console.error(`smoke: ELECTRON_RUN_AS_NODE ignored (the app started instead; exit ${code})`)
}

// ── 2. Launch, render, close; --inspect is ignored ─────────────────────────────────────────────
{
  const app = start(['--inspect=0'], {})
  const r = await ready(app)
  if (r.exit) fail(`app exited before showing a window (code ${r.exit.code})`)
  const browser = await chromium.connectOverCDP(r.ws)
  try {
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout }))
    await page.getByRole('heading', { name: 'psafe3 Opener' }).waitFor({ timeout })
    const title = await page.title()
    console.error(`smoke: window up (title "${title}"), closing`)
  } catch (err) {
    console.error('smoke: app did not show its window')
    app.proc.kill()
    throw err
  }
  if (/Debugger listening/.test(app.err())) fail('--inspect started a Node debugger (fuse not set)')
  const { code, signal } = await quit(browser, app)
  if (code !== 0) fail(`app exited with code ${code} signal ${signal}`)
  console.error('smoke: --inspect ignored; launched and exited cleanly')
}
