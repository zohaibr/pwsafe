// IPC handlers (WP7): argument validation, locked-state refusal, never throwing, clipboard in main,
// export, Save As, and the §A4.8 IPC spy over every response. Uses WP6's vault on the in-memory
// file system with the fast key-stretch stand-in.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, type Result } from '../../shared/errors'
import { IpcChannel } from '../../shared/ipc'
import { CLIPBOARD_CLEAR_MS } from '../../shared/limits'
import type { VaultState } from '../../shared/types'
import { MemoryFileSystem } from '../fs/memoryFs'
import { encodeModel, makeVault, PASSWORD, smallModel, uuidHex } from '../vault/testkit'
import { ClipboardGuard, type Timers } from './clipboard'
import { CloseFlow } from './closeFlow'
import { Controller, defaultExportName, type InvokeChannel, type VaultApi } from './controller'
import { RecentFiles } from './recentFiles'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'

const DB = '/v/db.psafe3'
const MASTER = new TextDecoder().decode(PASSWORD)
/** Record passwords in smallModel(), plus the master password. ('locked' is skipped: it is also a status.) */
const SECRETS = ['bank-secret', 'card-secret', 'mail-secret', MASTER]

class FakeClipboard {
  value = ''
  readText() {
    return this.value
  }
  writeText(t: string) {
    this.value = t
  }
}

