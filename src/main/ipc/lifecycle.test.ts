// Sender checks, the quit / close-window flow, the idle timer, test mode and argv parsing (WP7).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { IpcChannel } from '../../shared/ipc'
import { MemoryFileSystem } from '../fs/memoryFs'
import { makeVault } from '../vault/testkit'
import { ClipboardGuard, type Timers } from './clipboard'
import { CloseFlow, type CloseReason } from './closeFlow'
import { Controller } from './controller'
import { IdleLock } from './idle'
import { fileFromArgv } from './openFile'
import { RecentFiles } from './recentFiles'
import { isAppUrl, registerIpc, type IpcMainLike, type SenderInfo } from './register'
import { SettingsStore } from './settings'
import { readTestMode } from './testMode'

class ManualTimers implements Timers {
  t = 0
  jobs = new Map<number, { at: number; fn: () => void }>()
  private id = 0
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    this.jobs.set(++this.id, { at: this.t + ms, fn })
    return this.id
  }
  clearTimeout = (h: unknown) => void this.jobs.delete(h as number)
  advance(ms: number) {
    this.t += ms
    for (const [id, j] of [...this.jobs]) {
      if (j.at <= this.t) {
        this.jobs.delete(id)
        j.fn()
      }
    }
  }
}

describe('registerIpc: only our own window may call', () => {
  const APP = 'file:///app/out/renderer/index.html'

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'wp7-reg-'))
    const vault = makeVault(new MemoryFileSystem())
    const settings = new SettingsStore(dir)
    const activity = vi.fn()
    const controller = new Controller({
      vault,
      dialogs: {
        openVault: vi.fn(async () => null),
        saveVaultAs: vi.fn(async () => null),
        saveExport: vi.fn(async () => null),
      },
      clipboard: new ClipboardGuard({ readText: () => '', writeText: () => {} }),
      settings,
      recent: new RecentFiles(dir),
      closeFlow: new CloseFlow({
        dirtyCount: () => 0,
        ask: () => true,
        focus: () => {},
        proceed: async () => {},
      }),
      writeExport: async () => {},
      showItemInFolder: () => {},
      downloadsDir: () => dir,
      onActivity: activity,
    })
    const handlers = new Map<string, (e: SenderInfo, ...a: unknown[]) => Promise<unknown>>()
    const listeners = new Map<string, (e: SenderInfo, ...a: unknown[]) => void>()
    const ipc: IpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn),
      on: (ch, fn) => void listeners.set(ch, fn),
    }
    const ours = { sender: 'our-webcontents', senderFrame: { url: APP } }
    const outbound: string[] = []
    registerIpc(ipc, controller, {
      isTrustedSender: (e) =>
        e.sender === 'our-webcontents' && !!e.senderFrame && isAppUrl(e.senderFrame.url, APP),
      onOutbound: (ch) => void outbound.push(ch),
    })
    return { handlers, listeners, ours, outbound, activity, dir, controller }
  }

  it('registers every invoke channel plus reportActivity', async () => {
    const s = await setup()
    const invokes = Object.values(IpcChannel).filter(
      (c) => !c.startsWith('psafe:event:') && c !== IpcChannel.reportActivity,
    )
    expect([...s.handlers.keys()].sort()).toEqual([...invokes].sort())
    expect([...s.listeners.keys()]).toEqual([IpcChannel.reportActivity])
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('answers our frame and refuses a foreign sender or frame URL without doing the work', async () => {
    const s = await setup()
    const getState = s.handlers.get(IpcChannel.getState)!
    expect(await getState(s.ours)).toMatchObject({ ok: true })
    const foreignSender = { sender: 'other', senderFrame: { url: APP } }
    const foreignFrame = { sender: 'our-webcontents', senderFrame: { url: 'https://evil.test/' } }
    const noFrame = { sender: 'our-webcontents', senderFrame: null }
    for (const e of [foreignSender, foreignFrame, noFrame]) {
      const r = (await getState(e)) as { ok: boolean; error?: { code: string } }
      expect(r.ok).toBe(false)
      expect(r.error?.code).toBe(ErrorCode.INVALID_ARGUMENT)
    }
    const report = s.listeners.get(IpcChannel.reportActivity)!
    report(foreignSender)
    expect(s.activity).not.toHaveBeenCalled()
    report(s.ours)
    expect(s.activity).toHaveBeenCalledTimes(1)
    report(s.ours, 'unexpected')
    expect(s.activity).toHaveBeenCalledTimes(1)
    expect(s.outbound).toContain(IpcChannel.getState)
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('isAppUrl accepts our file (with hash or query) and, in dev only, the dev-server origin', () => {
    expect(isAppUrl(`${APP}#/x`, APP)).toBe(true)
    expect(isAppUrl('file:///elsewhere/index.html', APP)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', APP)).toBe(false)
    expect(isAppUrl('http://localhost:5173/src', APP, 'http://localhost:5173')).toBe(true)
    expect(isAppUrl('http://localhost:5174/', APP, 'http://localhost:5173')).toBe(false)
  })
})

describe('CloseFlow (§B3)', () => {
  function flow(dirty: { n: number }) {
    const asked: CloseReason[] = []
    const done: CloseReason[] = []
    const f = new CloseFlow({
      dirtyCount: () => dirty.n,
      ask: (r) => (asked.push(r), true),
      focus: () => {},
      proceed: async (r) => void done.push(r),
    })
    return { f, asked, done }
  }

  it('clean: goes ahead without asking', async () => {
    const { f, asked, done } = flow({ n: 0 })
    await f.request('quit')
    expect(asked).toEqual([])
    expect(done).toEqual(['quit'])
  })

  it('dirty: asks; cancel keeps everything; discard goes ahead', async () => {
    const dirty = { n: 2 }
    const { f, asked, done } = flow(dirty)
    await f.request('close-window')
    expect(asked).toEqual(['close-window'])
    await f.respond('cancel')
    expect(done).toEqual([])
    await f.request('quit')
    await f.respond('discard')
    expect(done).toEqual(['quit'])
  })

  it("'save' goes ahead only when nothing is left unsaved", async () => {
    const dirty = { n: 1 }
    const { f, done } = flow(dirty)
    await f.request('quit')
    await f.respond('save')
    expect(done).toEqual([])
    await f.request('quit')
    dirty.n = 0
    await f.respond('save')
    expect(done).toEqual(['quit'])
  })

  it('an answer with no question is ignored; a second quit while asking does not ask twice', async () => {
    const { f, asked, done } = flow({ n: 1 })
    await f.respond('discard')
    expect(done).toEqual([])
    await f.request('close-window')
    await f.request('quit')
    expect(asked).toEqual(['close-window'])
    expect(f.pendingReason).toBe('quit')
  })

  it('a quit that arrives while closing the window runs afterwards', async () => {
    const done: CloseReason[] = []
    const f: CloseFlow = new CloseFlow({
      dirtyCount: () => 0,
      ask: () => true,
      focus: () => {},
      proceed: async (r) => {
        done.push(r)
        if (r === 'close-window') await f.request('quit')
      },
    })
    await f.request('close-window')
    expect(done).toEqual(['close-window', 'quit'])
  })
})

describe('IdleLock (§B2)', () => {
  it('locks after the idle time; activity restarts the countdown; stop cancels', () => {
    const timers = new ManualTimers()
    const onIdle = vi.fn()
    const idle = new IdleLock(timers, () => 5, onIdle)
    idle.activity() // not running: ignored
    expect(timers.jobs.size).toBe(0)
    idle.start()
    timers.advance(4 * 60_000)
    idle.activity()
    timers.advance(4 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
    timers.advance(60_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(idle.isRunning).toBe(false)
    idle.start()
    idle.stop()
    timers.advance(10 * 60_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})

describe('test mode and argv', () => {
  it('is ignored in packaged builds and off unless PSAFE_E2E=1', () => {
    const env = { PSAFE_E2E: '1', PSAFE_E2E_OPEN: '/x.psafe3' }
    expect(readTestMode(env, true)).toBeUndefined()
    expect(readTestMode({ PSAFE_E2E_OPEN: '/x.psafe3' }, false)).toBeUndefined()
    const m = readTestMode(env, false)!
    expect(m.dialogPath('open')).toBe('/x.psafe3')
    expect(m.dialogPath('export')).toBeNull()
  })

  it('fileFromArgv picks the last .psafe3 argument and skips flags', () => {
    expect(fileFromArgv(['/app/psafe3', '--flag', 'a.txt'])).toBeUndefined()
    expect(fileFromArgv(['/app/psafe3', '/d/One.psafe3', '--x=y.psafe3', '/d/Two.PSAFE3'])).toBe(
      resolve('/d/Two.PSAFE3'),
    )
    expect(fileFromArgv(['/app/psafe3', 'rel.psafe3'], '/home/me')).toBe(
      resolve('/home/me/rel.psafe3'),
    )
    // argv[0] (the executable) is never taken.
    expect(fileFromArgv(['/weird/app.psafe3'])).toBeUndefined()
  })
})
