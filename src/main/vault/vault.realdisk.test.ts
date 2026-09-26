// End to end on a real temporary directory: the real file-system layer, real Twofish and the real
// key-stretching worker, on a copy of a pypwsafe test safe (`npm run fixtures:pypwsafe`; skipped
// with a clear message when absent). Runs on every CI OS with the actual platform's lock rules.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/errors'
import { createTwofish } from '../crypto/twofish/twofish'
import { createNodeFileSystem } from '../fs/nodeFs'
import { encodeLocker, type LockPlatform } from '../lockfile/encoding'
import { PYPWSAFE_DIR, PYPWSAFE_PASSWORD, hasPypwsafe } from '../psafe3/testing/fixtures'
import { unwrap } from './testkit'
import { Vault } from './vault'

const platform: LockPlatform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const password = new TextEncoder().encode(PYPWSAFE_PASSWORD)
const identity = { user: userInfo().username, host: hostname(), pid: process.pid }

function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const c = (e as { code?: string }).code
    return c === 'ESRCH' ? false : c === 'EPERM' ? true : undefined
  }
}

const newVault = () =>
  new Vault({
    fs: createNodeFileSystem(),
    platform,
    identity,
    processExists,
    codec: { cipherFactory: createTwofish },
    appName: 'psafe3 Opener test',
  })

if (!hasPypwsafe) {
  console.warn('vault.realdisk.test.ts skipped: run `npm run fixtures:pypwsafe` first')
}

describe.skipIf(!hasPypwsafe)(`real disk end to end (${platform})`, () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'wp6-e2e-'))
    const db = join(dir, 'vault.psafe3')
    copyFileSync(join(PYPWSAFE_DIR, 'simple.psafe3'), db)
    return { dir, db, original: new Uint8Array(readFileSync(db)) }
  }
  const ls = (d: string) => readdirSync(d).sort()

  it.runIf(platform !== 'win32')(
    'open, edit, save, rotate backups, reopen, Save As, preview and restore',
    async () => {
      const { dir, db, original } = setup()
      const v = newVault()
      unwrap(await v.open(db))
      unwrap(await v.unlock(password))
      const plk = join(dir, 'vault.plk')
      const pid = String(process.pid).padStart(8, '0')
      expect(new Uint8Array(readFileSync(plk))).toEqual(
        encodeLocker(`${identity.user}@${identity.host}:${pid}`, platform),
      )
      const entries = unwrap(v.listEntries())
      expect(entries).toHaveLength(9)
      const target = entries.find((e) => e.editable && e.kind === 'normal')!
      const victim = entries.find((e) => e.editable && e.kind === 'normal' && e !== target)!
      unwrap(await v.saveEntry({ uuid: target.uuid, title: 'Edited on a real disk' }))
      const added = unwrap(await v.saveEntry({ title: 'Added', password: 'p@ss', group: 'New' }))
      unwrap(await v.deleteEntry(victim.uuid))
      expect(v.getState().dirtyCount).toBe(3)

      // Save: the original becomes .bak byte for byte; no staged, journal or .new left behind.
      unwrap(await v.save())
      expect(new Uint8Array(readFileSync(`${db}.bak`))).toEqual(original)
      expect(ls(dir)).toEqual(['vault.plk', 'vault.psafe3', 'vault.psafe3.bak'])
      const firstSave = new Uint8Array(readFileSync(db))
      unwrap(await v.close())
      expect(existsSync(plk)).toBe(false)

      // Reopen in a new instance: the edits are there.
      const v2 = newVault()
      unwrap(await v2.open(db))
      unwrap(await v2.unlock(password))
      const after = unwrap(v2.listEntries())
      expect(after).toHaveLength(9)
      expect(unwrap(v2.getEntry(target.uuid)).title).toBe('Edited on a real disk')
      expect(unwrap(v2.revealPassword(added.uuid))).toBe('p@ss')
      expect(after.some((e) => e.uuid === victim.uuid)).toBe(false)

      // Second save rotates: .bak2 is the original.
      unwrap(await v2.save())
      expect(new Uint8Array(readFileSync(`${db}.bak`))).toEqual(firstSave)
      expect(new Uint8Array(readFileSync(`${db}.bak2`))).toEqual(original)

      // Save As to a new path: it becomes the active file; the old lock is released.
      const copy = join(dir, 'copy.psafe3')
      expect(unwrap(await v2.saveAs(copy)).fileName).toBe('copy.psafe3')
      expect(existsSync(join(dir, 'copy.plk'))).toBe(true)
      expect(existsSync(plk)).toBe(false)
      unwrap(await v2.close())

      // Restore the original from .bak2 (preview first, read-only).
      const v3 = newVault()
      unwrap(await v3.open(db))
      unwrap(await v3.unlock(password))
      const backups = unwrap(await v3.listBackups())
      expect(backups.map((b) => b.generation)).toEqual([1, 2])
      const preview = unwrap(await v3.previewBackup(backups[1]!.id, password))
      expect(preview).toHaveLength(9)
      expect(preview.every((e) => !e.editable && e.password === '')).toBe(true)
      const beforeRestore = new Uint8Array(readFileSync(db))
      unwrap(await v3.restoreBackup(backups[1]!.id))
      expect(unwrap(v3.getEntry(target.uuid)).title).toBe(target.title)
      expect(new Uint8Array(readFileSync(`${db}.bak`))).toEqual(beforeRestore)
      expect(new Uint8Array(readFileSync(`${db}.bak3`))).toEqual(original)
      unwrap(await v3.close())
      expect(ls(dir)).toEqual([
        'copy.psafe3',
        'vault.psafe3',
        'vault.psafe3.bak',
        'vault.psafe3.bak2',
        'vault.psafe3.bak3',
      ])
    },
    120_000,
  )

  it.runIf(platform === 'win32')('Windows v1: opens read-only, never locks or writes', async () => {
    const { dir, db, original } = setup()
    const v = newVault()
    unwrap(await v.open(db))
    const state = unwrap(await v.unlock(password))
    expect(state.readOnly?.reason).toBe('windows-v1')
    expect(ls(dir)).toEqual(['vault.psafe3'])
    const r = await v.save()
    expect(r.ok || r.error.code).toBe(ErrorCode.READ_ONLY)
    expect((await v.saveAs(join(dir, 'copy.psafe3'))).ok).toBe(false)
    unwrap(await v.close())
    expect(ls(dir)).toEqual(['vault.psafe3'])
    expect(new Uint8Array(readFileSync(db))).toEqual(original)
  })
})