class FakeTimers implements Timers {
  t = 1_000_000
  private jobs: { at: number; fn: () => void; id: number }[] = []
  private next = 1
  now() {
    return this.t
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++
    this.jobs.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout(h: unknown) {
    this.jobs = this.jobs.filter((j) => j.id !== h)
  }
  async advance(ms: number) {
    this.t += ms
    const due = this.jobs.filter((j) => j.at <= this.t)
    this.jobs = this.jobs.filter((j) => j.at > this.t)
    due.forEach((j) => j.fn())
    await new Promise((r) => setTimeout(r, 0))
  }
}

interface Env {
  controller: Controller
  vault: VaultApi
  fs: MemoryFileSystem
  clip: FakeClipboard
  timers: FakeTimers
  dialogs: { open: string | null; saveAs: string | null; export: string | null; shown: string[] }
  exports: Map<string, string>
  revealed: string[]
  recent: RecentFiles
  dir: string
  call(channel: InvokeChannel, ...args: unknown[]): Promise<Result<unknown>>
}

let env: Env
let tmp: string

async function makeEnv(vaultOverride?: VaultApi): Promise<Env> {
  const fs = new MemoryFileSystem()
  fs.setFile(DB, await encodeModel(smallModel()))
  const vault = vaultOverride ?? makeVault(fs)
  const clip = new FakeClipboard()
  const timers = new FakeTimers()
  const dialogs = {
    open: DB as string | null,
    saveAs: null as string | null,
    export: null as string | null,
    shown: [] as string[],
  }
  const exports = new Map<string, string>()
  const revealed: string[] = []
  const settings = new SettingsStore(tmp)
  await settings.load()
  const recent = new RecentFiles(tmp)
  await recent.load()
  const closeFlow = new CloseFlow({
    dirtyCount: () => vault.getState().dirtyCount,
    ask: () => true,
    focus: () => {},
    proceed: async () => {},
  })
  const controller = new Controller({
    vault,
    dialogs: {
      openVault: async () => (dialogs.shown.push('open'), dialogs.open),
      saveVaultAs: async () => (dialogs.shown.push('saveAs'), dialogs.saveAs),
      saveExport: async () => (dialogs.shown.push('export'), dialogs.export),
    },
    clipboard: new ClipboardGuard(clip, timers),
    settings,
    recent,
    closeFlow,
    writeExport: async (p, xml) => void exports.set(p, xml),
    showItemInFolder: (p) => void revealed.push(p),
    downloadsDir: () => '/home/me/Downloads',
    now: () => new Date(2026, 8, 26, 12),
  })
  const call = (channel: InvokeChannel, ...args: unknown[]) => controller.handlers[channel](args)
  return {
    controller,
    vault,
    fs,
    clip,
    timers,
    dialogs,
    exports,
    revealed,
    recent,
    dir: tmp,
    call,
  }
}

async function unlocked(): Promise<void> {
  expect((await env.call(IpcChannel.chooseFile)).ok).toBe(true)
  const r = await env.call(IpcChannel.unlock, MASTER)
  expect(r.ok && (r.value as VaultState).status).toBe('open')
}

const code = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code)

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'wp7-ipc-'))
  env = await makeEnv()
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('argument validation (INVALID_ARGUMENT, checked in main)', () => {
  const big = 'x'.repeat(17 * 1024 * 1024)
  const bad: [InvokeChannel, unknown[]][] = [
    [IpcChannel.chooseFile, ['extra']],
    [IpcChannel.chooseRecentFile, [42]],
    [IpcChannel.chooseRecentFile, ['x'.repeat(500)]],
    [IpcChannel.unlock, [undefined]],
    [IpcChannel.unlock, ['']],
    [IpcChannel.unlock, [{ toString: () => 'pw' }]],
    [IpcChannel.unlock, ['x'.repeat(70_000)]],
    [IpcChannel.unlock, ['pw', { lockChoice: 'steal' }]],
    [IpcChannel.unlock, ['pw', { lockChoice: 'read-only', extra: 1 }]],
    [IpcChannel.unlock, ['pw', {}, 'third']],
    [IpcChannel.lock, [{ discardChanges: 'yes' }]],
    [IpcChannel.lock, ['discard']],
    [IpcChannel.getEntry, [7]],
    [IpcChannel.getEntry, ['']],
    [IpcChannel.revealPassword, [null]],
    [IpcChannel.copyField, [uuidHex(1), 'notes']],
    [IpcChannel.copyField, [uuidHex(1)]],
    [IpcChannel.saveEntry, [null]],
    [IpcChannel.saveEntry, [[]]],
    [IpcChannel.saveEntry, [{ title: 5 }]],
    [IpcChannel.saveEntry, [{ title: 'ok', __proto__: { polluted: true } }]],
    [IpcChannel.saveEntry, [{ title: 'ok', favourite: true }]],
    [IpcChannel.saveEntry, [{ notes: big }]],
    [IpcChannel.deleteEntry, [{}]],
    [IpcChannel.previewBackup, ['b1', 5]],
    [IpcChannel.restoreBackup, [undefined]],
    [IpcChannel.exportXml, [undefined]],
    [IpcChannel.exportXml, [{ scope: { kind: 'everything' } }]],
    [IpcChannel.exportXml, [{ scope: { kind: 'group', path: '' } }]],
    [IpcChannel.exportXml, [{ scope: { kind: 'all' }, path: '/tmp/x' }]],
    [IpcChannel.revealInFolder, [42]],
    [IpcChannel.revealInFolder, ['/etc/passwd\0']],
    [IpcChannel.setSettings, [{ ...DEFAULT_SETTINGS, idleLockMinutes: 0 }]],
    [IpcChannel.setSettings, [{ ...DEFAULT_SETTINGS, idleLockMinutes: 61 }]],
    [IpcChannel.setSettings, [{ ...DEFAULT_SETTINGS, idleLockMinutes: 1.5 }]],
    [IpcChannel.setSettings, [{ ...DEFAULT_SETTINGS, lockOnMinimize: 'no' }]],
    [
      IpcChannel.setSettings,
      [
        {
          ...DEFAULT_SETTINGS,
          generator: {
            ...DEFAULT_SETTINGS.generator,
            upper: false,
            lower: false,
            digits: false,
            symbols: false,
          },
        },
      ],
    ],
    [
      IpcChannel.setSettings,
      [{ ...DEFAULT_SETTINGS, generator: { ...DEFAULT_SETTINGS.generator, length: 500 } }],
    ],
    [IpcChannel.respondToClose, ['maybe']],
    [IpcChannel.getState, [1]],
  ]

  it.each(bad.map(([c, a], i) => [i, c, a] as const))('#%i %s is refused', async (_i, ch, args) => {
    await unlocked()
    const before = env.vault.getState()
    const r = await env.call(ch, ...args)
    expect(code(r)).toBe(ErrorCode.INVALID_ARGUMENT)
    expect(env.vault.getState()).toEqual(before)
    expect(env.exports.size).toBe(0)
  })

  it('every invoke channel refuses surplus arguments', async () => {
    for (const ch of Object.keys(env.controller.handlers) as InvokeChannel[]) {
      const r = await env.call(ch, 'a', 'b', 'c')
      expect([ch, code(r)]).toEqual([ch, ErrorCode.INVALID_ARGUMENT])
    }
  })

  it('valid arguments pass (a baseline for the table above)', async () => {
    await unlocked()
    expect(code(await env.call(IpcChannel.getEntry, uuidHex(1)))).toBe('ok')
    expect(code(await env.call(IpcChannel.lock, { discardChanges: false }))).toBe('ok')
    expect(code(await env.call(IpcChannel.unlock, MASTER, { lockChoice: 'read-only' }))).toBe('ok')
    expect(code(await env.call(IpcChannel.setSettings, DEFAULT_SETTINGS))).toBe('ok')
  })
})

