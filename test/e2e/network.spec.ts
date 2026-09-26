// §E blocked-network test: during the full WP9 journey the app makes no network requests.
//
// Three recorders, so a request can't slip past all of them:
// 1. Chromium's net log (`--log-net-log`), started with the process: every request that reaches
//    the network stack from any session or from main's `net`, including ones Chromium makes for
//    itself. Requests the app's own session filter cancels never get this far.
// 2. A session-level recorder (`webRequest.onBeforeRequest`) installed after launch that records
//    every non-local URL and, like the app's own filter it replaces, cancels it. This catches
//    attempts that the app's filter would have stopped.
// 3. Node's diagnostics channels in main (`net.client.socket`, `http.client.request.start`,
//    `undici:request:create`): sockets and HTTP requests made by Node code, which bypass Chromium.
// Controls at the end prove each recorder is live, so the test fails if the app fetches anything.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { runFullFlow } from './flow'
import {
  WINDOWS_READ_ONLY,
  acquireClipboard,
  isWindows,
  launch,
  makeSetup,
  removeSetup,
} from './helpers'

/**
 * Made on purpose at the end. The session recorder records every URL that isn't a local scheme,
 * loopback included, so a loopback control proves it is live without any chance of leaving the
 * machine. (A `.invalid` host was not seen by webRequest on the macOS runner.)
 */
const CONTROL_URL = 'http://127.0.0.1:9/wp9-session-control'
/** Local only: nothing listens on the discard port, so this never leaves the machine. */
const LOCAL_CONTROL_URL = 'http://127.0.0.1:9/wp9-control'

/** Loopback never leaves the machine (the local control uses it). */
const LOOPBACK = /^(\w+:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i

const LOCAL_SCHEMES = /^(file|devtools|data|blob|chrome|chrome-extension|about):/i

/** Non-local URLs and hosts a Chromium net log mentions. */
function remoteInNetLog(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  const found = new Set<string>()
  for (const m of text.matchAll(/"(?:url|original_url|host|origin|destination)":"([^"]*)"/g)) {
    const v = m[1]!
    if (v !== '' && !LOCAL_SCHEMES.test(v)) found.add(v)
  }
  return [...found]
}

interface Recorded {
  session: string[]
  node: string[]
}

async function installRecorders(app: ElectronApplication): Promise<void> {
  // The app installs its own session filter at startup, before it creates the window, and a new
  // filter replaces the old one. Wait for the window so ours goes in last (on the macOS runner
  // startup is slow enough that installing earlier was silently undone). Startup requests before
  // this point are still covered by the net log.
  await (await app.firstWindow()).getByTestId('status').waitFor({ state: 'attached' })
  await app.evaluate(({ session }, localSchemes) => {
    const g = globalThis as { __wp9Net?: Recorded }
    const rec: Recorded = { session: [], node: [] }
    g.__wp9Net = rec
    const local = new RegExp(localSchemes, 'i')
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const isLocal = local.test(details.url)
      if (!isLocal) rec.session.push(details.url)
      callback({ cancel: !isLocal })
    })
    const dc = process.getBuiltinModule('node:diagnostics_channel')
    dc.subscribe('net.client.socket', () => rec.node.push('socket'))
    dc.subscribe('http.client.request.start', () => rec.node.push('http'))
    dc.subscribe('undici:request:create', () => rec.node.push('undici'))
  }, LOCAL_SCHEMES.source)
}

const recorded = (app: ElectronApplication) =>
  app.evaluate(
    () => (globalThis as { __wp9Net?: Recorded }).__wp9Net ?? { session: ['missing'], node: [] },
  )

/** Spellchecker dictionary download (known bug, see the PR). */
const SPELLCHECK = /(^|[/.])gvt1\.com(\/|:|$)|\/edgedl\/chrome\/dict\//

interface Results {
  during: Recorded
  netLog: string[]
  controls: { session: boolean; node: boolean; netLog: boolean }
}

let results: Results | undefined

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.beforeAll(async () => {
  if (isWindows) return
  await acquireClipboard() // the journey copies a password
  const s = makeSetup('cli-add')
  const netLog = join(s.dir, 'net-log.json')
  const app = await launch(s, {}, [`--log-net-log=${netLog}`])
  try {
    await installRecorders(app)
    await runFullFlow(app, s)
    const during = await recorded(app)

    // Controls: each recorder must see a deliberate request.
    await app.evaluate(async ({ net }, url) => {
      await net.fetch(url).catch(() => undefined) // cancelled by the session recorder
    }, CONTROL_URL)
    await app.evaluate(async ({ net, session }, url) => {
      // With no session filter the request reaches the network stack (and the net log); the
      // loopback discard port refuses it, so nothing leaves the machine.
      session.defaultSession.webRequest.onBeforeRequest(null)
      await net.fetch(url).catch(() => undefined)
    }, LOCAL_CONTROL_URL)
    await app.evaluate(async () => {
      const http = process.getBuiltinModule('node:http')
      await new Promise<void>((done) => {
        const req = http.get('http://127.0.0.1:9/', () => done())
        req.on('error', () => done())
      })
    })
    const after = await recorded(app)
    await app.close()

    const logged = remoteInNetLog(netLog)
    results = {
      during,
      netLog: logged.filter((u) => !LOOPBACK.test(u)),
      controls: {
        session: after.session.some((u) => u.startsWith(CONTROL_URL)),
        node: after.node.length > during.node.length,
        netLog: logged.some((u) => u.startsWith(LOCAL_CONTROL_URL)),
      },
    }
  } finally {
    removeSetup(s) // also kills the app if the journey failed half way
  }
})

test('all three network recorders are live during the full journey', () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  expect(results?.controls).toEqual({ session: true, node: true, netLog: true })
})

test('the full journey makes no network requests apart from the known spellchecker download', () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  const r = results!
  expect(r.during).toEqual({ session: [], node: [] })
  expect(r.netLog.filter((u) => !SPELLCHECK.test(u))).toEqual([])
})

test('the full journey makes no network requests', () => {
  test.skip(isWindows, WINDOWS_READ_ONLY)
  const r = results!
  expect(r.during).toEqual({ session: [], node: [] })
  expect(r.netLog).toEqual([])
})