describe('locked-state refusal (VAULT_LOCKED)', () => {
  const vaultCalls: [InvokeChannel, unknown[]][] = [
    [IpcChannel.listEntries, []],
    [IpcChannel.listGroups, []],
    [IpcChannel.getEntry, [uuidHex(1)]],
    [IpcChannel.revealPassword, [uuidHex(1)]],
    [IpcChannel.copyField, [uuidHex(1), 'password']],
    [IpcChannel.saveEntry, [{ title: 'New' }]],
    [IpcChannel.deleteEntry, [uuidHex(2)]],
    [IpcChannel.reloadFromDisk, []],
    [IpcChannel.save, []],
    [IpcChannel.saveAs, []],
    [IpcChannel.listBackups, []],
    [IpcChannel.previewBackup, ['b1', 'pw']],
    [IpcChannel.restoreBackup, ['b1']],
    [IpcChannel.exportXml, [{ scope: { kind: 'all' } }]],
  ]

  it.each(vaultCalls)('%s while locked, without showing a dialog', async (ch, args) => {
    await unlocked()
    env.dialogs.saveAs = '/v/other.psafe3'
    env.dialogs.export = '/v/out.xml'
    await env.call(IpcChannel.lock)
    expect(env.vault.getState().status).toBe('locked')
    const r = await env.call(ch, ...args)
    expect(code(r)).toBe(ErrorCode.VAULT_LOCKED)
    expect(env.dialogs.shown).toEqual(['open'])
    expect(env.clip.value).toBe('')
  })

  it.each(vaultCalls)('%s with no file chosen', async (ch, args) => {
    expect(code(await env.call(ch, ...args))).toBe(ErrorCode.VAULT_LOCKED)
  })
})

describe('never throws across IPC', () => {
  it('a vault method that throws becomes IO_ERROR', async () => {
    const real = makeVault(new MemoryFileSystem())
    const exploding = new Proxy(real, {
      get(target, key, receiver) {
        if (key === 'getState')
          return () => ({ status: 'open', dirtyCount: 0, banners: [] }) as VaultState
        if (key === 'listEntries')
          return () => {
            throw new Error('boom')
          }
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    const e = await makeEnv(exploding)
    const r = await e.call(IpcChannel.listEntries)
    expect(code(r)).toBe(ErrorCode.IO_ERROR)
  })
})

describe('files', () => {
  it('Open: cancel keeps the current vault; a pick opens it and adds it to Recent files by id only', async () => {
    await unlocked()
    env.dialogs.open = null
    expect(await env.call(IpcChannel.chooseFile)).toEqual({ ok: true, value: null })
    expect(env.vault.getState().status).toBe('open')
    const recent = await env.recent.list()
    // The recent list reads the real disk; the memory-fs path does not exist there.
    expect(recent).toEqual([])
    const listed = await env.call(IpcChannel.listRecentFiles)
    expect(listed.ok).toBe(true)
  })

  it('recent ids are opaque and map back only in main', async () => {
    const real = join(env.dir, 'real.psafe3')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(real, 'x')
    await env.recent.add(real)
    const r = await env.call(IpcChannel.listRecentFiles)
    if (!r.ok) throw new Error('listRecentFiles failed')
    const list = r.value as { id: string; fileName: string; folder: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]!.fileName).toBe('real.psafe3')
    expect(list[0]!.id).not.toContain('real')
    expect(env.recent.pathFor(list[0]!.id)).toBe(real)
    expect(code(await env.call(IpcChannel.chooseRecentFile, 'r-unknown'))).toBe(ErrorCode.IO_ERROR)
  })

  it('Save As: cancel → null; a path → saved there and becomes the active file', async () => {
    await unlocked()
    expect(await env.call(IpcChannel.saveAs)).toEqual({ ok: true, value: null })
    env.dialogs.saveAs = '/v/copy.psafe3'
    const r = await env.call(IpcChannel.saveAs)
    expect(code(r)).toBe('ok')
    expect(env.vault.getState().fileName).toBe('copy.psafe3')
    expect(env.fs.peek('/v/copy.psafe3')).toBeDefined()
  })
})

describe('clipboard in main (§A4.8, §B5)', () => {
  it('copies in main, returns only the clear time, and clears after 30 s if still ours', async () => {
    await unlocked()
    const r = await env.call(IpcChannel.copyField, uuidHex(1), 'password')
    expect(r).toEqual({ ok: true, value: { clearsAt: env.timers.now() + CLIPBOARD_CLEAR_MS } })
    expect(env.clip.value).toBe('bank-secret')
    await env.timers.advance(CLIPBOARD_CLEAR_MS - 1)
    expect(env.clip.value).toBe('bank-secret')
    await env.timers.advance(1)
    expect(env.clip.value).toBe('')
  })

  it('leaves the clipboard alone when the user copied something else meanwhile', async () => {
    await unlocked()
    await env.call(IpcChannel.copyField, uuidHex(1), 'username')
    env.clip.value = 'something the user copied'
    await env.timers.advance(CLIPBOARD_CLEAR_MS)
    expect(env.clip.value).toBe('something the user copied')
  })

  it('copying again restarts the timer; lock clears at once', async () => {
    await unlocked()
    await env.call(IpcChannel.copyField, uuidHex(1), 'password')
    await env.timers.advance(20_000)
    await env.call(IpcChannel.copyField, uuidHex(3), 'email')
    await env.timers.advance(20_000)
    expect(env.clip.value).toBe('me@example.com')
    await env.call(IpcChannel.lock)
    expect(env.clip.value).toBe('')
  })

  it('auto-lock and shutdown clear it too', async () => {
    await unlocked()
    await env.call(IpcChannel.copyField, uuidHex(1), 'password')
    await env.controller.autoLock()
    expect(env.clip.value).toBe('')
    expect(env.vault.getState().status).toBe('locked')
    await env.call(IpcChannel.unlock, MASTER)
    await env.call(IpcChannel.copyField, uuidHex(1), 'password')
    await env.controller.shutdown()
    expect(env.clip.value).toBe('')
    expect(env.vault.getState().status).toBe('no-file')
  })
})

describe('auto-lock keeps unsaved changes (§B3)', () => {
  it('changes come back after unlock, still unsaved', async () => {
    await unlocked()
    await env.call(IpcChannel.saveEntry, { uuid: uuidHex(1), username: 'changed' })
    await env.controller.autoLock()
    expect(env.vault.getState()).toMatchObject({ status: 'locked', dirtyCount: 1 })
    await env.call(IpcChannel.unlock, MASTER)
    expect(env.vault.getState()).toMatchObject({ status: 'open', dirtyCount: 1 })
  })

  it('lock with discardChanges drops them', async () => {
    await unlocked()
    await env.call(IpcChannel.saveEntry, { uuid: uuidHex(1), username: 'changed' })
    await env.call(IpcChannel.lock, { discardChanges: true })
    await env.call(IpcChannel.unlock, MASTER)
    expect(env.vault.getState()).toMatchObject({ status: 'open', dirtyCount: 0 })
  })
})

describe('export (§A7)', () => {
  it('cancel → null and nothing written', async () => {
    await unlocked()
    expect(await env.call(IpcChannel.exportXml, { scope: { kind: 'all' } })).toEqual({
      ok: true,
      value: null,
    })
    expect(env.exports.size).toBe(0)
  })

  it('writes the XML to the picked path and reports counts; reveal only for that path', async () => {
    await unlocked()
    // The controller resolves picked paths, which adds a drive letter on Windows.
    const out = resolve('/out/db-export.xml')
    env.dialogs.export = out
    const r = await env.call(IpcChannel.exportXml, { scope: { kind: 'all' } })
    expect(r).toEqual({
      ok: true,
      value: { filePath: out, entryCount: 5, entriesWithOmittedFields: 2 },
    })
    expect(env.exports.get(out)).toContain('<passwordsafe')
    expect(code(await env.call(IpcChannel.revealInFolder, out))).toBe('ok')
    expect(env.revealed).toEqual([out])
    expect(code(await env.call(IpcChannel.revealInFolder, '/etc/hosts'))).toBe(
      ErrorCode.INVALID_ARGUMENT,
    )
    expect(env.revealed).toHaveLength(1)
  })

  it('refuses to write over a .psafe3 file', async () => {
    await unlocked()
    env.dialogs.export = '/v/db.psafe3'
    expect(code(await env.call(IpcChannel.exportXml, { scope: { kind: 'all' } }))).toBe(
      ErrorCode.IO_ERROR,
    )
    expect(env.exports.size).toBe(0)
  })

  it('default name is <db-name>-export-YYYYMMDD.xml', () => {
    expect(defaultExportName('Personal.psafe3', new Date(2026, 0, 5))).toBe(
      'Personal-export-20260105.xml',
    )
  })
})

describe('settings', () => {
  it('persist in the user-data folder and reload', async () => {
    const next = { ...DEFAULT_SETTINGS, idleLockMinutes: 12, lockOnMinimize: true }
    expect(await env.call(IpcChannel.setSettings, next)).toEqual({ ok: true, value: next })
    const again = new SettingsStore(env.dir)
    expect(await again.load()).toEqual(next)
  })
})

describe('§A4.8 IPC spy: passwords cross only in a revealPassword response', () => {
  it('holds over a session that touches every channel', async () => {
    const seen: { channel: string; payload: unknown }[] = []
    const spyCall = async (ch: InvokeChannel, ...args: unknown[]) => {
      const r = await env.call(ch, ...args)
      seen.push({ channel: ch, payload: structuredClone(r) })
      return r
    }
    const NEW_SECRET = 'fresh-secret-from-editor'
    await spyCall(IpcChannel.getState)
    await spyCall(IpcChannel.listRecentFiles)
    await spyCall(IpcChannel.chooseFile)
    await spyCall(IpcChannel.unlock, MASTER)
    await spyCall(IpcChannel.listEntries)
    await spyCall(IpcChannel.listGroups)
    for (const n of [1, 2, 3, 4, 5]) await spyCall(IpcChannel.getEntry, uuidHex(n))
    await spyCall(IpcChannel.revealPassword, uuidHex(1))
    await spyCall(IpcChannel.copyField, uuidHex(2), 'password')
    const added = await spyCall(IpcChannel.saveEntry, { title: 'New', password: NEW_SECRET })
    const uuid = (added as { ok: true; value: { uuid: string } }).value.uuid
    await spyCall(IpcChannel.getEntry, uuid)
    await spyCall(IpcChannel.listEntries)
    await spyCall(IpcChannel.save)
    await spyCall(IpcChannel.listBackups)
    env.dialogs.export = '/out/x.xml'
    await spyCall(IpcChannel.exportXml, { scope: { kind: 'all' } })
    await spyCall(IpcChannel.getSettings)
    await spyCall(IpcChannel.lock)
    await spyCall(IpcChannel.unlock, MASTER)
    await spyCall(IpcChannel.listEntries)
    await spyCall(IpcChannel.closeFile)

    const secrets = [...SECRETS, NEW_SECRET]
    const leaking = seen
      .filter((s) => secrets.some((pw) => JSON.stringify(s.payload).includes(pw)))
      .map((s) => s.channel)
    expect(leaking).toEqual([IpcChannel.revealPassword])
    // And the export went to disk, never to the renderer.
    expect([...env.exports.values()][0]).toContain('bank-secret')
  })
})
